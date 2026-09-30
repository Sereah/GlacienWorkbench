from __future__ import annotations

import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from codes.app import bugreports, server, storage


class BugreportFilesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.files = self.root / "files"
        self.runtime = self.root / "runtime"
        self.files.mkdir()
        self.runtime.mkdir()
        self.files_patch = patch.object(bugreports, "_files_root", return_value=self.files)
        self.runtime_patch = patch.object(bugreports, "_runtime_root", return_value=self.runtime)
        self.files_patch.start()
        self.runtime_patch.start()
        bugreports._session.clear()

    def tearDown(self):
        bugreports._session.clear()
        self.runtime_patch.stop()
        self.files_patch.stop()
        self.temporary.cleanup()

    def test_files_only_returns_managed_zip_files(self):
        (self.files / "one.zip").write_bytes(b"zip")
        (self.files / "ignore.txt").write_text("ignore")

        result = bugreports.files()

        self.assertEqual(["one.zip"], [item["id"] for item in result["items"]])

    def test_resolve_rejects_paths_outside_directory(self):
        with self.assertRaisesRegex(ValueError, "ID 无效"):
            bugreports.resolve_file("../outside.zip")

    def test_storage_registration_does_not_change_existing_domains(self):
        self.assertIn("bugreports", storage.STORAGE_DOMAINS)
        self.assertIsNone(storage.STORAGE_DOMAINS["bugreports"]["config"])

    def test_download_disposition_keeps_original_zip_name(self):
        disposition = server.download_disposition("bugreport-设备-20260930.zip")

        self.assertIn('filename="bugreport-_-20260930.zip"', disposition)
        self.assertIn("filename*=UTF-8''bugreport-%E8%AE%BE%E5%A4%87-20260930.zip", disposition)

    def test_successful_task_moves_only_completed_zip(self):
        temporary = self.runtime / "task"
        temporary.mkdir()
        generated = temporary / "device-bugreport.zip"
        generated.write_bytes(b"valid-zip")
        process = SimpleNamespace(returncode=0, communicate=lambda: ("done", ""))
        output = self.files / "bugreport-device.zip"
        bugreports._session.update({"state": "running", "process": process})

        bugreports._finish(process, temporary, output)

        self.assertEqual("completed", bugreports.status()["state"])
        self.assertEqual(b"valid-zip", output.read_bytes())
        self.assertFalse(temporary.exists())

    def test_failed_task_does_not_publish_partial_file(self):
        temporary = self.runtime / "task"
        temporary.mkdir()
        (temporary / "partial.zip").write_bytes(b"partial")
        process = SimpleNamespace(returncode=1, communicate=lambda: ("", "device disconnected"))
        bugreports._session.update({"state": "running", "process": process})

        bugreports._finish(process, temporary, self.files / "result.zip")

        self.assertEqual("failed", bugreports.status()["state"])
        self.assertFalse((self.files / "result.zip").exists())
        self.assertFalse(temporary.exists())


if __name__ == "__main__":
    unittest.main()
