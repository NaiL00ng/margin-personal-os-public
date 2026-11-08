"""仅供本机个人使用的标准库 HTTP 入口，不适合作为公网服务。"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .store import DomainError, Store


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = ROOT / ".local" / "margin.sqlite3"
MAX_BODY_BYTES = 8 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 10
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/model.js": ("model.js", "text/javascript; charset=utf-8"),
    "/effects.js": ("effects.js", "text/javascript; charset=utf-8"),
    "/storage.js": ("storage.js", "text/javascript; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
POST_ROUTES = frozenset((
    "/api/commands", "/api/import/preview", "/api/backups", "/api/backups/preview",
))


def instance_identity(db_path=None, project_root=None):
    """Identify a project/database pair without exposing either filesystem path."""
    project = Path(project_root if project_root is not None else ROOT).expanduser().resolve()
    database = Path(db_path if db_path is not None else DEFAULT_DB_PATH).expanduser().resolve()
    identity = json.dumps([str(project), str(database)], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class HTTPProblem(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number")
    return number


def _bounded_int(value):
    if len(value) > 128:
        raise ValueError("JSON integer too long")
    return int(value)


def _invalid_constant(_value):
    raise ValueError("Non-standard JSON constant")


class MarginHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(REQUEST_TIMEOUT_SECONDS)
        return connection, address

    def handle_error(self, request, client_address):
        # Do not print tracebacks, request bodies, tokens, or private query strings.
        print("本机请求处理失败；未记录请求内容。", file=sys.stderr)


class MarginHandler(BaseHTTPRequestHandler):
    server_version = "MarginLocal/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Local operations may contain private titles or imported data.
        pass

    def _header(self, name, required=False):
        values = self.headers.get_all(name, [])
        if len(values) > 1 or (required and not values):
            raise HTTPProblem(400, "invalid_headers", "请求头缺失或重复。")
        return values[0].strip() if values else None

    def _guard(self, write=False):
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_address[1]
        allowed = {"127.0.0.1:" + str(port), "localhost:" + str(port)}
        if port == 80:
            allowed.update(("127.0.0.1", "localhost"))
        if len(hosts) != 1 or hosts[0].strip().lower() not in allowed:
            raise HTTPProblem(403, "invalid_host", "只接受当前本机地址的请求。")
        host = hosts[0].strip().lower()
        origin = self._header("Origin")
        if origin is not None and origin != "http://" + host:
            raise HTTPProblem(403, "invalid_origin", "请求来源与本机服务不一致。")
        if self._header("Sec-Fetch-Site") == "cross-site":
            raise HTTPProblem(403, "cross_site_request", "不接受跨站请求。")
        if write:
            token = self._header("X-Margin-Token") or ""
            if not secrets.compare_digest(token.encode("utf-8"), self.server.csrf_token.encode("ascii")):
                raise HTTPProblem(403, "invalid_token", "本机会话令牌无效，请刷新页面后重试。")
        # Only origin-form paths are accepted; never use the URL as a file path.
        if not self.path.startswith("/") or self.path.startswith("//"):
            raise HTTPProblem(400, "invalid_path", "请求路径无效。")
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            raise HTTPProblem(400, "invalid_path", "请求路径无效。") from None
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise HTTPProblem(400, "invalid_path", "请求路径无效。")
        return parsed.path

    def _read_json(self, allow_empty=False):
        if self._header("Transfer-Encoding") is not None:
            raise HTTPProblem(400, "unsupported_transfer", "不接受分块请求。")
        encoding = self._header("Content-Encoding")
        if encoding not in (None, "identity"):
            raise HTTPProblem(415, "unsupported_encoding", "请求正文必须是未压缩的 UTF-8 JSON。")
        raw_length = self._header("Content-Length")
        if raw_length is None:
            if allow_empty:
                return {}
            raise HTTPProblem(411, "length_required", "请求需要 Content-Length。")
        if not re.fullmatch(r"[0-9]{1,12}", raw_length):
            raise HTTPProblem(400, "invalid_length", "请求正文长度无效。")
        length = int(raw_length)
        if length > MAX_BODY_BYTES:
            raise HTTPProblem(413, "payload_too_large", "请求正文不能超过 8 MiB。")
        if length == 0 and allow_empty:
            return {}
        content_type = self._header("Content-Type") or ""
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise HTTPProblem(415, "unsupported_media_type", "请求正文必须使用 application/json。")
        charset = self.headers.get_content_charset()
        if charset is not None and charset.lower() not in ("utf-8", "utf8"):
            raise HTTPProblem(415, "unsupported_charset", "请求正文必须使用 UTF-8。")
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        chunks = []
        remaining = length
        try:
            while remaining:
                seconds = deadline - time.monotonic()
                if seconds <= 0:
                    raise socket.timeout()
                self.connection.settimeout(seconds)
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    raise HTTPProblem(400, "incomplete_body", "请求正文不完整。")
                chunks.append(chunk)
                remaining -= len(chunk)
        finally:
            self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
        try:
            data = json.loads(
                b"".join(chunks).decode("utf-8"),
                object_pairs_hook=_unique_object,
                parse_float=_finite_float,
                parse_int=_bounded_int,
                parse_constant=_invalid_constant,
            )
            if not isinstance(data, dict):
                raise ValueError("JSON body must be an object")
            stack = [(data, 0)]
            while stack:
                value, depth = stack.pop()
                if depth > 64:
                    raise ValueError("JSON nesting too deep")
                if isinstance(value, dict):
                    for key in value:
                        key.encode("utf-8")
                    stack.extend((child, depth + 1) for child in value.values())
                elif isinstance(value, list):
                    stack.extend((child, depth + 1) for child in value)
                elif isinstance(value, str):
                    value.encode("utf-8")
            return data
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPProblem(400, "invalid_json", "请求必须是有效的 UTF-8 JSON 对象，且不能含重复字段或非有限数值。") from None

    def _send_bytes(self, status, content, content_type):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Connection", "close")
        if status == 405:
            self.send_header("Allow", "GET, HEAD, POST")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _json(self, status, data):
        content = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, content, "application/json; charset=utf-8")

    def _error(self, status, code, message, details=None):
        self._json(status, {"error": code, "message": message, "code": code, "status": status,
                            "details": details if details is not None else {}})

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler also uses this for malformed HTTP requests.
        self._error(code, "http_error", "HTTP 请求无效或不受支持。")

    def _get(self, path):
        store = self.server.store
        if path == "/api/health":
            return self._json(200, {"app": "margin-local", "instance": self.server.instance_id, "status": "ok"})
        if path == "/api/state":
            result = dict(store.state())
            result["csrfToken"] = self.server.csrf_token
            return self._json(200, result)
        if path == "/api/export":
            return self._json(200, store.export())
        if path == "/api/backups":
            return self._json(200, {"backups": store.list_backups()})
        asset = STATIC_FILES.get(path)
        if asset is None:
            raise HTTPProblem(404, "not_found", "资源不存在。")
        filename, content_type = asset
        file_path = ROOT / filename
        # Even an allowlisted name must not be a symlink to private files.
        if file_path.is_symlink() or file_path.resolve().parent != ROOT:
            raise HTTPProblem(404, "not_found", "资源不存在。")
        try:
            content = file_path.read_bytes()
        except FileNotFoundError:
            raise HTTPProblem(404, "not_found", "资源不存在。") from None
        if filename == "index.html":
            marker = b'<meta name="margin-backend" content="sqlite">'
            content = content.replace(b"<head>", b"<head>\n  " + marker, 1)
        self._send_bytes(200, content, content_type)

    def _post(self, path):
        if path not in POST_ROUTES:
            raise HTTPProblem(404, "not_found", "接口不存在。")
        data = self._read_json(allow_empty=path == "/api/backups")
        store = self.server.store
        if path == "/api/commands":
            result = store.execute(data)
        elif path == "/api/import/preview":
            if set(data) != {"data"}:
                raise HTTPProblem(400, "invalid_request", "导入预览需要 data 字段。")
            result = store.preview_import(data["data"])
        elif path == "/api/backups/preview":
            if set(data) != {"backupId"} or not isinstance(data["backupId"], str):
                raise HTTPProblem(400, "invalid_request", "恢复预览需要 backupId 字符串。")
            result = store.preview_restore(data["backupId"])
        else:
            if data:
                raise HTTPProblem(400, "invalid_request", "创建备份不接受额外字段。")
            result = store.create_backup()
        self._json(200, result)

    def _dispatch(self):
        try:
            path = self._guard(write=self.command == "POST")
            if self.command in ("GET", "HEAD"):
                self._get(path)
            elif self.command == "POST":
                self._post(path)
            else:
                raise HTTPProblem(405, "method_not_allowed", "不支持此请求方法。")
        except HTTPProblem as error:
            self._error(error.status, error.code, error.message)
        except DomainError as error:
            status = error.status if isinstance(error.status, int) and 400 <= error.status <= 599 else 500
            code = "conflict" if status == 409 else "domain_error"
            self._error(status, code, error.message, error.details)
        except (socket.timeout, TimeoutError):
            self._error(408, "request_timeout", "请求超时，请重试。")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self._error(500, "internal_error", "本机服务暂时无法处理请求，请重试。")

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch
    do_OPTIONS = _dispatch
    do_TRACE = _dispatch
    do_CONNECT = _dispatch


def make_server(host="127.0.0.1", port=0, db_path=None):
    """创建未启动的本机服务；测试可使用 port=0 和独立临时数据库。"""
    if host != "127.0.0.1":
        raise ValueError("Only the literal loopback address 127.0.0.1 is allowed")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("Port must be an integer between 0 and 65535")
    server = MarginHTTPServer((host, port), MarginHandler)
    try:
        server.csrf_token = secrets.token_urlsafe(32)
        server.store = Store(Path(db_path) if db_path is not None else DEFAULT_DB_PATH)
        server.instance_id = instance_identity(server.store.db_path)
    except Exception:
        server.server_close()
        raise
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="余白本机服务：仅绑定 127.0.0.1，不适合公网部署。")
    parser.add_argument("--port", type=int, default=4317, help="本机端口，默认 4317")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite 数据库路径，默认 .local/margin.sqlite3")
    args = parser.parse_args(argv)
    try:
        server = make_server(port=args.port, db_path=args.db)
    except Exception:
        print("无法启动本机服务，请检查端口、数据库路径及文件权限。", file=sys.stderr)
        return 1
    print("Local: http://127.0.0.1:" + str(server.server_address[1]))
    print("仅供本机个人使用；不是公网服务。按 Ctrl+C 停止。")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
