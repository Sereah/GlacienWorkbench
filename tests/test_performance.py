from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codes.app import performance, storage


class PerformanceParsingTest(unittest.TestCase):
    def test_proc_cpu_delta_uses_total_jiffies(self):
        previous = performance._parse_proc_stat("cpu  100 0 50 850 0\ncpu0 1\ncpu1 1\n")
        current = performance._parse_proc_stat("cpu  130 0 70 900 0\ncpu0 1\ncpu1 1\n")

        self.assertEqual(50.0, performance._delta_percent(current, previous))

    def test_memory_and_storage_parsers_return_bytes(self):
        memory = performance._parse_memory("MemTotal: 1000 kB\nMemAvailable: 400 kB\n")
        storage_value = performance._parse_df("Filesystem 1K-blocks Used Available Use% Mounted on\n/data 2000 750 1250 38% /data\n")

        self.assertEqual({"total_bytes": 1024000, "used_bytes": 614400}, memory)
        self.assertEqual({"total_bytes": 2048000, "used_bytes": 768000}, storage_value)

    def test_battery_keeps_raw_current_and_normalized_value(self):
        result = performance._parse_battery(" level: 82\n status: 3\n temperature: 426\n", "-1820000\n")

        self.assertEqual(82, result["level"])
        self.assertEqual("discharging", result["status"])
        self.assertEqual(-1820000, result["current_raw"])
        self.assertEqual(-1820.0, result["current_ma"])
        self.assertEqual(42.6, result["temperature_c"])

    def test_foreground_parser_keeps_display_and_component(self):
        result = performance._parse_foreground(
            "mResumedActivity: ActivityRecord{a1 u0 com.example.app/.MainActivity t12} displayId=2"
        )

        self.assertEqual("com.example.app", result["package"])
        self.assertEqual(".MainActivity", result["activity"])
        self.assertEqual(2, result["display_id"])

    def test_foreground_parser_does_not_borrow_another_display(self):
        result = performance._parse_foreground(
            "displayId=7 mCurrentFocus=null\n"
            "mResumedActivity: ActivityRecord{a1 u0 com.example.app/.MainActivity t12}"
        )

        self.assertIsNone(result["display_id"])

    def test_foreground_parser_prefers_target_package_on_another_display(self):
        result = performance._parse_foreground(
            "Display #0 (activities from top to bottom):\n"
            "  topResumedActivity=ActivityRecord{a u0 com.android.launcher/.Home t1}\n"
            "Display #2 (activities from top to bottom):\n"
            "  topResumedActivity=ActivityRecord{b u0 com.example.app/.MainActivity t2}\n",
            "com.example.app",
        )

        self.assertEqual("com.example.app/.MainActivity", result["component"])
        self.assertEqual(2, result["display_id"])

    def test_global_foreground_recovers_its_own_display(self):
        result = performance._parse_foreground(
            "Display #0 (activities from top to bottom):\n"
            "  topResumedActivity=ActivityRecord{a u0 com.android.settings/.Settings t1}\n"
            "Display #2 (activities from top to bottom):\n"
            "  topResumedActivity=ActivityRecord{b u0 com.example.app/.MainActivity t2}\n"
            "ResumedActivity: ActivityRecord{a u0 com.android.settings/.Settings t1}\n"
        )

        self.assertEqual("com.android.settings/.Settings", result["component"])
        self.assertEqual(0, result["display_id"])


class PerformanceSessionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original_root = storage.ROOT
        storage.ROOT = Path(self.temporary.name)
        storage.initialize()
        performance._session.clear()

    def tearDown(self):
        stop_event = performance._session.get("stop_event")
        if stop_event:
            stop_event.set()
        worker = performance._session.get("worker")
        if worker:
            worker.join(timeout=2)
        performance._session.clear()
        storage.ROOT = self.original_root
        self.temporary.cleanup()

    def test_session_can_pause_resume_stop_and_export(self):
        settings = {"_selected_adb_serial": "device-1"}
        adb_result = (0, "package:/system/app/Demo.apk\n", "")
        with patch.object(performance.android, "device_adb", return_value=adb_result), patch.object(performance, "_worker"):
            started = performance.start(settings, {"package": "com.example.app", "sample_interval_seconds": 2})

        self.assertEqual("running", started["state"])
        performance._append_event({"type": "sample", "timestamp": "2026-09-30T10:00:00+08:00", "elapsed_ms": 0})
        self.assertEqual("paused", performance.pause()["state"])
        self.assertEqual("running", performance.resume()["state"])
        completed = performance.stop()

        self.assertEqual("completed", completed["state"])
        csv_path = performance.resolve_download(started["session_id"], "csv")
        json_path = performance.resolve_download(started["session_id"], "json")
        self.assertTrue(csv_path.is_file())
        document = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual("performance_diagnostics", document["storage_key"])
        self.assertEqual(1, len(document["samples"]))
        download_name = performance.download_name(started["session_id"], "json")
        self.assertTrue(download_name.startswith("performance-com.example.app-device-1-"))
        self.assertTrue(download_name.endswith(".json"))

    def test_download_rejects_directory_traversal(self):
        with self.assertRaisesRegex(ValueError, "文件 ID 无效"):
            performance.resolve_download("../outside", "json")

    def test_start_rejects_uninstalled_package(self):
        with patch.object(performance.android, "device_adb", return_value=(1, "", "package not found")):
            with self.assertRaisesRegex(ValueError, "未安装"):
                performance.start({"_selected_adb_serial": "device-1"}, {"package": "com.example.missing"})

    def test_sessions_can_be_listed_and_deleted_in_batch(self):
        first_id = "a" * 32
        second_id = "b" * 32
        for session_id in (first_id, second_id):
            directory = storage.data_dir("performance_diagnostics", "sessions") / session_id
            directory.mkdir()
            storage.write_artifact_json("performance_diagnostics", directory / "manifest.json", {
                "session_id": session_id, "state": "completed", "package": "com.example.app",
                "serial": "device-1", "sample_count": 3, "started_at": "2026-09-30T10:00:00+08:00",
            })
            (directory / "performance.csv").write_text("timestamp\n", encoding="utf-8")

        listed = performance.sessions()
        self.assertEqual(2, listed["total"])
        self.assertTrue(listed["items"][0]["downloads"]["csv"].startswith("/api/performance/download"))
        with self.assertRaisesRegex(ValueError, "明确确认"):
            performance.delete_sessions([first_id])

        result = performance.delete_sessions([first_id, second_id], True)

        self.assertEqual([first_id, second_id], result["deleted"])
        self.assertEqual(0, performance.sessions()["total"])

    def test_active_session_cannot_be_deleted(self):
        session_id = "c" * 32
        directory = storage.data_dir("performance_diagnostics", "sessions") / session_id
        directory.mkdir()
        storage.write_artifact_json("performance_diagnostics", directory / "manifest.json", {
            "session_id": session_id, "state": "running", "package": "com.example.app",
        })
        performance._session.update({"session_id": session_id, "state": "running", "stop_event": None})

        with self.assertRaisesRegex(ValueError, "正在采样"):
            performance.delete_sessions([session_id], True)


if __name__ == "__main__":
    unittest.main()
