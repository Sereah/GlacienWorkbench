from __future__ import annotations

import unittest
from unittest.mock import patch

from codes.app import app_manager


class AppManagerTest(unittest.TestCase):
    def test_application_list_uses_batch_queries(self):
        def adb_call(_settings, *args, **_kwargs):
            outputs = {
                ("shell", "pm", "list", "packages", "-f", "-U"): "\n".join((
                    "package:/data/app/a/base.apk=com.example.a uid:10101",
                    "package:/system/priv-app/System/System.apk=com.android.system uid:1000",
                )),
                ("shell", "pm", "list", "packages", "-3"): "package:com.example.a",
                ("shell", "ps", "-A"): "USER PID NAME\nu0_a1 123 com.example.a:worker",
            }
            return 0, outputs[args], ""

        with patch.object(app_manager.android, "device_adb", side_effect=adb_call) as adb:
            result = app_manager.applications({})

        self.assertEqual(2, result["total"])
        self.assertEqual("user", result["items"][0]["kind"])
        self.assertEqual(["123"], result["items"][0]["pids"])
        self.assertEqual(3, adb.call_count)

    def test_details_are_loaded_on_demand(self):
        package_dump = """userId=10101
enabled=1
versionCode=42 targetSdk=35
versionName=1.2.3
firstInstallTime=2026-01-01 10:00:00
lastUpdateTime=2026-02-01 10:00:00
signatures:[abcd]
"""
        with patch.object(app_manager.android, "device_adb", side_effect=[
            (0, package_dump, ""),
            (0, "package:/data/app/example/base.apk", ""),
            (0, "signatures:[abcd]", ""),
        ]):
            result = app_manager.details({"app_launches": {}}, "com.example.app")

        self.assertEqual("1.2.3", result["version_name"])
        self.assertEqual("42", result["version_code"])
        self.assertEqual("10101", result["uid"])
        self.assertTrue(result["enabled"])
        self.assertEqual("platform", result["signature_status"])

    def test_launch_resolves_launcher_activity_without_saved_configuration(self):
        with patch.object(app_manager.android, "device_adb", side_effect=[
            (0, "priority=0\ncom.example.app/.MainActivity", ""),
            (0, "Starting: Intent", ""),
        ]) as adb:
            result = app_manager.launch({"app_launches": {}}, "com.example.app")

        self.assertTrue(result["ok"])
        self.assertEqual("com.example.app/.MainActivity", result["component"])
        self.assertEqual(
            ("shell", "am", "start", "-n", "com.example.app/.MainActivity"),
            adb.call_args_list[1].args[1:],
        )

    def test_launch_prefers_existing_special_launch_configuration(self):
        settings = {"app_launches": {"com.example.app": {"command": "am start -a com.example.SPECIAL"}}}
        with patch.object(app_manager.device, "launch", return_value={"ok": True}) as launch:
            result = app_manager.launch(settings, "com.example.app")

        self.assertTrue(result["ok"])
        launch.assert_called_once_with(settings, "com.example.app")

    def test_clear_data_requires_confirmation(self):
        with patch.object(app_manager.android, "device_adb") as adb:
            result = app_manager.clear_data({}, "com.example.app", False)
        self.assertTrue(result["requires_confirmation"])
        adb.assert_not_called()

    def test_disable_requires_confirmation_and_targets_current_user(self):
        with patch.object(app_manager.android, "device_adb", return_value=(0, "disabled", "")) as adb:
            pending = app_manager.set_enabled({}, "android", False, False)
            result = app_manager.set_enabled({}, "android", False, True)

        self.assertTrue(pending["requires_confirmation"])
        self.assertTrue(result["ok"])
        adb.assert_called_once_with({}, "shell", "pm", "disable-user", "--user", "current", "android", timeout=45)

    def test_pull_apk_returns_browser_download(self):
        with patch.object(app_manager.android, "device_adb", return_value=(0, "package:/data/app/example/base.apk", "")), patch.object(
            app_manager.device_files, "pull_known_file", return_value={"ok": True, "name": "com.example.app.apk", "url": "/download"}
        ) as pull:
            result = app_manager.pull_apk({}, "com.example.app")

        self.assertEqual("com.example.app.apk", result["name"])
        pull.assert_called_once_with({}, "/data/app/example/base.apk", "com.example.app.apk")


if __name__ == "__main__":
    unittest.main()
