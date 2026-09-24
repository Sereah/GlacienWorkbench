import gzip
import io
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from codes.app import logs


class OfflineLogArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def settings(self):
        return {"offline_log_sources": {"test": str(self.source)}}

    def test_extracts_gzip_into_archive_directory_and_skips_conflict(self):
        archive = self.source / "system.log.gz"
        with gzip.open(archive, "wb") as output:
            output.write(b"first line\nneedle\n")

        result = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})
        self.assertEqual(1, result["extracted"])
        self.assertEqual(b"first line\nneedle\n", (self.source / "system.log").read_bytes())
        self.assertFalse(archive.exists())

        with gzip.open(archive, "wb") as output:
            output.write(b"new content")
        skipped = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})
        self.assertEqual(0, skipped["extracted"])
        self.assertIn("目标已存在 system.log", skipped["skipped"][0])
        self.assertTrue(archive.exists())

    def test_extracts_zip_with_relative_paths(self):
        archive = self.source / "logs.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("nested/system.log", "hello")

        stats = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})

        self.assertEqual(1, stats["files"])
        self.assertEqual("hello", (self.source / "nested/system.log").read_text())
        self.assertFalse(archive.exists())

    def test_extracts_tar_gz(self):
        archive = self.source / "logs.tar.gz"
        payload = b"tar log line\n"
        info = tarfile.TarInfo("nested/main.log")
        info.size = len(payload)
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.addfile(info, io.BytesIO(payload))

        stats = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})

        self.assertEqual(1, stats["files"])
        self.assertEqual(payload, (self.source / "nested/main.log").read_bytes())
        self.assertFalse(archive.exists())

    def test_rejects_zip_path_traversal_without_writing_outside_source(self):
        archive = self.source / "unsafe.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("../escaped.log", "unsafe")

        stats = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})

        self.assertEqual(0, stats["extracted"])
        self.assertEqual(1, len(stats["skipped"]))
        self.assertFalse((self.root / "escaped.log").exists())
        self.assertTrue(archive.exists())

    def test_rejects_zip_symlink(self):
        archive = self.source / "link.zip"
        info = zipfile.ZipInfo("linked.log")
        info.create_system = 3
        info.external_attr = 0o120777 << 16
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(info, "target")

        stats = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})

        self.assertEqual(0, stats["extracted"])
        self.assertIn("链接或特殊文件", stats["skipped"][0])
        self.assertTrue(archive.exists())

    def test_extract_requires_explicit_confirmation(self):
        with self.assertRaisesRegex(ValueError, "用户确认"):
            logs.extract_archives(self.settings(), {"source": "test"})

    def test_rejects_existing_parent_symlink_that_escapes_source(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.source / "linked").symlink_to(outside, target_is_directory=True)
        archive = self.source / "logs.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("linked/escaped.log", "unsafe")

        result = logs.extract_archives(self.settings(), {"source": "test", "confirmed": True})

        self.assertEqual(0, result["extracted"])
        self.assertIn("越界路径", result["skipped"][0])
        self.assertFalse((outside / "escaped.log").exists())


if __name__ == "__main__":
    unittest.main()
