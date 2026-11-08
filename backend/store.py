"""SQLite persistence for the MARGIN board.

The database is the authority for confirmed state.  Cards keep the version-one
wire format; immutable events and explicit residence intervals retain history.
Animations, browser visibility and display-clock refreshes never write here.
"""

import copy
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
APPLICATION_ID = 0x4D415247
QUADRANTS = ("q1", "q2", "q3", "q4")
ZONES = ("prep",) + QUADRANTS
CATEGORIES = ["个人提升", "工作", "生活", "关系"]
COLORS = {"q1": "#f2c7ba", "q2": "#d9dfbc", "q3": "#d5dfec", "q4": "#e5d8ed"}
CARD_COLORS = ("#fff4d8", "#f4e7dc", "#e9eddf", "#e4eaf1", "#eee4ef")
STICKERS = ("✦", "✳", "✿", "☀", "◈", "♡")
EVENT_TYPES = {"created", "moved", "positioned", "editing", "updated", "completed", "cancelled", "restored"}
BACKUP_ID = re.compile(r"backup-[0-9a-f]{32}\Z")
COLOR = re.compile(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\Z")


class DomainError(Exception):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details


def _dump(value):
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        raw.encode("utf-8")
        return raw
    except (TypeError, ValueError, UnicodeError) as error:
        raise DomainError("数据必须是有限数值组成的有效 JSON。") from error


def _object(value, label):
    if not isinstance(value, dict):
        raise DomainError(label + "必须是对象。")
    return value


def _text(value, label, limit, optional=False):
    if optional and value is None:
        return ""
    if not isinstance(value, str):
        raise DomainError(label + "必须是文字。")
    value = value.strip()
    if not optional and not value:
        raise DomainError(label + "不能为空。")
    if len(value) > limit:
        raise DomainError(label + "最多 " + str(limit) + " 个字符。")
    return value


def _number(value, label, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 9007199254740991 or not math.isfinite(value):
        raise DomainError(label + "必须是非负有限数值。")
    if integer and int(value) != value:
        raise DomainError(label + "超出允许范围。")
    return int(value) if integer else value


def _fields(value):
    value = _object(value, "卡片信息")
    return {
        "title": _text(value.get("title"), "标题", 28),
        "description": _text(value.get("description", ""), "描述", 120, True),
        "category": _text(value.get("category"), "分类", 12),
    }


def _durations(value):
    value = _object(value, "驻留累计")
    if set(value) != set(QUADRANTS):
        raise DomainError("驻留累计必须包含 q1、q2、q3、q4 四项。")
    return {zone: _number(value[zone], "驻留累计") for zone in QUADRANTS}


def _position(value):
    value = _object(value, "坐标")
    result = {axis: _number(value.get(axis), "坐标") for axis in ("x", "y")}
    if any(number > 1 for number in result.values()):
        raise DomainError("坐标必须在 0 到 1 之间。")
    return result


def _appearance(seed=None):
    if seed is None:
        seed = uuid.uuid4().int & 0xFFFFFFFF
    return {
        "color": CARD_COLORS[seed % len(CARD_COLORS)],
        "rotation": (((seed >> 4) % 61) - 30) / 10,
        "sticker": STICKERS[(seed >> 10) % len(STICKERS)],
        "seed": seed,
    }


def _read_appearance(value):
    value = _object(value, "纸面外观")
    seed = _number(value.get("seed"), "外观种子", True)
    if seed > 0xFFFFFFFF or not isinstance(value.get("color"), str) or not COLOR.fullmatch(value["color"]):
        raise DomainError("纸面颜色或种子无效。")
    rotation = value.get("rotation")
    if isinstance(rotation, bool) or not isinstance(rotation, (int, float)) or not -10 <= rotation <= 10 or not math.isfinite(rotation):
        raise DomainError("纸面角度必须在 -10 到 10 之间。")
    sticker = value.get("sticker")
    if not isinstance(sticker, str) or len(sticker) > 8:
        raise DomainError("纸面符号无效。")
    return {"seed": seed, "color": value["color"], "rotation": rotation, "sticker": sticker}


def _settings(value, current=None):
    value = _object(value, "设置")
    result = copy.deepcopy(current or {"motion": "full", "respectSystem": True, "colors": COLORS})
    if set(value) - {"motion", "respectSystem", "colors"}:
        raise DomainError("设置包含未知字段。")
    if "motion" in value:
        if value["motion"] not in ("full", "reduced", "off"):
            raise DomainError("动效强度无效。")
        result["motion"] = value["motion"]
    if "respectSystem" in value:
        if not isinstance(value["respectSystem"], bool):
            raise DomainError("系统动效偏好必须是布尔值。")
        result["respectSystem"] = value["respectSystem"]
    if "colors" in value:
        colors = _object(value["colors"], "象限颜色")
        if set(colors) - set(QUADRANTS):
            raise DomainError("象限颜色包含未知象限。")
        for zone, color in colors.items():
            if not isinstance(color, str) or not COLOR.fullmatch(color):
                raise DomainError("象限颜色无效。")
            result["colors"][zone] = color
    return result


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex


def _utc(milliseconds):
    try:
        return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError) as error:
        raise DomainError("时间超出可导出范围。") from error


class Store:
    def __init__(self, db_path, clock=None):
        self.db_path = Path(db_path).expanduser().resolve()
        self.clock = clock or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        self.backup_dir = self.db_path.parent / "backups"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = self._connect()
        try:
            existing = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if existing:
                self._validate_database(connection)
            else:
                connection.executescript("""
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE cards (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                    CREATE TABLE events (
                        id TEXT PRIMARY KEY,
                        card_id TEXT NOT NULL REFERENCES cards(id),
                        data TEXT NOT NULL
                    );
                    CREATE TABLE residence_baselines (
                        card_id TEXT PRIMARY KEY REFERENCES cards(id), data TEXT NOT NULL
                    );
                    CREATE TABLE residence_intervals (
                        id TEXT PRIMARY KEY,
                        card_id TEXT NOT NULL REFERENCES cards(id),
                        zone TEXT NOT NULL CHECK(zone IN ('q1','q2','q3','q4')),
                        started_at REAL NOT NULL CHECK(started_at >= 0),
                        ended_at REAL CHECK(ended_at IS NULL OR ended_at >= started_at),
                        source TEXT NOT NULL
                    );
                    CREATE UNIQUE INDEX one_open_interval ON residence_intervals(card_id) WHERE ended_at IS NULL;
                    CREATE INDEX intervals_by_card ON residence_intervals(card_id, started_at);
                    CREATE INDEX events_by_card ON events(card_id);
                    CREATE TABLE receipts (
                        operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
                        result TEXT NOT NULL, applied_revision INTEGER NOT NULL
                    );
                    CREATE TABLE import_sources (
                        fingerprint TEXT PRIMARY KEY, data TEXT NOT NULL, imported_at INTEGER NOT NULL
                    );
                """)
                connection.execute("PRAGMA user_version = " + str(SCHEMA_VERSION))
                connection.execute("PRAGMA application_id = " + str(APPLICATION_ID))
                with connection:
                    for key, value in {
                        "revision": 0, "database_id": uuid.uuid4().hex,
                        "categories": CATEGORIES, "settings": _settings({}),
                    }.items():
                        self._set_meta(connection, key, value)
            connection.execute("PRAGMA journal_mode=WAL")
        finally:
            connection.close()

    def _connect(self, path=None, readonly=False):
        path = Path(path or self.db_path)
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10) if readonly else sqlite3.connect(str(path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        if not readonly:
            connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _now(self):
        return _number(self.clock(), "服务器时间", True)

    @staticmethod
    def _meta(connection, key):
        row = connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        if row is None:
            raise DomainError("数据库元信息缺失：" + key, 500)
        return json.loads(row[0])

    @staticmethod
    def _set_meta(connection, key, value):
        connection.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, _dump(value)))

    def _read_state(self, connection):
        return {
            "version": 1,
            "cards": [json.loads(row[0]) for row in connection.execute("SELECT data FROM cards ORDER BY rowid")],
            "events": [json.loads(row[0]) for row in connection.execute("SELECT data FROM events ORDER BY rowid")],
            "categories": self._meta(connection, "categories"),
            "settings": self._meta(connection, "settings"),
        }

    def _response(self, connection, result=None, replayed=False):
        response = {"state": self._read_state(connection), "revision": self._meta(connection, "revision"), "databaseId": self._meta(connection, "database_id"), "serverTime": self._now()}
        if result is not None:
            response.update(result=result, replayed=replayed)
        return response

    def state(self):
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN")
                return self._response(connection)
            finally:
                connection.close()

    @staticmethod
    def _card(state, card_id, active=False):
        card_id = _text(card_id, "卡片标识", 200)
        card = next((item for item in state["cards"] if item["id"] == card_id), None)
        if card is None:
            raise DomainError("找不到这张卡片。", 404)
        if active and card["status"] != "active":
            raise DomainError("请先恢复这张卡片，再进行操作。", 409)
        return card

    @staticmethod
    def _check_action_time(card, now):
        if now < card["updatedAt"]:
            raise DomainError("服务器时间早于卡片最近记录，请先检查系统时钟。", 409)

    @staticmethod
    def _event(state, event_type, card, now, **extra):
        event = {"id": _id("event"), "type": event_type, "cardId": card["id"], "at": now}
        event.update(extra)
        state["events"].append(event)
        return event

    @staticmethod
    def _add_category(state, name):
        name = _text(name, "分类", 12)
        if name not in state["categories"]:
            state["categories"].append(name)
        return name

    @staticmethod
    def _open_interval(connection, card, now, source="live"):
        connection.execute("INSERT INTO residence_intervals(id,card_id,zone,started_at,ended_at,source) VALUES(?,?,?,?,NULL,?)", (_id("interval"), card["id"], card["zone"], now, source))
        card["startedAt"] = now

    @staticmethod
    def _settle(connection, card, now):
        if card["status"] == "active" and card["zone"] in QUADRANTS:
            started = card["startedAt"]
            if now < started:
                raise DomainError("服务器时间早于当前驻留起点，请先检查系统时钟。", 409)
            row = connection.execute("SELECT id,started_at,zone FROM residence_intervals WHERE card_id=? AND ended_at IS NULL", (card["id"],)).fetchone()
            if row is None or row["started_at"] != started or row["zone"] != card["zone"]:
                raise DomainError("驻留区间与卡片不一致，操作已停止。", 500)
            card["durations"][card["zone"]] += now - started
            connection.execute("UPDATE residence_intervals SET ended_at=? WHERE id=?", (now, row["id"]))
        card["startedAt"] = None

    @staticmethod
    def _write_state(connection, state):
        for card in state["cards"]:
            connection.execute("INSERT INTO cards(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (card["id"], _dump(card)))
        for event in state["events"]:
            raw = _dump(event)
            row = connection.execute("SELECT data FROM events WHERE id=?", (event["id"],)).fetchone()
            if row is not None and row[0] != raw:
                raise DomainError("已记录的历史事件不能被覆盖。", 409)
            if row is None:
                connection.execute("INSERT INTO events(id,card_id,data) VALUES(?,?,?)", (event["id"], event["cardId"], raw))
        Store._set_meta(connection, "categories", state["categories"])
        Store._set_meta(connection, "settings", state["settings"])

    def execute(self, request):
        request = _object(request, "请求")
        operation_id = _text(request.get("operationId"), "操作标识", 200)
        expected = _number(request.get("expectedRevision"), "数据版本", True)
        action = _text(request.get("action"), "操作", 40)
        payload = _object(request.get("payload", {}), "操作参数")
        request_hash = hashlib.sha256(_dump(request).encode("utf-8")).hexdigest()
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                database_id = self._meta(connection, "database_id")
                if "databaseId" in request and request["databaseId"] != database_id:
                    raise DomainError("当前数据库已切换，请重新载入后核对未提交操作。", 409)
                receipt = connection.execute("SELECT request_hash,result FROM receipts WHERE operation_id=?", (operation_id,)).fetchone()
                if receipt:
                    if receipt["request_hash"] != request_hash:
                        raise DomainError("同一操作标识不能用于不同请求。", 409)
                    result = self._response(connection, json.loads(receipt["result"]), True)
                    connection.commit()
                    return result
                revision = self._meta(connection, "revision")
                if revision != expected:
                    raise DomainError("数据已被其他窗口更新，请重新载入后再操作。", 409, {"expectedRevision": expected, "currentRevision": revision})
                now = self._now()
                state = self._read_state(connection)
                result = self._apply(connection, state, action, payload, now)
                self._write_state(connection, state)
                self._set_meta(connection, "revision", revision + 1)
                connection.execute("INSERT INTO receipts(operation_id,request_hash,result,applied_revision) VALUES(?,?,?,?)", (operation_id, request_hash, _dump(result), revision + 1))
                response = self._response(connection, result)
                connection.commit()
                return response
            except sqlite3.Error as error:
                connection.rollback()
                raise DomainError("数据库未能完成保存，操作未提交。", 503) from error
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def _apply(self, connection, state, action, payload, now):
        if action == "create":
            values = _fields(payload.get("fields", payload))
            self._add_category(state, values["category"])
            card = dict(values, id=_id("card"), appearance=_appearance(), positions={}, status="active", zone="prep", startedAt=None, durations={zone: 0 for zone in QUADRANTS}, createdAt=now, updatedAt=now, endedAt=None, reason="")
            state["cards"].append(card)
            connection.execute("INSERT INTO cards(id,data) VALUES(?,?)", (card["id"], _dump(card)))
            connection.execute("INSERT INTO residence_baselines(card_id,data) VALUES(?,?)", (card["id"], _dump(card["durations"])))
            self._event(state, "created", card, now, fromZone=None, toZone="prep", fields=copy.deepcopy(values), appearance=copy.deepcopy(card["appearance"]))
            return {"id": card["id"], "card": copy.deepcopy(card)}
        if action in ("place", "move"):
            card = self._card(state, payload.get("id"), True)
            self._check_action_time(card, now)
            zone = payload.get("zone")
            if zone not in (QUADRANTS if action == "place" else ZONES):
                raise DomainError("目标区域无效。")
            position = _position(payload.get("position")) if action == "place" else None
            previous = card["zone"]
            changed = previous != zone
            if changed:
                self._settle(connection, card, now)
                card["zone"] = zone
                if zone in QUADRANTS:
                    self._open_interval(connection, card, now)
            positioned = action == "place" and card["positions"].get(zone) != position
            if action == "place":
                card["positions"][zone] = position
            if changed or positioned:
                card["updatedAt"] = now
                extra = {"fromZone": previous, "toZone": zone}
                if position is not None:
                    extra["position"] = copy.deepcopy(position)
                self._event(state, "moved" if changed else "positioned", card, now, **extra)
            return {"id": card["id"], "card": copy.deepcopy(card)}
        if action == "begin_edit":
            card = self._card(state, payload.get("id"), True)
            self._check_action_time(card, now)
            previous = card["zone"]
            self._settle(connection, card, now)
            card.update(zone="prep", updatedAt=now)
            self._event(state, "editing", card, now, fromZone=previous, toZone="prep")
            return {"id": card["id"], "card": copy.deepcopy(card)}
        if action == "update":
            card = self._card(state, payload.get("id"), True)
            self._check_action_time(card, now)
            changes = _object(payload.get("fields"), "修改内容")
            if set(changes) - {"title", "description", "category"}:
                raise DomainError("只能修改标题、描述与分类。")
            values = _fields(dict(card, **changes))
            before = {key: card[key] for key in values}
            self._add_category(state, values["category"])
            card.update(values, updatedAt=now)
            self._event(state, "updated", card, now, before=before, after=copy.deepcopy(values))
            return {"id": card["id"], "card": copy.deepcopy(card)}
        if action == "finish":
            status = payload.get("status")
            if status not in ("completed", "cancelled"):
                raise DomainError("请选择完成或取消。")
            reason = _text(payload.get("reason", ""), "原因", 120, True)
            card = self._card(state, payload.get("id"), True)
            self._check_action_time(card, now)
            previous = card["zone"]
            self._settle(connection, card, now)
            card.update(status=status, zone=None, startedAt=None, updatedAt=now, endedAt=now, reason=reason)
            event = self._event(state, status, card, now, fromZone=previous, toZone=None, reason=reason, snapshot=copy.deepcopy(card))
            return {"id": card["id"], "card": copy.deepcopy(card), "eventId": event["id"]}
        if action == "restore_card":
            card = self._card(state, payload.get("id"))
            self._check_action_time(card, now)
            if card["status"] == "active":
                raise DomainError("这张卡片已经在看板上。", 409)
            card.update(status="active", zone="prep", startedAt=None, endedAt=None, updatedAt=now, reason="")
            self._event(state, "restored", card, now, fromZone=None, toZone="prep")
            return {"id": card["id"], "card": copy.deepcopy(card)}
        if action == "add_category":
            return {"name": self._add_category(state, payload.get("name"))}
        if action == "settings":
            state["settings"] = _settings(payload.get("settings", payload), state["settings"])
            return {"settings": copy.deepcopy(state["settings"])}
        if action == "arrange":
            positions = payload.get("positions")
            if not isinstance(positions, list):
                raise DomainError("整理位置必须是列表。")
            seen = set()
            for entry in positions:
                entry = _object(entry, "整理位置")
                card = self._card(state, entry.get("id"), True)
                if card["id"] in seen or entry.get("zone") != card["zone"] or card["zone"] not in QUADRANTS:
                    raise DomainError("整理位置只能对每张当前象限内卡片执行一次。")
                seen.add(card["id"])
                _position(entry.get("position"))
            for entry in positions:
                self._apply(connection, state, "place", entry, now)
            return {"count": len(positions)}
        if action == "import":
            return self._import(connection, state, payload.get("data"), now)
        if action == "restore_backup":
            return self._restore(connection, state, payload.get("backupId"))
        raise DomainError("未知操作：" + action)

    @staticmethod
    def _read_card(raw, warnings, label):
        raw = _object(raw, label)
        card_id = _text(raw.get("id"), "卡片标识", 200)
        card = dict(_fields(raw), id=card_id)
        status = raw.get("status")
        zone = raw.get("zone")
        if status not in ("active", "completed", "cancelled"):
            raise DomainError(label + "的状态无效。")
        if status == "active" and zone not in ZONES:
            raise DomainError(label + "的活动位置无效。")
        if status != "active" and zone is not None:
            raise DomainError(label + "已结束但仍占据区域。")
        created = _number(raw.get("createdAt"), "创建时间")
        updated = _number(raw.get("updatedAt"), "更新时间")
        if updated < created:
            raise DomainError(label + "的更新时间早于创建时间。")
        started = raw.get("startedAt")
        ended = raw.get("endedAt")
        if status == "active" and zone in QUADRANTS:
            started = _number(started, "驻留起点")
            if started < created or started > updated:
                raise DomainError(label + "的驻留起点与卡片时间不一致。")
        elif started is not None:
            raise DomainError(label + "不在象限中，但仍有驻留起点。")
        if status == "active":
            if ended is not None:
                raise DomainError(label + "尚未结束但有结束时间。")
        else:
            ended = _number(ended, "结束时间")
            if not created <= ended <= updated:
                raise DomainError(label + "的结束时间无效。")
        positions = _object(raw.get("positions", {}), "象限坐标")
        if set(positions) - set(QUADRANTS):
            raise DomainError(label + "的坐标包含未知象限。")
        if "appearance" in raw:
            appearance = _read_appearance(raw["appearance"])
        else:
            seed = int(hashlib.sha256(card_id.encode("utf-8")).hexdigest()[:8], 16)
            appearance = _appearance(seed)
            warnings.append(label + "缺少外观，导入时生成固定替代外观；原外观未知。")
        card.update(status=status, zone=zone, startedAt=started, endedAt=ended,
                    createdAt=created, updatedAt=updated, durations=_durations(raw.get("durations")),
                    positions={key: _position(value) for key, value in positions.items()},
                    appearance=appearance, reason=_text(raw.get("reason", ""), "原因", 120, True))
        return card

    def _parse_import(self, data):
        _dump(data)
        data = _object(data, "导入文件")
        if type(data.get("version")) is not int or data["version"] != 1:
            raise DomainError("不支持的导入版本；当前仅接受 version: 1。")
        if not isinstance(data.get("cards"), list):
            raise DomainError("导入文件缺少 cards 列表。")
        warnings = []
        cards = []
        by_id = {}
        for raw in data["cards"]:
            card = self._read_card(raw, warnings, "卡片 " + str(raw.get("id", "")) if isinstance(raw, dict) else "卡片")
            if card["id"] in by_id:
                raise DomainError("导入文件含重复卡片标识：" + card["id"])
            cards.append(card)
            by_id[card["id"]] = card
        categories = data.get("categories", [])
        if not isinstance(categories, list):
            raise DomainError("分类必须是列表。")
        categories = list(dict.fromkeys(CATEGORIES + [_text(name, "分类", 12) for name in categories] + [card["category"] for card in cards]))
        events_raw = data.get("events", [])
        if not isinstance(events_raw, list):
            raise DomainError("历史事件必须是列表。")
        if "events" not in data:
            warnings.append("导入文件未提供事件历史；此前具体过程未知，不补造过程。")
        events = []
        event_ids = set()
        for index, raw in enumerate(events_raw):
            raw = _object(raw, "历史事件")
            event = copy.deepcopy(raw)
            if raw.get("type") not in EVENT_TYPES:
                raise DomainError("历史事件类型无效。")
            card_id = _text(raw.get("cardId"), "事件卡片标识", 200)
            if card_id not in by_id:
                raise DomainError("历史事件指向导入文件中不存在的卡片：" + card_id)
            at = _number(raw.get("at"), "事件时间")
            if at < by_id[card_id]["createdAt"]:
                raise DomainError("历史事件早于卡片创建时间。")
            if "id" not in raw:
                event["id"] = "legacy-event-" + hashlib.sha256((_dump(raw) + ":" + str(index)).encode("utf-8")).hexdigest()[:32]
                warnings.append("一条旧事件没有标识，已生成稳定的迁移标识。")
            event_id = _text(event["id"], "事件标识", 200)
            if event_id in event_ids:
                raise DomainError("导入文件含重复事件标识：" + event_id)
            event_ids.add(event_id)
            for key in ("fromZone", "toZone"):
                if key in event and event[key] is not None and event[key] not in ZONES:
                    raise DomainError("历史事件的区域无效。")
            if "reason" in event:
                event["reason"] = _text(event["reason"], "原因", 120, True)
            if "position" in event:
                event["position"] = _position(event["position"])
            for key in ("before", "after", "fields"):
                if key in event:
                    event[key] = _fields(event[key])
            if "appearance" in event:
                event["appearance"] = _read_appearance(event["appearance"])
            if "snapshot" in event:
                snapshot = self._read_card(event["snapshot"], warnings, "历史快照")
                if event["type"] not in ("completed", "cancelled") or snapshot["status"] != event["type"] or snapshot["id"] != card_id or snapshot["endedAt"] != at:
                    raise DomainError("结束快照与事件的卡片、状态或时间不一致。")
                if any(snapshot["durations"][zone] > by_id[card_id]["durations"][zone] for zone in QUADRANTS):
                    raise DomainError("历史快照累计驻留大于当前卡片累计值。")
                event["snapshot"] = snapshot
            elif event["type"] in ("completed", "cancelled"):
                warnings.append("一条旧结束事件缺少快照；保留事件，但无法恢复当时的内容。")
            events.append(event)
        created_ids = {event["cardId"] for event in events if event["type"] == "created"}
        ended_snapshots = {(event["cardId"], event["type"], event["at"]) for event in events if "snapshot" in event}
        if any(card["id"] not in created_ids or (card["status"] != "active" and (card["id"], card["status"], card["endedAt"]) not in ended_snapshots) for card in cards):
            warnings.append("部分卡片缺少创建事件或当前结束快照；这些历史内容视为未知，不补造记录。")
        state = {"version": 1, "cards": cards, "events": events, "categories": categories, "settings": _settings(data.get("settings", {}))}
        records = self._read_residence_records(data.get("residenceRecords"), by_id)
        if data.get("residenceRecords") is None and cards:
            warnings.append("旧累计驻留作为导入基线保留；未提供的历史区间标为未知，不由日志猜测补造。")
        if "residenceStatistics" in data:
            warnings.append("导出时的 residenceStatistics 是派生摘要，不再次计入驻留累计。")
        return state, records, list(dict.fromkeys(warnings))

    @staticmethod
    def _read_residence_records(raw, cards):
        if raw is None:
            return None
        raw = _object(raw, "驻留区间记录")
        baselines = _object(raw.get("baselines"), "驻留基线")
        if set(baselines) != set(cards):
            raise DomainError("驻留基线必须与卡片一一对应。")
        baselines = {card_id: _durations(value) for card_id, value in baselines.items()}
        intervals = raw.get("intervals")
        if not isinstance(intervals, list):
            raise DomainError("驻留区间必须是列表。")
        normalized = []
        ids = set()
        groups = {card_id: [] for card_id in cards}
        for row in intervals:
            row = _object(row, "驻留区间")
            interval_id = _text(row.get("id"), "区间标识", 200)
            card_id = _text(row.get("cardId"), "区间卡片标识", 200)
            zone = row.get("zone")
            if interval_id in ids or card_id not in cards or zone not in QUADRANTS:
                raise DomainError("驻留区间标识、卡片或象限无效。")
            start = _number(row.get("startedAt"), "区间起点")
            end = row.get("endedAt")
            if end is not None:
                end = _number(end, "区间终点")
                if end < start:
                    raise DomainError("驻留区间终点早于起点。")
            if start < cards[card_id]["createdAt"]:
                raise DomainError("驻留区间早于卡片创建。")
            source = _text(row.get("source", "import"), "区间来源", 40)
            value = {"id": interval_id, "cardId": card_id, "zone": zone, "startedAt": start, "endedAt": end, "source": source}
            ids.add(interval_id)
            normalized.append(value)
            groups[card_id].append(value)
        for card_id, group in groups.items():
            card = cards[card_id]
            total = dict(baselines[card_id])
            prior_end = None
            opened = []
            # Zero-duration segments are valid; use ended segments before an open
            # segment at the same timestamp when validating contiguous actions.
            for index, row in enumerate(sorted(group, key=lambda item: (item["startedAt"], item["endedAt"] is None, item["endedAt"] or 0))):
                if index and (prior_end is None or row["startedAt"] < prior_end):
                    raise DomainError("同一卡片的驻留区间重叠。")
                prior_end = row["endedAt"]
                if row["endedAt"] is None:
                    opened.append(row)
                else:
                    total[row["zone"]] += row["endedAt"] - row["startedAt"]
            if any(not math.isclose(total[zone], card["durations"][zone], rel_tol=1e-12, abs_tol=1e-6) for zone in QUADRANTS):
                raise DomainError("驻留基线与区间之和不等于卡片累计值。")
            is_running = card["status"] == "active" and card["zone"] in QUADRANTS
            if is_running:
                if len(opened) != 1 or opened[0]["zone"] != card["zone"] or opened[0]["startedAt"] != card["startedAt"]:
                    raise DomainError("未结束驻留区间与卡片当前状态不一致。")
            elif opened:
                raise DomainError("已暂停或结束的卡片仍有未结束驻留区间。")
        return {"baselines": baselines, "intervals": normalized}

    def _preview_import(self, connection, data):
        result = {"canImport": False, "counts": {"cards": 0, "events": 0, "completed": 0, "cancelled": 0, "newCards": 0, "newEvents": 0, "duplicateCards": 0}, "warnings": [], "errors": [], "alreadyImported": False}
        try:
            fingerprint = hashlib.sha256(_dump(data).encode("utf-8")).hexdigest()
            result["fingerprint"] = fingerprint
            incoming, records, warnings = self._parse_import(data)
            result["warnings"] = warnings
            result["counts"].update(cards=len(incoming["cards"]), events=len(incoming["events"]),
                                    completed=sum(event["type"] == "completed" for event in incoming["events"]),
                                    cancelled=sum(event["type"] == "cancelled" for event in incoming["events"]))
            if connection.execute("SELECT 1 FROM import_sources WHERE fingerprint=?", (fingerprint,)).fetchone():
                result.update(canImport=True, alreadyImported=True)
                result["counts"]["duplicateCards"] = len(incoming["cards"])
                result["warnings"].append("此文件已导入；再次确认不会覆盖后来修改或重复添加记录。")
                return result, incoming, records
            existing = self._read_state(connection)
            by_id = {card["id"]: card for card in existing["cards"]}
            event_ids = {event["id"]: event for event in existing["events"]}
            for card in incoming["cards"]:
                if card["id"] in by_id:
                    result["counts"]["duplicateCards"] += 1
                    if _dump(card) != _dump(by_id[card["id"]]):
                        result["errors"].append("卡片标识已存在且内容不同，不会覆盖：" + card["id"])
                else:
                    result["counts"]["newCards"] += 1
            for event in incoming["events"]:
                if event["id"] in event_ids:
                    if _dump(event) != _dump(event_ids[event["id"]]):
                        result["errors"].append("历史事件标识已存在且内容不同：" + event["id"])
                else:
                    result["counts"]["newEvents"] += 1
            if records is not None:
                existing_records = self._residence_records(connection)
                for card_id in set(by_id) & {card["id"] for card in incoming["cards"]}:
                    incoming_intervals = {row["id"]: row for row in records["intervals"] if row["cardId"] == card_id}
                    current_intervals = {row["id"]: row for row in existing_records["intervals"] if row["cardId"] == card_id}
                    if records["baselines"][card_id] != existing_records["baselines"].get(card_id) or incoming_intervals != current_intervals:
                        result["errors"].append("同一卡片的驻留区间或基线不同，不能静默合并：" + card_id)
                for row in records["intervals"]:
                    found = connection.execute("SELECT card_id FROM residence_intervals WHERE id=?", (row["id"],)).fetchone()
                    if found and found[0] != row["cardId"]:
                        result["errors"].append("驻留区间标识与现有记录冲突：" + row["id"])
            if existing["cards"] and incoming["settings"] != existing["settings"]:
                result["warnings"].append("当前数据库已有卡片，导入将保留当前外观与动效设置。")
            result["canImport"] = not result["errors"]
            return result, incoming, records
        except DomainError as error:
            result["errors"].append(error.message)
            return result, None, None

    def preview_import(self, data):
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN")
                return self._preview_import(connection, data)[0]
            finally:
                connection.close()

    def _import(self, connection, state, data, now):
        preview, incoming, records = self._preview_import(connection, data)
        if not preview["canImport"]:
            raise DomainError("导入未通过校验，未写入任何记录。", 409 if incoming is not None else 400, preview)
        if preview["alreadyImported"]:
            return preview
        empty = not state["cards"]
        existing_ids = {card["id"] for card in state["cards"]}
        new_cards = [card for card in incoming["cards"] if card["id"] not in existing_ids]
        for card in new_cards:
            state["cards"].append(card)
            connection.execute("INSERT INTO cards(id,data) VALUES(?,?)", (card["id"], _dump(card)))
            baseline = records["baselines"][card["id"]] if records is not None else card["durations"]
            connection.execute("INSERT INTO residence_baselines(card_id,data) VALUES(?,?)", (card["id"], _dump(baseline)))
            if records is not None:
                self._insert_intervals(connection, [row for row in records["intervals"] if row["cardId"] == card["id"]])
            elif card["status"] == "active" and card["zone"] in QUADRANTS:
                self._open_interval(connection, card, card["startedAt"], "legacy-open")
        existing_events = {event["id"] for event in state["events"]}
        state["events"].extend(event for event in incoming["events"] if event["id"] not in existing_events)
        for name in incoming["categories"]:
            self._add_category(state, name)
        if empty:
            state["settings"] = incoming["settings"]
        connection.execute("INSERT INTO import_sources(fingerprint,data,imported_at) VALUES(?,?,?)", (preview["fingerprint"], _dump(data), now))
        return preview

    @staticmethod
    def _insert_intervals(connection, intervals):
        for row in intervals:
            connection.execute("INSERT INTO residence_intervals(id,card_id,zone,started_at,ended_at,source) VALUES(?,?,?,?,?,?)", (row["id"], row["cardId"], row["zone"], row["startedAt"], row["endedAt"], row["source"]))

    @staticmethod
    def _residence_records(connection):
        return {
            "baselines": {row["card_id"]: json.loads(row["data"]) for row in connection.execute("SELECT card_id,data FROM residence_baselines ORDER BY rowid")},
            "intervals": [{"id": row["id"], "cardId": row["card_id"], "zone": row["zone"], "startedAt": row["started_at"], "endedAt": row["ended_at"], "source": row["source"]} for row in connection.execute("SELECT * FROM residence_intervals ORDER BY rowid")],
        }

    def export(self):
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN")
                output = self._read_state(connection)
                now = self._now()
                output["exportedAt"] = _utc(now)
                output["server"] = {"schemaVersion": SCHEMA_VERSION, "revision": self._meta(connection, "revision"), "databaseId": self._meta(connection, "database_id"), "serverTime": now}
                output["residenceRecords"] = self._residence_records(connection)
                statistics = []
                for card in output["cards"]:
                    durations = dict(card["durations"])
                    if card["status"] == "active" and card["zone"] in QUADRANTS:
                        durations[card["zone"]] += max(0, now - card["startedAt"])
                    total = sum(durations.values())
                    statistics.append({"id": card["id"], "durations": durations, "total": total, "percentages": {zone: durations[zone] / total * 100 if total else 0 for zone in QUADRANTS}})
                output["residenceStatistics"] = statistics
                return output
            finally:
                connection.close()

    @staticmethod
    def _validate_database(connection, integrity=False):
        if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION or connection.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
            raise DomainError("数据库格式或版本不受支持。")
        required = {
            "meta": {"key", "value"}, "cards": {"id", "data"},
            "events": {"id", "card_id", "data"},
            "residence_baselines": {"card_id", "data"},
            "residence_intervals": {"id", "card_id", "zone", "started_at", "ended_at", "source"},
            "receipts": {"operation_id", "request_hash", "result", "applied_revision"},
            "import_sources": {"fingerprint", "data", "imported_at"},
        }
        for table, columns in required.items():
            found = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
            if found != columns:
                raise DomainError("数据库结构不完整：" + table)
        if integrity:
            rows = connection.execute("PRAGMA integrity_check").fetchall()
            if len(rows) != 1 or rows[0][0] != "ok" or connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise DomainError("备份未通过数据库完整性检查。")

    def _backup_path(self, backup_id):
        if not isinstance(backup_id, str) or not BACKUP_ID.fullmatch(backup_id):
            raise DomainError("备份标识无效。")
        if self.backup_dir.is_symlink():
            raise DomainError("备份目录不能是符号链接。")
        path = self.backup_dir / (backup_id + ".sqlite3")
        if path.is_symlink():
            raise DomainError("不能读取符号链接备份。")
        if not path.is_file():
            raise DomainError("找不到这份备份。", 404)
        if path.resolve().parent != self.backup_dir.resolve():
            raise DomainError("备份路径超出允许范围。")
        return path

    def _load_backup(self, backup_id):
        path = self._backup_path(backup_id)
        connection = None
        try:
            connection = self._connect(path, readonly=True)
            connection.execute("BEGIN")
            self._validate_database(connection, integrity=True)
            if self._meta(connection, "backup_id") != backup_id:
                raise DomainError("备份标识与文件内容不一致。")
            raw = self._read_state(connection)
            for row in connection.execute("SELECT id,data FROM cards"):
                if json.loads(row["data"]).get("id") != row["id"]:
                    raise DomainError("备份中的卡片索引与内容不一致。")
            for row in connection.execute("SELECT id,card_id,data FROM events"):
                event = json.loads(row["data"])
                if event.get("id") != row["id"] or event.get("cardId") != row["card_id"]:
                    raise DomainError("备份中的历史事件索引与内容不一致。")
            raw["residenceRecords"] = self._residence_records(connection)
            state, records, warnings = self._parse_import(raw)
            revision = _number(self._meta(connection, "revision"), "备份版本", True)
            created_at = _number(self._meta(connection, "backup_created_at"), "备份创建时间", True)
            evidence = [dict(row) for row in connection.execute("SELECT fingerprint,data,imported_at FROM import_sources")]
            for item in evidence:
                parsed = json.loads(item["data"])
                if hashlib.sha256(_dump(parsed).encode("utf-8")).hexdigest() != item["fingerprint"]:
                    raise DomainError("备份中的导入证据校验失败。")
            info = {"id": backup_id, "createdAt": created_at, "size": path.stat().st_size, "revision": revision,
                    "reason": self._meta(connection, "backup_reason"), "canRestore": True,
                    "counts": {"cards": len(state["cards"]), "events": len(state["events"])}, "warnings": warnings}
            return info, state, records, evidence
        except DomainError:
            raise
        except (sqlite3.Error, ValueError, TypeError, OSError) as error:
            raise DomainError("备份损坏、不可读或格式无效，当前数据未改变。") from error
        finally:
            if connection is not None:
                connection.close()

    def _create_backup(self, reason="manual"):
        if self.backup_dir.is_symlink():
            raise DomainError("备份目录不能是符号链接。")
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        backup_id = _id("backup")
        destination = self.backup_dir / (backup_id + ".sqlite3")
        temporary = self.backup_dir / (backup_id + ".sqlite3.tmp")
        source = target = None
        try:
            source = self._connect(readonly=True)
            source.execute("BEGIN")
            revision = self._meta(source, "revision")
            now = self._now()
            target = sqlite3.connect(str(temporary))
            source.backup(target)
            with target:
                self._set_meta(target, "backup_id", backup_id)
                self._set_meta(target, "backup_created_at", now)
                self._set_meta(target, "backup_reason", reason)
            target.execute("PRAGMA journal_mode=DELETE")
            self._validate_database(target, integrity=True)
            target.close()
            target = None
            temporary.replace(destination)
            return {"id": backup_id, "createdAt": now, "size": destination.stat().st_size, "revision": revision, "reason": reason}
        except (sqlite3.Error, OSError) as error:
            raise DomainError("备份未能完成，当前数据未改变。", 503) from error
        finally:
            if source is not None:
                source.close()
            if target is not None:
                target.close()
            if temporary.exists():
                temporary.unlink()

    def create_backup(self):
        with self._lock:
            return self._create_backup()

    def list_backups(self):
        with self._lock:
            if not self.backup_dir.exists():
                return []
            if self.backup_dir.is_symlink():
                raise DomainError("备份目录不能是符号链接。")
            output = []
            for path in self.backup_dir.glob("backup-*.sqlite3"):
                if not BACKUP_ID.fullmatch(path.stem):
                    continue
                try:
                    info = self._load_backup(path.stem)[0]
                    output.append(info)
                except DomainError as error:
                    output.append({"id": path.stem, "createdAt": None, "size": path.stat().st_size if path.is_file() else 0, "canRestore": False, "error": error.message})
            return sorted(output, key=lambda item: item["createdAt"] or 0, reverse=True)

    def preview_restore(self, backup_id):
        with self._lock:
            return self._load_backup(backup_id)[0]

    def _restore(self, connection, state, backup_id):
        info, recovered, records, evidence = self._load_backup(backup_id)
        safety = self._create_backup("before-restore")
        # The current database identity, revision, and receipts are intentionally
        # retained.  Replaying a prior restore can never overwrite later work.
        for table in ("residence_intervals", "residence_baselines", "events", "cards", "import_sources"):
            connection.execute("DELETE FROM " + table)
        state.clear()
        state.update(recovered)
        self._write_state(connection, state)
        for card_id, durations in records["baselines"].items():
            connection.execute("INSERT INTO residence_baselines(card_id,data) VALUES(?,?)", (card_id, _dump(durations)))
        self._insert_intervals(connection, records["intervals"])
        for item in evidence:
            connection.execute("INSERT INTO import_sources(fingerprint,data,imported_at) VALUES(?,?,?)", (item["fingerprint"], item["data"], item["imported_at"]))
        return {"backupId": backup_id, "safetyBackupId": safety["id"], "counts": info["counts"]}
