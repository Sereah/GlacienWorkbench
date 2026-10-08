from __future__ import annotations

import unittest
from unittest.mock import patch

from codes.app import device


class DeviceProcessesTest(unittest.TestCase):
    def test_saved_launch_command_targets_selected_user(self):
        settings = {
            "_selected_adb_serial": "device-1",
            "app_launches": {"com.example.app": {"command": "am start -n com.example.app/.MainActivity"}},
        }
        with patch.object(device.android, "device_adb", return_value=(0, "Starting", "")) as adb:
            result = device.launch(settings, "com.example.app", 10)

        self.assertTrue(result["ok"])
        adb.assert_called_once_with(settings, "shell", "am start --user 10 -n com.example.app/.MainActivity", timeout=30)

    def test_parses_version_name_and_code(self):
        package_dump = """
        Package [com.example.app]:
          versionCode=306 minSdk=29 targetSdk=35
          versionName=0.3.6
        """

        self.assertEqual(
            {"version_name": "0.3.6", "version_code": "306"},
            device.package_version(package_dump),
        )

    def test_missing_or_null_version_name_uses_version_code(self):
        self.assertEqual(
            {"version_name": "", "version_code": "42"},
            device.package_version("versionCode=42 targetSdk=35\nversionName=null"),
        )

    def test_processes_refresh_only_uses_batch_queries(self):
        def adb_call(_settings, *args, **_kwargs):
            if args == ("shell", "pm", "list", "packages"):
                return 0, "package:com.example.app\n", ""
            if args == ("shell", "ps", "-A"):
                return 0, "USER PID NAME\nu0_a1 1234 com.example.app\n", ""
            raise AssertionError(f"unexpected adb call: {args}")

        with patch.object(device.android, "device_adb", side_effect=adb_call) as adb:
            result = device.processes({"process_package_keywords": ["example"], "app_launches": {}})

        self.assertEqual("", result[0]["version_name"])
        self.assertEqual("1234", result[0]["pid"])
        self.assertEqual("not_checked", result[0]["signature_status"])
        self.assertEqual(2, adb.call_count)

    def test_runtime_process_filter_overrides_without_rewriting_saved_rule(self):
        settings = {
            "log_filters": {
                "voice": {
                    "filters": [{"mode": "include_any", "terms": ["speech"]}],
                    "process_name": "com.legacy.app",
                }
            }
        }

        rule = device.log_session_filter(settings, "voice", "com.current.app:service")
        cleared = device.log_session_filter(settings, "voice", "")

        self.assertEqual("com.current.app:service", rule["process_name"])
        self.assertEqual("", cleared["process_name"])
        self.assertEqual("com.legacy.app", settings["log_filters"]["voice"]["process_name"])

    def test_keyword_priority_constraint_does_not_limit_other_terms(self):
        rule = device.normalize_log_filter({
            "filters": [{"mode": "include_any", "terms": ["normal", "noisy"]}],
            "priority_constraints": [{"term": "noisy", "minimum_priority": "E"}],
        })

        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 I Tag: normal message", rule))
        self.assertFalse(device.matches("10-08 12:34:56.789  123  456 I Tag: noisy message", rule))
        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 E Tag: noisy message", rule))
        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 F Tag: noisy message", rule))

    def test_unrestricted_term_keeps_line_that_also_contains_limited_term(self):
        rule = device.normalize_log_filter({
            "filters": [{"mode": "include_any", "terms": ["normal", "noisy"]}],
            "priority_constraints": [{"term": "noisy", "minimum_priority": "E"}],
        })

        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 I Tag: normal noisy", rule))

    def test_warning_constraint_accepts_warning_and_above(self):
        rule = device.normalize_log_filter({
            "filters": [{"mode": "include_any", "terms": ["heartbeat"]}],
            "priority_constraints": [{"term": "heartbeat", "minimum_priority": "W"}],
        })

        self.assertFalse(device.matches("10-08 12:34:56.789  123  456 I Tag: heartbeat", rule))
        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 W Tag: heartbeat", rule))
        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 E Tag: heartbeat", rule))

    def test_priority_constraint_requires_an_included_term(self):
        with self.assertRaisesRegex(ValueError, "级别限制关键词不在包含条件中"):
            device.normalize_log_filter({
                "filters": [{"mode": "include_any", "terms": ["normal"]}],
                "priority_constraints": [{"term": "missing", "minimum_priority": "E"}],
            })

    def test_legacy_log_rule_has_no_priority_constraints(self):
        rule = device.normalize_log_filter({
            "filters": [{"mode": "include_any", "terms": ["legacy"]}],
        })

        self.assertEqual([], rule["priority_constraints"])
        self.assertTrue(device.matches("10-08 12:34:56.789  123  456 D Tag: legacy", rule))

if __name__ == "__main__":
    unittest.main()
