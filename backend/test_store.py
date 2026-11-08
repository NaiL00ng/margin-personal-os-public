"""SQLite 领域测试；仅在项目 .local/test-* 中创建并清理合成数据。"""

import copy
import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from backend.store import DomainError, Store


PROJECT = Path(__file__).resolve().parents[1]
FIELDS = {"title": "合成研究事项", "description": "测试数据，不包含个人记录。", "category": "工作"}


class Clock:
    def __init__(self, now=1000):
        self.now = now

    def __call__(self):
        return self.now


def legacy_data():
    """构造原 version 1 格式，刻意不含新版 positions。"""
    visual = {"color": "#fff4d8", "rotation": 1.2, "sticker": "✦", "seed": 7}
    active = dict(FIELDS, id="legacy-active", appearance=visual, status="active", zone="q1",
                  startedAt=300, durations={"q1": 200, "q2": 0, "q3": 0, "q4": 0},
                  createdAt=0, updatedAt=300, endedAt=None, reason="")
    ended = dict(FIELDS, id="legacy-ended", title="合成历史事项", appearance=copy.deepcopy(visual),
                 status="completed", zone=None, startedAt=None,
                 durations={"q1": 0, "q2": 100, "q3": 0, "q4": 0},
                 createdAt=0, updatedAt=400, endedAt=400, reason="")
    return {
        "version": 1,
        "cards": [active, ended],
        "categories": ["个人提升", "工作", "生活", "关系"],
        "settings": {"motion": "off", "respectSystem": False,
                     "colors": {"q1": "#f2c7ba", "q2": "#d9dfbc", "q3": "#d5dfec", "q4": "#e5d8ed"}},
        "events": [{"id": "legacy-finish", "type": "completed", "cardId": ended["id"],
                    "at": 400, "fromZone": "q2", "toZone": None, "reason": "",
                    "snapshot": copy.deepcopy(ended)}],
        "exportedAt": 9999,
        "residenceStatistics": {"legacy-active": {"total": 999999999}},
        "derivedStats": {"legacy-active": {"q1": 999999999}},
    }


class StoreTests(unittest.TestCase):
    def setUp(self):
        local = PROJECT / ".local"
        local.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="test-store-", dir=str(local))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.db_path = self.directory / "margin.sqlite3"
        self.clock = Clock()
        self.store = Store(self.db_path, clock=self.clock)
        self.sequence = 0

    def request(self, action, payload, operation_id=None, revision=None):
        self.sequence += 1
        return {"operationId": operation_id or "test-op-" + str(self.sequence),
                "expectedRevision": self.store.state()["revision"] if revision is None else revision,
                "action": action, "payload": payload}

    def command(self, action, payload, **kwargs):
        return self.store.execute(self.request(action, payload, **kwargs))

    def create(self, **fields):
        response = self.command("create", {"fields": dict(FIELDS, **fields)})
        return response["state"]["cards"][-1]

    def card(self, card_id):
        return next(card for card in self.store.state()["state"]["cards"] if card["id"] == card_id)

    def unchanged_after_rejection(self, request, status=None):
        before = self.store.state()
        with self.assertRaises(DomainError) as caught:
            self.store.execute(request)
        if status is not None:
            self.assertEqual(caught.exception.status, status)
        self.assertEqual(self.store.state(), before)
        return caught.exception

    def backup_path(self, backup_id):
        matches = list(self.directory.rglob(backup_id + ".sqlite3"))
        self.assertEqual(len(matches), 1, "备份应留在本测试自己的临时目录中")
        return matches[0]

    def test_residence_across_quadrants_and_prep(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        self.clock.now = 4000
        self.command("move", {"id": card["id"], "zone": "q2"})
        self.clock.now = 5000
        self.command("move", {"id": card["id"], "zone": "prep"})
        self.clock.now = 9000
        stored = self.card(card["id"])
        self.assertEqual(stored["durations"], {"q1": 3000, "q2": 1000, "q3": 0, "q4": 0})
        self.assertIsNone(stored["startedAt"])

    def test_same_quadrant_position_preserves_unsettled_clock(self):
        card = self.create()
        self.command("place", {"id": card["id"], "zone": "q1", "position": {"x": 0.1, "y": 0.2}})
        self.clock.now = 3000
        self.command("place", {"id": card["id"], "zone": "q1", "position": {"x": 0.8, "y": 0.9}})
        stored = self.card(card["id"])
        self.assertEqual(stored["startedAt"], 1000)
        self.assertEqual(stored["durations"]["q1"], 0)
        self.clock.now = 4000
        self.command("finish", {"id": card["id"], "status": "completed", "reason": ""})
        self.assertEqual(self.card(card["id"])["durations"]["q1"], 3000)

    def test_edit_pauses_and_keeps_positions_and_appearance(self):
        card = self.create()
        self.command("place", {"id": card["id"], "zone": "q3", "position": {"x": 0.4, "y": 0.6}})
        self.clock.now = 2000
        self.command("begin_edit", {"id": card["id"]})
        self.clock.now = 9000
        self.command("update", {"id": card["id"], "fields": {"title": "已修改合成事项"}})
        stored = self.card(card["id"])
        self.assertEqual(stored["zone"], "prep")
        self.assertIsNone(stored["startedAt"])
        self.assertEqual(stored["durations"]["q3"], 1000)
        self.assertEqual(stored["description"], FIELDS["description"])
        self.assertEqual(stored["positions"], {"q3": {"x": 0.4, "y": 0.6}})
        self.assertEqual(stored["appearance"], card["appearance"])

    def test_repeated_restore_keeps_distinct_frozen_snapshots(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        self.clock.now = 2000
        self.command("finish", {"id": card["id"], "status": "cancelled", "reason": "当时取消"})
        first = copy.deepcopy(self.store.state()["state"]["events"][-1]["snapshot"])
        self.clock.now = 4000
        self.command("restore_card", {"id": card["id"]})
        self.command("update", {"id": card["id"], "fields": {"title": "恢复后标题"}})
        self.command("move", {"id": card["id"], "zone": "q2"})
        self.clock.now = 4500
        self.command("finish", {"id": card["id"], "status": "completed", "reason": ""})
        second = copy.deepcopy(self.store.state()["state"]["events"][-1]["snapshot"])
        self.clock.now = 8000
        self.command("restore_card", {"id": card["id"]})
        self.command("finish", {"id": card["id"], "status": "cancelled", "reason": "再次取消"})
        snapshots = [event["snapshot"] for event in self.store.state()["state"]["events"] if "snapshot" in event]
        self.assertEqual(snapshots[0], first)
        self.assertEqual(snapshots[1], second)
        self.assertEqual(second["durations"], {"q1": 1000, "q2": 500, "q3": 0, "q4": 0})
        self.assertEqual(snapshots[2]["durations"], second["durations"])

    def test_exact_retry_returns_current_state_and_original_result(self):
        request = self.request("create", {"fields": FIELDS}, operation_id="retry-create")
        first = self.store.execute(request)
        self.command("add_category", {"name": "合成新分类"})
        current = self.store.state()
        retry = self.store.execute(copy.deepcopy(request))
        self.assertTrue(retry["replayed"])
        self.assertFalse(first["replayed"])
        self.assertEqual(retry["result"], first["result"])
        self.assertEqual(retry["state"], current["state"])
        self.assertEqual(retry["revision"], current["revision"])
        self.assertEqual(len(retry["state"]["cards"]), 1)

    def test_finish_retry_never_adds_elapsed_time_or_a_second_snapshot(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        self.clock.now = 2000
        request = self.request("finish", {"id": card["id"], "status": "completed", "reason": ""})
        first = self.store.execute(request)
        self.clock.now = 12000
        retry = self.store.execute(request)
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["result"], first["result"])
        self.assertEqual(self.card(card["id"])["durations"]["q1"], 1000)
        self.assertEqual(self.card(card["id"])["endedAt"], 2000)
        self.assertEqual(len([event for event in retry["state"]["events"] if event["type"] == "completed"]), 1)

    def test_operation_id_is_bound_to_full_request(self):
        request = self.request("create", {"fields": FIELDS}, operation_id="bound-id")
        self.store.execute(request)
        changed = copy.deepcopy(request)
        changed["payload"]["fields"]["title"] = "不应插入"
        self.unchanged_after_rejection(changed, 409)
        changed = copy.deepcopy(request)
        changed["expectedRevision"] += 1
        self.unchanged_after_rejection(changed, 409)

    def test_stale_revision_does_not_apply_any_action(self):
        stale = self.request("create", {"fields": FIELDS})
        self.create(title="先提交")
        self.unchanged_after_rejection(stale, 409)

    def test_wrong_database_identity_and_non_integer_revision_are_rejected(self):
        request = self.request("create", {"fields": FIELDS})
        request["databaseId"] = "another-synthetic-database"
        self.unchanged_after_rejection(request, 409)
        for revision in (True, -1, 0.5):
            request = self.request("create", {"fields": FIELDS})
            request["expectedRevision"] = revision
            self.unchanged_after_rejection(request)

    def test_concurrent_distinct_operations_have_one_winner(self):
        revision = self.store.state()["revision"]
        barrier = threading.Barrier(2)
        def submit(index):
            store = Store(self.db_path, clock=self.clock)
            request = self.request("create", {"fields": dict(FIELDS, title="并发" + str(index))},
                                   operation_id="concurrent-" + str(index), revision=revision)
            barrier.wait(timeout=5)
            try:
                return store.execute(request)
            except DomainError as error:
                return error
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(submit, [1, 2]))
        successes = [value for value in results if isinstance(value, dict)]
        failures = [value for value in results if isinstance(value, DomainError)]
        self.assertEqual(len(successes), 1)
        self.assertEqual([error.status for error in failures], [409])
        self.assertEqual(len(self.store.state()["state"]["cards"]), 1)

    def test_concurrent_exact_retry_commits_once(self):
        request = self.request("create", {"fields": FIELDS}, operation_id="concurrent-retry")
        barrier = threading.Barrier(2)
        def submit(_):
            store = Store(self.db_path, clock=self.clock)
            barrier.wait(timeout=5)
            return store.execute(copy.deepcopy(request))
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(submit, [1, 2]))
        self.assertEqual(sorted(result["replayed"] for result in results), [False, True])
        self.assertEqual(results[0]["result"], results[1]["result"])
        self.assertEqual(len(self.store.state()["state"]["cards"]), 1)

    def test_unicode_limits_and_invalid_fields_are_atomic(self):
        card = self.create(title="😀" * 28, description="文" * 120, category="类" * 12)
        for invalid in ({"title": " "}, {"title": "😀" * 29}, {"description": "文" * 121},
                        {"category": ""}, {"category": "类" * 13}, {"title": True}):
            with self.subTest(fields=invalid):
                self.unchanged_after_rejection(self.request("update", {"id": card["id"], "fields": invalid}))

    def test_bad_coordinates_and_ended_cards_cannot_move(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        for position in (None, {}, {"x": 0.5}, {"x": "0.5", "y": 0}, {"x": True, "y": 0},
                         {"x": -0.1, "y": 0}, {"x": 0, "y": 1.1},
                         {"x": float("nan"), "y": 0}, {"x": 0, "y": float("inf")}):
            with self.subTest(position=position):
                self.unchanged_after_rejection(self.request("place", {"id": card["id"], "zone": "q2", "position": position}))
        self.command("finish", {"id": card["id"], "status": "completed", "reason": ""})
        for action, payload in (("move", {"id": card["id"], "zone": "prep"}),
                                ("place", {"id": card["id"], "zone": "q2", "position": {"x": 0, "y": 0}})):
            self.unchanged_after_rejection(self.request(action, payload))

    def test_arrange_is_atomic_and_keeps_same_zone_start(self):
        one, two = self.create(title="一"), self.create(title="二")
        for card in (one, two):
            self.command("move", {"id": card["id"], "zone": "q1"})
        positions = [{"id": card["id"], "zone": "q1", "position": {"x": index, "y": 0.5}}
                     for index, card in enumerate((one, two))]
        bad = copy.deepcopy(positions)
        bad[1]["position"]["x"] = 2
        self.unchanged_after_rejection(self.request("arrange", {"positions": bad}))
        self.clock.now = 5000
        self.command("arrange", {"positions": positions})
        self.assertEqual([self.card(card["id"])["startedAt"] for card in (one, two)], [1000, 1000])

    def test_sqlite_failure_rolls_back_card_events_and_receipt(self):
        with sqlite3.connect(str(self.db_path)) as connection:
            connection.execute("CREATE TRIGGER reject_test_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        request = self.request("create", {"fields": FIELDS}, operation_id="transaction-retry")
        before = self.store.state()
        with self.assertRaises((DomainError, sqlite3.DatabaseError)):
            self.store.execute(request)
        self.assertEqual(self.store.state(), before)
        with sqlite3.connect(str(self.db_path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM receipts WHERE operation_id = ?", (request["operationId"],)).fetchone()[0], 0)
            connection.execute("DROP TRIGGER reject_test_event")
        result = self.store.execute(request)
        self.assertFalse(result["replayed"])
        self.assertEqual(len(result["state"]["cards"]), 1)

    def test_import_preserves_baseline_ignores_derived_stats_and_snapshots(self):
        self.clock.now = 10000
        data = legacy_data()
        before = self.store.state()
        preview = self.store.preview_import(data)
        self.assertTrue(preview["canImport"])
        self.assertEqual(self.store.state(), before, "预览不得写入")
        self.command("import", {"data": data})
        card = self.card("legacy-active")
        self.assertEqual(card["durations"]["q1"], 200)
        self.assertEqual(card["startedAt"], 300)
        self.assertEqual(card["positions"], {})
        self.clock.now = 12000
        self.command("finish", {"id": "legacy-active", "status": "completed", "reason": ""})
        self.assertEqual(self.card("legacy-active")["durations"]["q1"], 11900)
        snapshot = next(event for event in self.store.state()["state"]["events"] if event["id"] == "legacy-finish")["snapshot"]
        self.assertEqual(snapshot["durations"]["q2"], 100)

    def test_duplicate_import_never_resets_updated_card_or_adds_history(self):
        data = legacy_data()
        self.command("import", {"data": data})
        self.clock.now = 12000
        self.command("finish", {"id": "legacy-active", "status": "completed", "reason": "后来完成"})
        state = self.store.state()["state"]
        self.command("import", {"data": copy.deepcopy(data)})
        self.assertEqual(self.store.state()["state"], state)

    def test_invalid_import_is_reported_without_silently_dropping_cards(self):
        data = legacy_data()
        data["cards"].append({"id": "broken", "title": ""})
        before = self.store.state()
        preview = self.store.preview_import(data)
        self.assertFalse(preview["canImport"])
        self.assertTrue(preview["errors"])
        self.assertEqual(self.store.state(), before)
        self.unchanged_after_rejection(self.request("import", {"data": data}))

    def test_import_identity_conflict_is_not_an_implicit_overwrite(self):
        data = legacy_data()
        self.command("import", {"data": data})
        data["cards"][0]["title"] = "同标识不同内容"
        self.assertFalse(self.store.preview_import(data)["canImport"])
        self.unchanged_after_rejection(self.request("import", {"data": data}))

    def test_exported_intervals_roundtrip_without_adding_derived_residence(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        self.clock.now = 2000
        self.command("move", {"id": card["id"], "zone": "q2"})
        self.clock.now = 5000
        exported = self.store.export()
        restored = Store(self.directory / "roundtrip.sqlite3", clock=self.clock)
        restored.execute({"operationId": "roundtrip-import", "expectedRevision": 0,
                          "action": "import", "payload": {"data": exported}})
        self.assertEqual(restored.export()["residenceRecords"], exported["residenceRecords"])
        self.clock.now = 8000
        response = restored.execute({"operationId": "roundtrip-finish", "expectedRevision": 1,
                                     "action": "finish", "payload": {"id": card["id"], "status": "completed", "reason": ""}})
        self.assertEqual(response["state"]["cards"][0]["durations"], {"q1": 1000, "q2": 6000, "q3": 0, "q4": 0})

    def test_backup_is_sqlite_preview_is_read_only_restore_is_idempotent(self):
        card = self.create()
        self.command("finish", {"id": card["id"], "status": "completed", "reason": "备份基准"})
        backup = self.store.create_backup()
        self.assertIn(backup["id"], [item["id"] for item in self.store.list_backups()])
        with sqlite3.connect(str(self.backup_path(backup["id"]))) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.command("restore_card", {"id": card["id"]})
        self.command("update", {"id": card["id"], "fields": {"title": "备份后的修改"}})
        current = self.store.state()
        preview = self.store.preview_restore(backup["id"])
        self.assertTrue(preview["canRestore"])
        self.assertEqual(self.store.state(), current)
        request = self.request("restore_backup", {"backupId": backup["id"]}, operation_id="restore-once")
        restored = self.store.execute(request)
        self.assertEqual(restored["revision"], current["revision"] + 1)
        self.assertEqual(restored["databaseId"], current["databaseId"])
        self.assertEqual(self.card(card["id"])["status"], "completed")
        self.assertEqual(self.card(card["id"])["title"], FIELDS["title"])
        self.assertTrue(restored["result"]["safetyBackupId"])
        retry = self.store.execute(copy.deepcopy(request))
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["result"], restored["result"])
        self.assertEqual(retry["revision"], restored["revision"])

    def test_corrupt_backup_cannot_replace_current_database(self):
        self.create()
        backup = self.store.create_backup()
        path = self.backup_path(backup["id"])
        path.write_bytes(b"synthetic corrupted backup")
        self.unchanged_after_rejection(self.request("restore_backup", {"backupId": backup["id"]}))
        with sqlite3.connect(str(self.db_path)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_restoring_active_backup_retains_original_wall_clock_origin(self):
        card = self.create()
        self.command("move", {"id": card["id"], "zone": "q1"})
        self.clock.now = 2000
        backup = self.store.create_backup()
        self.clock.now = 3000
        self.command("move", {"id": card["id"], "zone": "prep"})
        self.clock.now = 6000
        self.command("restore_backup", {"backupId": backup["id"]})
        self.assertEqual(self.card(card["id"])["startedAt"], 1000)
        self.assertEqual(self.card(card["id"])["durations"]["q1"], 0)
        self.clock.now = 7000
        self.command("finish", {"id": card["id"], "status": "completed", "reason": ""})
        self.assertEqual(self.card(card["id"])["durations"]["q1"], 6000)

    def test_restart_preserves_identity_receipts_and_open_residence(self):
        card = self.create()
        request = self.request("move", {"id": card["id"], "zone": "q4"}, operation_id="before-restart")
        first = self.store.execute(request)
        self.clock.now = 9000
        self.store = Store(self.db_path, clock=self.clock)
        self.assertEqual(self.store.state()["databaseId"], first["databaseId"])
        retry = self.store.execute(request)
        self.assertTrue(retry["replayed"])
        self.assertEqual(self.card(card["id"])["startedAt"], 1000)
        self.command("finish", {"id": card["id"], "status": "completed", "reason": ""})
        self.assertEqual(self.card(card["id"])["durations"]["q4"], 8000)

    def test_settings_categories_and_export_survive_restart(self):
        self.command("settings", {"settings": {"motion": "off", "respectSystem": False}})
        self.command("add_category", {"name": "合成分类"})
        self.create(category="合成分类")
        self.store = Store(self.db_path, clock=self.clock)
        exported = self.store.export()
        self.assertEqual(exported["version"], 1)
        self.assertEqual(exported["settings"]["motion"], "off")
        self.assertFalse(exported["settings"]["respectSystem"])
        self.assertIn("合成分类", exported["categories"])
        self.assertEqual(len(exported["cards"]), 1)
        self.assertEqual(json.loads(json.dumps(exported, ensure_ascii=False))["cards"], exported["cards"])

    def test_clock_rollback_never_reorders_card_history_or_creates_negative_residence(self):
        card = self.create()
        self.clock.now = 1500
        self.command("move", {"id": card["id"], "zone": "q2"})
        self.clock.now = 2000
        self.command("place", {"id": card["id"], "zone": "q2", "position": {"x": .2, "y": .3}})
        self.clock.now = 1900
        for action, payload in (
            ("finish", {"id": card["id"], "status": "completed"}),
            ("begin_edit", {"id": card["id"]}),
            ("update", {"id": card["id"], "fields": {"title": "不应保存"}}),
            ("move", {"id": card["id"], "zone": "q1"}),
        ):
            with self.subTest(action=action):
                self.unchanged_after_rejection(self.request(action, payload), status=409)
        self.clock.now = 2500
        self.command("finish", {"id": card["id"], "status": "completed"})
        self.assertEqual(self.card(card["id"])["durations"]["q2"], 1000)
        self.clock.now = 2400
        self.unchanged_after_rejection(self.request("restore_card", {"id": card["id"]}), status=409)


if __name__ == "__main__":
    unittest.main()
