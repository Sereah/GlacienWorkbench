from __future__ import annotations

import unittest
from unittest.mock import patch

from codes.app import device_files


class DeviceFilesBatchTest(unittest.TestCase):
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
