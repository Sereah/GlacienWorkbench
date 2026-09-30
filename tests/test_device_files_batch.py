from __future__ import annotations

import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from codes.app import device_files


class DeviceFilesBatchTest(unittest.TestCase):
    def tearDown(self):
        device_files._ACTIVE_DOWNLOADS.clear()
        device_files._ACTIVE_STAGING_DIRECTORIES.clear()

    def test_pull_known_file_uses_download_staging(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            def adb_call(_settings, *args, **_kwargs):
                Path(args[-1]).write_bytes(b"apk")
                return 0, "pulled", ""

            with patch.object(device_files.android, "device_adb", side_effect=adb_call) as adb:
                result = device_files.pull_known_file({"_selected_adb_serial": "SERIAL"}, "/data/app/base.apk", "com.example.apk")

        self.assertEqual("com.example.apk", result["name"])
        self.assertTrue(result["url"].startswith("/api/device-files/download?id="))
        self.assertEqual(("pull", "/data/app/base.apk"), adb.call_args.args[1:3])

    def test_download_cache_status_counts_nested_files(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            nested = Path(folder) / "SERIAL" / "timestamp"
            nested.mkdir(parents=True)
            (nested / "one.apk").write_bytes(b"1234")
            (nested / "two.zip").write_bytes(b"12")

            status = device_files.download_cache_status()

        self.assertEqual(2, status["files"])
        self.assertEqual(6, status["bytes"])

    def test_download_cache_is_registered_at_data_root(self):
        definition = device_files.storage.STORAGE_DOMAINS["device_files"]

        self.assertEqual(".", definition["root"])
        self.assertEqual(("downloads",), definition["directories"])

    def test_legacy_download_cache_migrates_without_overwriting_conflicts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            legacy = root / "adb-tools" / "device-tools" / "downloads"
            current = root / "downloads"
            (legacy / "SERIAL" / "old").mkdir(parents=True)
            (legacy / "SERIAL" / "conflict").mkdir(parents=True)
            (current / "SERIAL" / "conflict").mkdir(parents=True)
            (legacy / "SERIAL" / "old" / "app.apk").write_bytes(b"old")
            (legacy / "SERIAL" / "conflict" / "app.apk").write_bytes(b"legacy")
            (current / "SERIAL" / "conflict" / "app.apk").write_bytes(b"current")

            with patch.object(device_files, "LEGACY_DOWNLOAD_ROOT", legacy), patch.object(device_files, "DOWNLOAD_ROOT", current):
                result = device_files.migrate_legacy_download_cache()

            self.assertEqual({"migrated": 1, "skipped": 1}, result)
            self.assertEqual(b"old", (current / "SERIAL" / "old" / "app.apk").read_bytes())
            self.assertEqual(b"current", (current / "SERIAL" / "conflict" / "app.apk").read_bytes())
            self.assertEqual(b"legacy", (legacy / "SERIAL" / "conflict" / "app.apk").read_bytes())

    def test_clear_download_cache_skips_active_transfer(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            nested = Path(folder) / "SERIAL" / "timestamp"
            nested.mkdir(parents=True)
            active = nested / "active.apk"
            stale = nested / "stale.apk"
            active.write_bytes(b"active")
            stale.write_bytes(b"stale")
            opened = device_files.begin_download("SERIAL/timestamp/active.apk")

            result = device_files.clear_download_cache(True)

            self.assertTrue(active.exists())
            self.assertFalse(stale.exists())
            self.assertEqual(1, result["deleted"])
            device_files.finish_download(opened, False)

    def test_clear_download_cache_skips_active_pull_staging(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            staging = device_files._download_folder("SERIAL")
            item = staging / "pulling.apk"
            item.write_bytes(b"partial")

            result = device_files.clear_download_cache(True)

            self.assertEqual(0, result["deleted"])
            self.assertTrue(item.exists())

    def test_clear_download_cache_requires_confirmation(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            item = Path(folder) / "cached.apk"
            item.write_bytes(b"apk")

            result = device_files.clear_download_cache(False)

            self.assertTrue(result["requires_confirmation"])
            self.assertTrue(item.exists())

    def test_completed_download_removes_staging_file_and_empty_directories(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            nested = Path(folder) / "SERIAL" / "timestamp"
            nested.mkdir(parents=True)
            item = nested / "app.apk"
            item.write_bytes(b"apk")
            opened = device_files.begin_download("SERIAL/timestamp/app.apk")

            device_files.finish_download(opened, True)

            self.assertFalse(item.exists())
            self.assertFalse(nested.exists())

    def test_interrupted_download_keeps_staging_file_for_retry(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            nested = Path(folder) / "SERIAL" / "timestamp"
            nested.mkdir(parents=True)
            item = nested / "app.apk"
            item.write_bytes(b"apk")
            opened = device_files.begin_download("SERIAL/timestamp/app.apk")

            device_files.finish_download(opened, False)

            self.assertTrue(item.exists())
            self.assertEqual(0, device_files.download_cache_status()["active"])

    def test_stale_cleanup_preserves_recent_files(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(device_files, "DOWNLOAD_ROOT", Path(folder)):
            nested = Path(folder) / "SERIAL" / "timestamp"
            nested.mkdir(parents=True)
            old = nested / "old.apk"
            recent = nested / "recent.apk"
            old.write_bytes(b"old")
            recent.write_bytes(b"recent")
            os.utime(old, (100, 100))

            result = device_files.cleanup_stale_downloads(max_age_seconds=100, now=1000)

            self.assertEqual(1, result["deleted"])
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())

    def test_batch_entries_require_same_parent_and_unique_paths(self):
        with self.assertRaisesRegex(ValueError, "至少选择"):
            device_files._fresh_entries({}, [])
        with self.assertRaisesRegex(ValueError, "重复"):
            device_files._fresh_entries({}, ["/sdcard/a.txt", "/sdcard/a.txt"])
        with self.assertRaisesRegex(ValueError, "同一设备目录"):
            device_files._fresh_entries({}, ["/sdcard/a.txt", "/data/b.txt"])

    def test_batch_entries_rescan_parent_once(self):
        listed = [
            {"name": "folder", "path": "/sdcard/folder", "type": "directory"},
            {"name": "a.txt", "path": "/sdcard/a.txt", "type": "file"},
        ]
        with patch.object(device_files, "_children", return_value=listed) as children:
            result = device_files._fresh_entries({}, ["/sdcard/folder", "/sdcard/a.txt"])
        self.assertEqual(2, len(result))
        children.assert_called_once_with({}, "/sdcard")

    def test_batch_delete_uses_type_specific_arguments(self):
        entries = [
            ("/sdcard/folder", {"name": "folder", "path": "/sdcard/folder", "type": "directory"}),
            ("/sdcard/a.txt", {"name": "a.txt", "path": "/sdcard/a.txt", "type": "file"}),
        ]
        with patch.object(device_files, "_fresh_entries", return_value=entries), patch.object(device_files.android, "device_adb", return_value=(0, "", "")) as adb_call:
            result = device_files.delete_batch({}, [item[0] for item in entries], True)
        self.assertEqual(2, result["deleted_count"])
        self.assertEqual(0, result["failed_count"])
        self.assertEqual(
            [
                unittest.mock.call({}, "shell", "rm", "-rf", "/sdcard/folder", timeout=120),
                unittest.mock.call({}, "shell", "rm", "-f", "/sdcard/a.txt", timeout=30),
            ],
            adb_call.call_args_list,
        )

    def test_batch_delete_requires_confirmation(self):
        with patch.object(device_files, "_fresh_entries") as entries:
            result = device_files.delete_batch({}, ["/sdcard/a.txt"], False)
        self.assertEqual({"requires_confirmation": True}, result)
        entries.assert_not_called()

    def test_create_directory_uses_argument_array(self):
        with patch.object(device_files, "_entry_with_name", return_value=None), patch.object(
            device_files.android, "device_adb", return_value=(0, "", "")
        ) as adb_call:
            result = device_files.create_directory({}, "/sdcard", "new folder")

        self.assertEqual("/sdcard/new folder", result["path"])
        adb_call.assert_called_once_with({}, "shell", "mkdir", "/sdcard/new folder", timeout=30)

    def test_entry_lookup_is_not_limited_by_visible_list_size(self):
        rows = [(f"/sdcard/item-{index}", {"type": "file"}) for index in range(device_files.MAX_ENTRIES + 1)]
        with patch.object(device_files, "_stat_rows", return_value=rows):
            result = device_files._entry_with_name({}, "/sdcard", f"item-{device_files.MAX_ENTRIES}")
        self.assertEqual(f"/sdcard/item-{device_files.MAX_ENTRIES}", result["path"])

    def test_create_directory_rejects_existing_entry(self):
        with patch.object(device_files, "_entry_with_name", return_value={"type": "file"}), patch.object(
            device_files.android, "device_adb"
        ) as adb_call:
            with self.assertRaisesRegex(ValueError, "同名设备文件或文件夹已存在"):
                device_files.create_directory({}, "/sdcard", "existing")
        adb_call.assert_not_called()

    def test_create_text_file_requires_confirmation_before_overwrite(self):
        existing = {"type": "file"}
        with patch.object(device_files, "_entry_with_name", return_value=existing), patch.object(
            device_files, "upload"
        ) as upload:
            result = device_files.create_text_file({}, "/sdcard", "config.json", "{}", False)
        self.assertEqual({"requires_confirmation": True, "remote_path": "/sdcard/config.json"}, result)
        upload.assert_not_called()

    def test_create_text_file_pushes_utf8_content(self):
        with patch.object(device_files, "_entry_with_name", return_value=None), patch.object(
            device_files, "upload", return_value={"ok": True}
        ) as upload:
            result = device_files.create_text_file({}, "/sdcard", "说明.txt", "你好\n", False)
        self.assertTrue(result["ok"])
        upload.assert_called_once_with({}, "/sdcard", "说明.txt", "你好\n".encode("utf-8"), False)

    def test_create_text_file_rejects_directory_and_large_content(self):
        with patch.object(device_files, "_entry_with_name", return_value={"type": "directory"}):
            with self.assertRaisesRegex(ValueError, "同名设备文件夹已存在"):
                device_files.create_text_file({}, "/sdcard", "config", "", True)
        with self.assertRaisesRegex(ValueError, "不能超过 1 MiB"):
            device_files.create_text_file({}, "/sdcard", "large.txt", "a" * (device_files.MAX_TEXT_FILE_SIZE + 1), False)
        with self.assertRaisesRegex(ValueError, "必须是 UTF-8 文本"):
            device_files.create_text_file({}, "/sdcard", "config.json", {"debug": True}, False)

    def test_preview_returns_truncated_utf8_text(self):
        item = {"name": "large.txt", "type": "file", "size": device_files.PREVIEW_BYTES + 10}
        with patch.object(device_files, "_fresh_file", return_value=("/sdcard/large.txt", item)), patch.object(
            device_files.android, "device_adb_bytes", return_value=(0, b"hello", "")
        ) as adb_call:
            result = device_files.preview({}, "/sdcard/large.txt")
        self.assertTrue(result["previewable"])
        self.assertTrue(result["truncated"])
        self.assertEqual("hello", result["content"])
        adb_call.assert_called_once_with({}, "exec-out", "head", "-c", str(device_files.PREVIEW_BYTES + 1), "/sdcard/large.txt", timeout=30)

    def test_preview_identifies_binary_without_decoding_it(self):
        item = {"name": "app.apk", "type": "file", "size": 128}
        with patch.object(device_files, "_fresh_file", return_value=("/sdcard/app.apk", item)), patch.object(
            device_files.android, "device_adb_bytes", return_value=(0, b"PK\x03\x04\x00", "")
        ):
            result = device_files.preview({}, "/sdcard/app.apk")
        self.assertFalse(result["previewable"])
        self.assertEqual("ZIP/APK/JAR 归档", result["detected_type"])
        self.assertNotIn("content", result)

    def test_truncated_preview_drops_incomplete_utf8_character(self):
        content = "内容".encode("utf-8")[:-1]
        self.assertEqual("内", device_files._decode_preview_text(content, True))
        self.assertIsNone(device_files._decode_preview_text(content, False))


if __name__ == "__main__":
    unittest.main()
