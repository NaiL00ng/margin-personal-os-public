"""Launcher lifecycle checks using synthetic databases under this project's .local.

The only network connections are to ephemeral ports on 127.0.0.1. Tests create
and stop only their own helper processes/listeners and clean their own fixtures.
"""

from contextlib import redirect_stdout
import fcntl
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import launcher


PROJECT = Path(__file__).resolve().parent


class LauncherTests(unittest.TestCase):
    def setUp(self):
        local = PROJECT / ".local"
        local.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="test-launcher-", dir=str(local))
        self.directory = Path(self.temp.name)
        self.db = self.directory / "margin.sqlite3"
        self.processes = []
        self.listeners = []
        self.owned_locks = set()
        self.addCleanup(self.cleanup_resources)

    def cleanup_resources(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        for server, thread in self.listeners:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        # All test helpers have stopped before removing test-created lock files.
        for path in self.owned_locks:
            if path.is_file() and not path.is_symlink():
                path.unlink()
        self.temp.cleanup()

    def free_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.track_lock(port)
        return port

    def track_lock(self, port):
        path = PROJECT / ".local" / ("launcher-" + str(port) + ".lock")
        if not path.exists():
            self.owned_locks.add(path)

    def start(self, port, db=None):
        process = subprocess.Popen([sys.executable, "-B", str(PROJECT / "launcher.py"), "--port", str(port), "--db", str(db or self.db)],
                                   cwd=str(PROJECT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8")
        self.processes.append(process)
        return process

    def read_message(self, process, timeout=6):
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout), "启动器未在限定时间输出状态")
        line = process.stdout.readline()
        self.assertTrue(line, "启动器未输出 JSON 状态")
        value = json.loads(line)
        self.assertIn(value["status"], ("started", "reused", "error"))
        return value

    def request(self, port, method, path, body=None, token=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        headers = {}
        if body is not None:
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["X-Margin-Token"] = token
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            data = json.loads(response.read())
            self.assertEqual(response.status, 200)
            return data
        finally:
            connection.close()

    def stop(self, process, signum=signal.SIGTERM):
        process.send_signal(signum)
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertNotIn("Traceback", process.stderr.read())

    def fake_service(self, payload, content_type="application/json"):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                content = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.listeners.append((server, thread))
        port = server.server_address[1]
        self.track_lock(port)
        return port

    def test_start_graceful_exit_and_restart_preserve_confirmed_record(self):
        port = self.free_port()
        first = self.start(port)
        message = self.read_message(first)
        self.assertEqual(message["status"], "started")
        self.assertEqual(message["url"], "http://127.0.0.1:" + str(port))
        state = self.request(port, "GET", "/api/state")
        command = {"operationId": "launcher-persistence", "expectedRevision": state["revision"],
                   "databaseId": state["databaseId"], "action": "create",
                   "payload": {"fields": {"title": "启动器合成事项", "description": "", "category": "工作"}}}
        created = self.request(port, "POST", "/api/commands", command, state["csrfToken"])
        self.stop(first)
        self.assertFalse(launcher.probe_service(port, launcher.instance_identity(self.db)))
        second = self.start(port)
        self.assertEqual(self.read_message(second)["status"], "started")
        restored = self.request(port, "GET", "/api/state")
        self.assertEqual(restored["state"], created["state"])
        self.assertEqual(restored["databaseId"], created["databaseId"])
        self.stop(second, signal.SIGINT)
        self.assertFalse(launcher.probe_service(port, launcher.instance_identity(self.db)))

    def test_concurrent_helpers_start_once_and_reuse_without_owning_server(self):
        port = self.free_port()
        processes = [self.start(port) for _ in range(3)]
        messages = [self.read_message(process) for process in processes]
        self.assertEqual(sorted(message["status"] for message in messages), ["reused", "reused", "started"])
        for process, message in zip(processes, messages):
            if message["status"] == "reused":
                self.assertEqual(process.wait(timeout=3), 0)
                self.assertNotIn("Traceback", process.stderr.read())
            else:
                self.assertIsNone(process.poll())
        self.assertTrue(launcher.probe_service(port, launcher.instance_identity(self.db)))
        self.assertEqual(self.request(port, "GET", "/api/state")["revision"], 0)

    def test_existing_other_database_is_refused_without_creating_requested_database(self):
        port = self.free_port()
        owner = self.start(port)
        self.assertEqual(self.read_message(owner)["status"], "started")
        before = self.request(port, "GET", "/api/state")
        other_db = self.directory / "must-not-create.sqlite3"
        refused = self.start(port, other_db)
        message = self.read_message(refused)
        self.assertEqual(message["status"], "error")
        self.assertNotIn("url", message)
        self.assertEqual(refused.wait(timeout=3), 1)
        self.assertFalse(other_db.exists())
        after = self.request(port, "GET", "/api/state")
        self.assertEqual(before["state"], after["state"])
        self.assertEqual(before["revision"], after["revision"])
        self.assertIsNone(owner.poll())

    def test_foreign_and_malformed_services_are_not_reused_or_modified(self):
        for payload in ({"app": "other-app", "status": "ok"}, b"not-json"):
            with self.subTest(payload=payload):
                port = self.fake_service(payload)
                process = self.start(port)
                message = self.read_message(process)
                self.assertEqual(message["status"], "error")
                self.assertNotIn("url", message)
                self.assertEqual(process.wait(timeout=3), 1)
                self.assertFalse(self.db.exists())
                self.assertNotIn("Traceback", process.stderr.read())
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    pass

    def test_startup_lock_wait_is_bounded_and_does_not_launch_service(self):
        port = self.free_port()
        lock_path = PROJECT / ".local" / ("launcher-" + str(port) + ".lock")
        descriptor = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with self.assertRaises(launcher.LauncherError):
                with launcher.startup_lock(port, threading.Event(), timeout=0.12):
                    self.fail("不应获得正在被占用的启动锁")
            self.assertLess(time.monotonic() - started, 1)
            self.assertFalse(self.db.exists())
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def test_service_failure_returns_safe_json_and_closes_own_server(self):
        class BrokenServer:
            closed = False

            def serve_forever(self, **_kwargs):
                raise RuntimeError("synthetic private detail must not leak")

            def shutdown(self):
                pass

            def server_close(self):
                self.closed = True

        port = self.free_port()
        fake = BrokenServer()
        output = io.StringIO()
        with patch.object(launcher, "make_server", return_value=fake), patch.object(launcher, "probe_service", return_value=False), redirect_stdout(output):
            code = launcher.main(["--port", str(port), "--db", str(self.db)])
        self.assertEqual(code, 1)
        message = json.loads(output.getvalue())
        self.assertEqual(message["status"], "error")
        self.assertNotIn("synthetic private", output.getvalue())
        self.assertTrue(fake.closed)
        self.assertFalse(self.db.exists())


if __name__ == "__main__":
    unittest.main()
