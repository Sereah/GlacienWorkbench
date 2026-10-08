import gzip
import io
import json
import re
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
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

    def test_plain_file_is_available_source(self):
        log_file = self.source / "single.log"
        log_file.write_text("needle\n", encoding="utf-8")

        result = logs.sources({"offline_log_sources": {"single": str(log_file)}})

        self.assertEqual("file", result[0]["kind"])
        self.assertTrue(result[0]["available"])
        self.assertEqual(("single", log_file.resolve()), logs.source_path(
            {"offline_log_sources": {"single": str(log_file)}}, "single"
        ))

    def test_single_archive_requires_selecting_parent_directory(self):
        archive = self.source / "single.log.gz"
        with gzip.open(archive, "wb") as output:
            output.write(b"needle\n")

        result = logs.sources({"offline_log_sources": {"single": str(archive)}})

        self.assertFalse(result[0]["available"])
        self.assertEqual("archive", result[0]["kind"])
        with self.assertRaisesRegex(ValueError, "所在文件夹"):
            logs.source_path({"offline_log_sources": {"single": str(archive)}}, "single")

    def test_query_single_file_uses_filename_in_results(self):
        log_file = self.source / "single.log"
        log_file.write_text("needle\n", encoding="utf-8")
        event = {
            "type": "match",
            "data": {
                "path": {"text": str(log_file)},
                "lines": {"text": "needle\n"},
                "line_number": 1,
            },
        }
        completed = subprocess.CompletedProcess([], 0, json.dumps(event), "")

        with patch.object(logs, "rg_executable", return_value="/usr/bin/rg"), \
                patch.object(logs.proc, "run", return_value=completed) as run:
            result = logs.query(
                {"offline_log_sources": {"single": str(log_file)}},
                {"source": "single", "filters": [{"mode": "include_any", "terms": ["needle"]}]},
            )

        self.assertEqual("single.log", result["results"][0]["file"])
        self.assertEqual(str(log_file.resolve()), run.call_args.args[0][-1])

    def test_directory_query_sorts_by_natural_filename_then_line_number(self):
        def match_event(name, line, text):
            return json.dumps({
                "type": "match",
                "data": {
                    "path": {"text": str(self.source / name)},
                    "lines": {"text": text + "\n"},
                    "line_number": line,
                },
            })

        output = "\n".join([
            match_event("android_log.10", 20, "third needle"),
            match_event("android_log.2", 9, "second needle"),
            match_event("android_log.2", 3, "first needle"),
        ])
        completed = subprocess.CompletedProcess([], 0, output, "")
        with patch.object(logs, "rg_executable", return_value="/usr/bin/rg"), \
                patch.object(logs.proc, "run", return_value=completed):
            result = logs.query(
                self.settings(),
                {"source": "test", "filters": [{"mode": "include_any", "terms": ["needle"]}]},
            )

        self.assertEqual(
            [("android_log.2", 3), ("android_log.2", 9), ("android_log.10", 20)],
            [(item["file"], item["line"]) for item in result["results"]],
        )

    def test_query_applies_priority_only_to_configured_keyword(self):
        log_file = self.source / "single.log"
        log_file.write_text("placeholder\n", encoding="utf-8")

        def event(line, text):
            return json.dumps({
                "type": "match",
                "data": {
                    "path": {"text": str(log_file)},
                    "lines": {"text": text + "\n"},
                    "line_number": line,
                },
            })

        output = "\n".join([
            event(1, "10-08 12:34:56.789  123  456 I Tag: noisy"),
            event(2, "10-08 12:34:56.789  123  456 I Tag: normal"),
            event(3, "10-08 12:34:56.789  123  456 E Tag: noisy"),
        ])
        completed = subprocess.CompletedProcess([], 0, output, "")
        body = {
            "source": "single",
            "filters": [{"mode": "include_any", "terms": ["normal", "noisy"]}],
            "priority_constraints": [{"term": "noisy", "minimum_priority": "E"}],
        }

        with patch.object(logs, "rg_executable", return_value="/usr/bin/rg"), \
                patch.object(logs.proc, "run", return_value=completed) as run:
            result = logs.query(
                {"offline_log_sources": {"single": str(log_file)}},
                body,
            )

        self.assertEqual([2, 3], [item["line"] for item in result["results"]])
        self.assertIn("[EFA]", run.call_args.args[0][-2])

    def test_priority_constraint_requires_included_keyword(self):
        filters = logs.normalize_filters([{"mode": "include_any", "terms": ["normal"]}])

        with self.assertRaisesRegex(ValueError, "级别限制关键词不在包含条件中"):
            logs.normalize_priority_constraints(
                [{"term": "missing", "minimum_priority": "E"}],
                filters,
            )

    def test_line_without_threadtime_header_cannot_satisfy_limited_keyword(self):
        filters = logs.normalize_filters([{"mode": "include_any", "terms": ["noisy"]}])
        constraints = logs.normalize_priority_constraints(
            [{"term": "noisy", "minimum_priority": "E"}],
            filters,
        )

        self.assertFalse(logs.line_matches("noisy without logcat header", filters, constraints))

    def test_priority_pcre_keeps_unrestricted_keyword_and_limits_noisy_keyword(self):
        filters = logs.normalize_filters([{"mode": "include_any", "terms": ["normal", "noisy"]}])
        constraints = logs.normalize_priority_constraints(
            [{"term": "noisy", "minimum_priority": "E"}],
            filters,
        )
        pattern = logs.pcre_pattern(filters, constraints)

        self.assertIsNotNone(re.search(pattern, "10-08 12:34:56.789  123  456 I Tag: normal"))
        self.assertIsNone(re.search(pattern, "10-08 12:34:56.789  123  456 I Tag: noisy"))
        self.assertIsNotNone(re.search(pattern, "10-08 12:34:56.789  123  456 E Tag: noisy"))

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
