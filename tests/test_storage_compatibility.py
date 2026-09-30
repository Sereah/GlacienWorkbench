from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from codes.app import config, device, storage, themes


class StorageCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original_root = storage.ROOT
        self.original_marker = config.MIGRATION_MARKER
        storage.ROOT = Path(self.temporary.name)
        config.ROOT = storage.ROOT
        config.MIGRATION_MARKER = storage.ROOT / ".storage-v2"
        storage.initialize()

    def tearDown(self):
        storage.ROOT = self.original_root
        config.ROOT = self.original_root
        config.MIGRATION_MARKER = self.original_marker
        self.temporary.cleanup()

    def test_legacy_commands_gain_stable_ids_and_backup(self):
        path = storage.path("commands")
        path.write_text(json.dumps({
            "schema_version": 1,
            "categories": ["调试"],
            "commands": {
                "查看进程": {"category": "调试", "command": "ps -A", "timeout_seconds": 30}
            },
            "unknown_future_field": {"keep": True},
        }, ensure_ascii=False), encoding="utf-8")

        value = storage.read("commands", storage.default("commands"))

        self.assertEqual("commands", value["storage_key"])
        self.assertEqual(2, value["schema_version"])
        self.assertTrue(value["commands"]["查看进程"]["id"].startswith("cmd_"))
        self.assertEqual({"keep": True}, value["unknown_future_field"])
        self.assertEqual(1, len(list((storage.ROOT / "runtime/migration-backups").rglob("commands.json"))))

    def test_legacy_process_launches_become_shell_commands(self):
        path = storage.path("processes")
        path.write_text(json.dumps({
            "storage_key": "processes",
            "schema_version": 1,
            "process_package_keywords": ["example"],
            "app_launches": {
                "com.example.app": {
                    "action": "com.example.OPEN",
                    "activity": ".MainActivity",
                    "extras": [{"type": "string", "key": "source", "value": "test value"}],
                }
            },
        }, ensure_ascii=False), encoding="utf-8")

        value = storage.read("processes", storage.default("processes"))

        self.assertEqual(2, value["schema_version"])
        command = value["app_launches"]["com.example.app"]["command"]
        self.assertEqual(
            ["am", "start", "-a", "com.example.OPEN", "-n", "com.example.app/.MainActivity", "--es", "source", "test value"],
            device._launch_args(command),
        )
        self.assertEqual(1, len(list((storage.ROOT / "runtime/migration-backups").rglob("processes/config.json"))))

    def test_offline_log_sources_upgrade_without_losing_directory_paths(self):
        path = storage.path("offline_logs")
        path.write_text(json.dumps({
            "storage_key": "offline_logs",
            "schema_version": 1,
            "offline_filter_presets": {"errors": {"filters": []}},
            "offline_log_sources": {"runlog": "/tmp/runlog"},
            "unknown_future_field": {"keep": True},
        }), encoding="utf-8")

        value = storage.read("offline_logs", storage.default("offline_logs"))

        self.assertEqual(2, value["schema_version"])
        self.assertEqual({"runlog": "/tmp/runlog"}, value["offline_log_sources"])
        self.assertEqual({"keep": True}, value["unknown_future_field"])
        self.assertEqual(1, len(list((storage.ROOT / "runtime/migration-backups").rglob("offline-logs/config.json"))))

    def test_process_launch_command_is_restricted(self):
        self.assertEqual(
            ["am", "start", "-n", "com.example/.MainActivity"],
            device._launch_args("am start -n com.example/.MainActivity"),
        )
        with self.assertRaisesRegex(ValueError, "必须以 am start"):
            device._launch_args("pm clear com.example")
        with self.assertRaisesRegex(ValueError, "Shell 管道"):
            device._launch_args("am start -n com.example/.MainActivity ; reboot")

    def test_current_process_schema_normalizes_legacy_launch_shape(self):
        path = storage.path("processes")
        path.write_text(json.dumps({
            "storage_key": "processes",
            "schema_version": 2,
            "process_package_keywords": [],
            "app_launches": {"com.example": {"component": "com.example/.MainActivity"}},
        }), encoding="utf-8")

        value = storage.read("processes", storage.default("processes"))

        self.assertEqual({"command": "am start -n com.example/.MainActivity"}, value["app_launches"]["com.example"])
        self.assertEqual([], value["watched_packages"])

    def test_processes_adds_watched_packages_without_losing_existing_values(self):
        storage.update("processes", {
            "process_package_keywords": ["vehicle"],
            "watched_packages": ["com.example.app", "com.example.app", "bad/package"],
            "app_launches": {"com.example.app": {"command": "am start -n com.example.app/.MainActivity"}},
        })

        value = storage.read("processes", storage.default("processes"))

        self.assertEqual(["vehicle"], value["process_package_keywords"])
        self.assertEqual(["com.example.app"], value["watched_packages"])
        self.assertIn("com.example.app", value["app_launches"])

    def test_domain_update_does_not_rewrite_other_domains(self):
        storage.update("broadcasts", {"broadcasts": {"A": {}}, "unknown_future_field": "keep"})
        before = storage.path("broadcasts").read_bytes()

        config.update_domain("commands", {"adb_commands": {}, "adb_command_categories": []})

        self.assertEqual(before, storage.path("broadcasts").read_bytes())

    def test_registering_bugreports_does_not_rewrite_existing_user_data(self):
        storage.update("processes", {"process_package_keywords": ["vehicle"], "unknown_future_field": {"keep": True}})
        before = storage.path("processes").read_bytes()

        storage.initialize()

        self.assertEqual(before, storage.path("processes").read_bytes())
        self.assertTrue(storage.data_dir("bugreports", "files").is_dir())
        self.assertTrue(storage.data_dir("bugreports", "runtime").is_dir())

    def test_audio_processing_domain_keeps_stable_metadata(self):
        result = config.update_domain("audio_processing", {
            "ffmpeg_path": "", "audio_sample_format": "s24le",
            "audio_sample_rate": 48000, "audio_channels": 8,
        })
        stored = storage.read("audio_processing", storage.default("audio_processing"))
        self.assertEqual("audio_processing", stored["storage_key"])
        self.assertEqual(1, stored["schema_version"])
        self.assertEqual(("s24le", 48000, 8), (stored["sample_format"], stored["sample_rate"], stored["channels"]))
        self.assertEqual(8, result["config"]["audio_channels"])

    def test_selected_theme_is_saved_in_user_data(self):
        storage.update("themes", {"themes": {"custom": {"name": "Custom"}}})

        result = config.update_domain("themes", {"selected_theme": "midnight-blue"})

        stored = storage.read("themes", storage.default("themes"))
        self.assertEqual("themes", stored["storage_key"])
        self.assertEqual(1, stored["schema_version"])
        self.assertEqual("midnight-blue", stored["selected_theme"])
        self.assertEqual({"custom": {"name": "Custom"}}, stored["themes"])
        self.assertEqual("midnight-blue", result["config"]["selected_theme"])

    def test_selected_theme_rejects_unsafe_id(self):
        with self.assertRaisesRegex(ValueError, "主题 ID 格式无效"):
            config.update_domain("themes", {"selected_theme": "bad/theme"})
        with self.assertRaisesRegex(ValueError, "主题 ID 格式无效"):
            config.update_domain("themes", {"selected_theme": "a" * 65})

    def test_deleting_selected_user_theme_restores_default(self):
        storage.update("themes", {
            "selected_theme": "custom",
            "themes": {"custom": {"name": "Custom", "mode": "dark", "colors": {}}},
        })

        themes.delete_theme("custom")

        stored = storage.read("themes", storage.default("themes"))
        self.assertEqual("glacien", stored["selected_theme"])
        self.assertNotIn("custom", stored["themes"])

    def test_future_schema_is_never_rewritten(self):
        path = storage.path("adb")
        original = {"storage_key": "adb", "schema_version": 99, "sdk_root": "future"}
        path.write_text(json.dumps(original), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "来自更高版本"):
            storage.read("adb", storage.default("adb"))
        self.assertEqual(original, json.loads(path.read_text(encoding="utf-8")))

    def test_mismatched_storage_key_is_never_rewritten(self):
        path = storage.path("adb")
        original = {"storage_key": "commands", "schema_version": 1, "sdk_root": "wrong"}
        path.write_text(json.dumps(original), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "storage_key 应为 adb"):
            storage.read("adb", storage.default("adb"))
        self.assertEqual(original, json.loads(path.read_text(encoding="utf-8")))

    def test_command_import_merges_other_users_data(self):
        initial_count = len(config.load()["adb_commands"])
        first = {
            "format": "glacien-commands",
            "schema_version": 2,
            "categories": ["调试"],
            "commands": {"进程": {"id": "cmd_shared", "category": "调试", "description": "", "command": "ps -A", "timeout_seconds": 30}},
        }
        second = json.loads(json.dumps(first))
        second["commands"]["进程"]["command"] = "ps -ef"

        self.assertEqual(1, config.command_import(first)["added"])
        self.assertEqual(1, config.command_import(first)["skipped"])
        result = config.command_import(second)
        self.assertEqual(1, result["added"])
        self.assertIn("进程", result["renamed"])
        commands = config.load()["adb_commands"]
        self.assertEqual(initial_count + 2, len(commands))
        self.assertEqual(len(commands), len({item["id"] for item in commands.values()}))

    def test_legacy_command_import_is_repeatable(self):
        config.load()
        legacy = {
            "format": "glacien-commands",
            "schema_version": 1,
            "categories": ["共享"],
            "commands": {"共享命令": {"category": "共享", "description": "来自其他用户", "command": "getprop ro.product.model", "timeout_seconds": 30}},
        }

        self.assertEqual(1, config.command_import(legacy)["added"])
        self.assertEqual(1, config.command_import(legacy)["skipped"])

    def test_v1_rule_bundle_remains_importable(self):
        legacy = {
            "format": "glacien-rules-bundle",
            "schema_version": 1,
            "commands": {"共享命令": {"command": "getprop ro.product.model", "timeout_seconds": 30}},
            "command_categories": ["共享"],
            "broadcasts": {"共享广播": {"action": "com.example.ACTION", "extras": []}},
            "live_log_presets": {},
            "offline_log_presets": {},
            "device_log_sources": {},
        }

        result = config.import_shared(legacy)

        self.assertEqual(1, result["imported"]["commands"])
        self.assertEqual(1, result["imported"]["broadcasts"])
        self.assertIn("共享命令", config.load()["adb_commands"])


if __name__ == "__main__":
    unittest.main()
