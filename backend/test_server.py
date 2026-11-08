"""本地 HTTP 边界测试；仅绑定 127.0.0.1 和使用 .local/test-* 合成数据。"""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from backend.server import instance_identity, make_server


PROJECT = Path(__file__).resolve().parents[1]


class ServerTests(unittest.TestCase):
    def setUp(self):
        local = PROJECT / ".local"
        local.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="test-http-", dir=str(local))
        self.server = None
        self.thread = None
        self.addCleanup(self.cleanup_server)
        self.server = make_server(host="127.0.0.1", port=0,
                                  db_path=Path(self.temp.name) / "margin.sqlite3")
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.authority = "127.0.0.1:" + str(self.port)
        self.origin = "http://" + self.authority
        status, _, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.token = state["csrfToken"]

    def cleanup_server(self):
        if self.server is not None:
            if self.thread is not None and self.thread.is_alive():
                self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=3)
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None, token=False):
        values = {"Host": self.authority}
        if body is not None:
            body = json.dumps(body, ensure_ascii=False).encode("utf-8") if isinstance(body, (dict, list)) else body
            if isinstance(body, str):
                body = body.encode("utf-8")
            values["Content-Type"] = "application/json"
        if token:
            values["X-Margin-Token"] = self.token
        values.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=values)
            response = connection.getresponse()
            raw = response.read()
            response_headers = dict(response.getheaders())
            data = json.loads(raw.decode("utf-8")) if "application/json" in response.getheader("Content-Type", "") else raw
            return response.status, response_headers, data
        finally:
            connection.close()

    def create_request(self, operation_id="http-create", revision=None):
        if revision is None:
            revision = self.request("GET", "/api/state")[2]["revision"]
        return {"operationId": operation_id, "expectedRevision": revision, "action": "create",
                "payload": {"fields": {"title": "HTTP 合成事项", "description": "", "category": "工作"}}}

    def test_state_and_static_entry_are_available(self):
        status, headers, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["state"]["version"], 1)
        self.assertTrue(state["databaseId"])
        self.assertTrue(state["csrfToken"])
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn(b"<html", body.lower())

    def test_health_exposes_only_instance_identity_and_is_read_only(self):
        before = self.server.store.state()
        status, _, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health, {"app": "margin-local", "status": "ok",
                                  "instance": instance_identity(Path(self.temp.name) / "margin.sqlite3")})
        self.assertNotIn(str(self.temp.name), json.dumps(health))
        after = self.server.store.state()
        self.assertEqual(before["state"], after["state"])
        self.assertEqual(before["revision"], after["revision"])
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("HEAD", "/api/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")
            self.assertGreater(int(response.getheader("Content-Length")), 0)
        finally:
            connection.close()

    def test_health_keeps_host_origin_guards_and_rejects_writes(self):
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": "attacker.invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Origin": "https://attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/api/health", {}, token=True)[0], 404)
        self.assertNotEqual(instance_identity(self.server.store.db_path), instance_identity(Path(self.temp.name) / "other.sqlite3"))
        self.assertNotEqual(instance_identity(self.server.store.db_path), instance_identity(self.server.store.db_path, PROJECT / "other-project"))

    def test_authenticated_write_and_exact_retry(self):
        command = self.create_request()
        status, _, first = self.request("POST", "/api/commands", command, token=True)
        self.assertEqual(status, 200)
        status, _, retry = self.request("POST", "/api/commands", command, token=True)
        self.assertEqual(status, 200)
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["result"], first["result"])
        self.assertEqual(retry["revision"], first["revision"])
        self.assertEqual(len(retry["state"]["cards"]), 1)

    def test_conflicts_are_http_409_without_duplicate_card(self):
        command = self.create_request()
        self.assertEqual(self.request("POST", "/api/commands", command, token=True)[0], 200)
        command["payload"]["fields"]["title"] = "不应写入"
        self.assertEqual(self.request("POST", "/api/commands", command, token=True)[0], 409)
        stale = self.create_request(operation_id="stale-http", revision=0)
        self.assertEqual(self.request("POST", "/api/commands", stale, token=True)[0], 409)
        self.assertEqual(len(self.request("GET", "/api/state")[2]["state"]["cards"]), 1)

    def test_missing_or_wrong_token_cannot_write(self):
        command = self.create_request()
        self.assertEqual(self.request("POST", "/api/commands", command)[0], 403)
        self.assertEqual(self.request("POST", "/api/commands", command,
                                      headers={"X-Margin-Token": "synthetic-invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/api/state")[2]["state"]["cards"], [])

    def test_host_validation_blocks_untrusted_hosts(self):
        for host in ("attacker.invalid", "127.0.0.1:1", "127.0.0.1.attacker.invalid:" + str(self.port)):
            with self.subTest(host=host):
                self.assertEqual(self.request("GET", "/api/state", headers={"Host": host})[0], 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "localhost:" + str(self.port)})[0], 200)

    def test_origin_and_fetch_metadata_must_match_local_service(self):
        command = self.create_request()
        for origin in ("https://attacker.invalid", "null", "http://localhost:" + str(self.port)):
            with self.subTest(origin=origin):
                self.assertEqual(self.request("POST", "/api/commands", command,
                                              headers={"Origin": origin}, token=True)[0], 403)
        self.assertEqual(self.request("POST", "/api/commands", command,
                                      headers={"Sec-Fetch-Site": "cross-site"}, token=True)[0], 403)
        self.assertEqual(self.request("POST", "/api/commands", command,
                                      headers={"Origin": self.origin}, token=True)[0], 200)

    def test_private_source_database_and_traversal_paths_are_not_served(self):
        for path in ("/backend/store.py", "/backend/test_store.py", "/.local/margin.sqlite3",
                     "/.git/config", "/model.test.cjs", "/../AGENTS.md", "/%2e%2e/AGENTS.md"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertIn(status, (403, 404))

    def test_bad_json_content_type_and_method_are_rejected(self):
        self.assertEqual(self.request("POST", "/api/commands", b"{", token=True)[0], 400)
        self.assertEqual(self.request("POST", "/api/commands", b"{}",
                                      headers={"Content-Type": "text/plain"}, token=True)[0], 415)
        self.assertEqual(self.request("PUT", "/api/commands", b"{}", token=True)[0], 405)
        self.assertEqual(self.request("GET", "/api/not-a-route")[0], 404)

    def test_nonstandard_or_ambiguous_json_is_rejected_before_mutation(self):
        for body in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}',
                     b'{"x":1e999}', b'{"x":"\\ud800"}', b'[]'):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/api/commands", body, token=True)[0], 400)
        self.assertEqual(self.request("GET", "/api/state")[2]["revision"], 0)

    def test_duplicate_host_missing_length_and_oversized_length_are_rejected(self):
        # Send only synthetic headers; never allocate or upload an oversized body.
        for scenario, expected in (("duplicate-host", 403), ("missing-length", 411), ("oversized", 413)):
            with self.subTest(scenario=scenario):
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
                try:
                    connection.putrequest("POST", "/api/commands", skip_host=True)
                    connection.putheader("Host", self.authority)
                    if scenario == "duplicate-host":
                        connection.putheader("Host", self.authority)
                    connection.putheader("X-Margin-Token", self.token)
                    connection.putheader("Content-Type", "application/json")
                    if scenario == "oversized":
                        connection.putheader("Content-Length", str(8 * 1024 * 1024 + 1))
                    connection.endheaders()
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()

    def test_export_import_preview_and_backup_preview_roundtrip(self):
        self.assertEqual(self.request("POST", "/api/commands", self.create_request(), token=True)[0], 200)
        status, _, data = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertEqual(data["version"], 1)
        self.assertEqual(len(data["cards"]), 1)
        before = self.request("GET", "/api/state")[2]
        status, _, preview = self.request("POST", "/api/import/preview", {"data": data}, token=True)
        self.assertEqual(status, 200)
        self.assertTrue(preview["canImport"])
        status, _, backup = self.request("POST", "/api/backups", {}, token=True)
        self.assertEqual(status, 200)
        status, _, listed = self.request("GET", "/api/backups")
        self.assertEqual(status, 200)
        self.assertIn(backup["id"], [item["id"] for item in listed["backups"]])
        status, _, restore = self.request("POST", "/api/backups/preview", {"backupId": backup["id"]}, token=True)
        self.assertEqual(status, 200)
        self.assertTrue(restore["canRestore"])
        after = self.request("GET", "/api/state")[2]
        self.assertEqual(before["state"], after["state"])
        self.assertEqual(before["revision"], after["revision"])

    def test_factory_refuses_non_loopback_binding(self):
        for host in ("0.0.0.0", "localhost", "::1"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    make_server(host=host, port=0, db_path=Path(self.temp.name) / "not-created.sqlite3")


if __name__ == "__main__":
    unittest.main()
