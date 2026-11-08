"""GUI-launcher lifecycle helper; all communication is local to 127.0.0.1.

Startup writes exactly one JSON line to stdout.  A ``started`` helper owns its
HTTP server and remains alive until SIGTERM/SIGINT; a ``reused`` helper owns no
server and exits immediately.  No subprocess server, PID file, or browser is
created here.  A subsequent runtime failure emits an error line and exits 1.
"""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import sys
import threading
import time

from backend.server import DEFAULT_DB_PATH, ROOT, instance_identity, make_server
from backend.store import DomainError


LOCK_TIMEOUT = 8.0
PROBE_TIMEOUT = 1.0
START_TIMEOUT = 4.0


class LauncherError(Exception):
    pass


class LauncherArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise LauncherError("启动参数无效；端口须为 1 到 65535 的整数，数据库路径须可用。")


def emit(status, message, url=None):
    output = {"status": status, "message": message}
    if url is not None:
        output["url"] = url
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")), flush=True)


def probe_service(port, expected_instance):
    """True means the precise desired instance; False means connection refused.

    Any other listener, malformed response, timeout, or unavailable service is
    an error.  A refused connection is the only condition that permits binding.
    http.client deliberately avoids proxy configuration and redirects.
    """
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=PROBE_TIMEOUT)
    try:
        connection.request("GET", "/api/health", headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise LauncherError("该端口已被其他服务占用，未打开页面或更改数据库。")
        try:
            health = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise LauncherError("该端口的服务无法识别，未打开页面或更改数据库。") from None
        if not isinstance(health, dict) or health.get("app") != "margin-local":
            raise LauncherError("该端口已被其他服务占用，未打开页面或更改数据库。")
        if health.get("instance") != expected_instance:
            raise LauncherError("该端口正在运行另一项目或另一数据库，请先关闭对应服务。")
        if health.get("status") != "ok":
            raise LauncherError("现有余白服务状态异常，请先关闭该服务后重新启动。")
        return True
    except ConnectionRefusedError:
        return False
    except (socket.timeout, TimeoutError):
        raise LauncherError("本机端口有服务但未正常响应；未另启服务，请稍后重试。") from None
    except (http.client.HTTPException, OSError):
        raise LauncherError("无法确认该端口的服务身份；未打开页面或更改数据库。") from None
    finally:
        connection.close()


@contextmanager
def startup_lock(port, stop_event, timeout=LOCK_TIMEOUT):
    directory = ROOT / ".local"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("launcher-" + str(port) + ".lock")
    if path.is_symlink():
        raise LauncherError("启动锁文件不应是符号链接，请检查本地项目目录。")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(str(path), flags, 0o600)
    acquired = False
    try:
        deadline = time.monotonic() + timeout
        while not acquired:
            if stop_event.is_set():
                raise LauncherError("启动已取消。")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise LauncherError("另一启动操作尚未完成，请稍后重新打开余白。") from None
                stop_event.wait(min(0.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)
        # Do not unlink a lock still addressable by another launcher's fd.


def run(port, db_path, stop_event):
    expected_instance = instance_identity(db_path)
    url = "http://127.0.0.1:" + str(port)
    server = None
    thread = None
    failed = threading.Event()
    try:
        with startup_lock(port, stop_event):
            if probe_service(port, expected_instance):
                emit("reused", "已连接当前项目的本机服务。", url)
                return 0
            if stop_event.is_set():
                raise LauncherError("启动已取消。")
            try:
                server = make_server(port=port, db_path=db_path)
            except OSError as error:
                if error.errno == errno.EADDRINUSE:
                    raise LauncherError("端口已被占用，未另选端口或更改现有服务。") from None
                if isinstance(error, PermissionError):
                    raise LauncherError("无法读写本地数据库目录，请检查文件权限。") from None
                raise LauncherError("无法启动本机服务，请检查端口与数据库路径。") from None
            # Wait for accepted requests to finish during shutdown. Confirmed
            # writes were already committed transactionally by Store.execute.
            server.daemon_threads = False

            def serve():
                try:
                    server.serve_forever(poll_interval=0.1)
                except Exception:
                    failed.set()

            thread = threading.Thread(target=serve, name="margin-local-http", daemon=True)
            thread.start()
            deadline = time.monotonic() + START_TIMEOUT
            while True:
                if failed.is_set() or not thread.is_alive():
                    raise LauncherError("本机服务启动后异常停止，请重新打开余白。")
                if stop_event.is_set():
                    raise LauncherError("启动已取消。")
                if probe_service(port, expected_instance):
                    break
                if time.monotonic() >= deadline:
                    raise LauncherError("本机服务未能就绪，请重新打开余白。")
                stop_event.wait(0.05)
            emit("started", "本机服务已启动，记录保存在当前项目的数据库中。", url)
        while not stop_event.wait(0.1):
            if failed.is_set() or not thread.is_alive():
                raise LauncherError("本机服务已异常停止，请重新打开余白。")
        return 0
    finally:
        if server is not None:
            if thread is not None and thread.is_alive():
                server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)


def main(argv=None):
    parser = LauncherArgumentParser(description="余白图形启动器的本机服务辅助进程。")
    parser.add_argument("--port", type=int, default=4317)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    stop_event = threading.Event()
    previous_handlers = {}
    try:
        args = parser.parse_args(argv)
        if not 1 <= args.port <= 65535:
            raise LauncherError("端口须为 1 到 65535 的整数。")
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, lambda _number, _frame: stop_event.set())
        return run(args.port, args.db.expanduser().resolve(), stop_event)
    except LauncherError as error:
        emit("error", str(error))
        return 1
    except DomainError:
        emit("error", "本地数据库格式或版本无法使用，请检查数据库或从可用备份恢复。")
        return 1
    except (sqlite3.Error, PermissionError):
        emit("error", "本地数据库无法读取或保存，请检查数据库文件及目录权限。")
        return 1
    except Exception:
        emit("error", "无法启动余白本机服务，请检查 Python 与本地项目文件是否可用。")
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
