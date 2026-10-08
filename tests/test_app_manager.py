from __future__ import annotations

import unittest
from unittest.mock import patch

from codes.app import app_manager


class AppManagerTest(unittest.TestCase):
    def test_package_rows_accept_multi_user_uids(self):
        output = "\n".join((
            "package:/data/app/nova/base.apk=com.larus.nova uid:10084,1010084,1110084",
            "package:/system/priv-app/Speech/Speech.apk=com.bytedance.vehicle.speech uid:10059,1010059,1110059",
            "package:/system/app/Single/Single.apk=com.example.single uid:10123",
        ))

        rows = app_manager._parse_package_rows(output)

        self.assertEqual(3, len(rows))
        self.assertEqual("com.larus.nova", rows[0]["package"])
        self.assertEqual("10084,1010084,1110084", rows[0]["uid"])
        self.assertEqual("com.bytedance.vehicle.speech", rows[1]["package"])
        self.assertEqual("10123", rows[2]["uid"])

    def test_application_list_uses_batch_queries(self):
        def adb_call(_settings, *args, **_kwargs):
            outputs = {
                ("shell", "pm", "list", "packages", "-f", "-U"): "\n".join((
                    "package:/data/app/a/base.apk=com.example.a uid:10101",
                    "package:/system/priv-app/System/System.apk=com.android.system uid:1000",
                )),
                ("shell", "pm", "list", "packages", "-3"): "package:com.example.a",
                ("shell", "ps", "-A", "-o", "USER,UID,PID,NAME"): "USER UID PID NAME\nu0_a1 10101 123 com.example.a:worker",
            }
            return 0, outputs[args], ""

        with patch.object(app_manager.android, "device_adb", side_effect=adb_call) as adb:
            result = app_manager.applications({})

        self.assertEqual(2, result["total"])
        self.assertEqual("user", result["items"][0]["kind"])
        self.assertEqual(["123"], result["items"][0]["pids"])
        self.assertEqual(
            [{"user_id": "0", "user": "u0_a1", "uid": "10101", "pid": "123", "name": "com.example.a:worker"}],
            result["items"][0]["processes"],
        )
        self.assertEqual(3, adb.call_count)

    def test_process_list_keeps_user_uid_pid_and_name_relationship(self):
        output = """USER UID PID NAME
u0_a84 10084 12849 com.larus.nova
u10_a84 1010084 12857 com.larus.nova
u10_a59 1010059 7949 com.bytedance.vehicle.speech:voice
"""

        processes = app_manager._parse_running_processes(output, True)

        self.assertEqual(
            [
                {"user_id": "0", "user": "u0_a84", "uid": "10084", "pid": "12849", "name": "com.larus.nova"},
                {"user_id": "10", "user": "u10_a84", "uid": "1010084", "pid": "12857", "name": "com.larus.nova"},
            ],
            processes["com.larus.nova"],
        )
        self.assertEqual("com.bytedance.vehicle.speech:voice", processes["com.bytedance.vehicle.speech"][0]["name"])

    def test_details_are_loaded_on_demand(self):
        package_dump = """userId=10101
enabled=1
versionCode=42 targetSdk=35
versionName=1.2.3
firstInstallTime=2026-01-01 10:00:00
lastUpdateTime=2026-02-01 10:00:00
signatures:[abcd]
  User 0: installed=true stopped=false enabled=0
"""
        def adb_call(_settings, *args, **_kwargs):
            outputs = {
                ("shell", "dumpsys", "package", "com.example.app"): package_dump,
                ("shell", "pm", "path", "com.example.app"): "package:/data/app/example/base.apk",
                ("shell", "dumpsys", "package", "android"): "signatures:[abcd]",
                ("shell", "ps", "-A", "-o", "USER,UID,PID,NAME"): "USER UID PID NAME\n",
                ("shell", "pm", "list", "users"): "Users:\n\tUserInfo{0:Owner:13} running",
                ("shell", "am", "get-current-user"): "0",
            }
            return 0, outputs[args], ""

        with patch.object(app_manager.android, "device_adb", side_effect=adb_call):
            result = app_manager.details({"app_launches": {}}, "com.example.app")

        self.assertEqual("1.2.3", result["version_name"])
        self.assertEqual("42", result["version_code"])
        self.assertEqual("10101", result["uid"])
        self.assertTrue(result["enabled"])
        self.assertEqual("platform", result["signature_status"])
        self.assertEqual([{"user_id": 0, "installed": True, "enabled_state": "0", "enabled": True, "stopped": False, "name": "Owner", "current": True}], result["users"])

    def test_details_falls_back_to_installed_android_user_for_apk_path(self):
        package_dump = """Package [com.bytedance.byteautoservice3]:
  User 0: installed=false enabled=0
  User 10: installed=true enabled=0
  User 11: installed=true enabled=0
"""

        def adb_call(_settings, *args, **_kwargs):
            if args == ("shell", "dumpsys", "package", "com.bytedance.byteautoservice3"):
                return 0, package_dump, ""
            if args == ("shell", "pm", "path", "com.bytedance.byteautoservice3"):
                return 1, "", ""
            if args == ("shell", "pm", "path", "--user", "10", "com.bytedance.byteautoservice3"):
                return 0, "package:/data/app/byteauto/base.apk\n", ""
            if args == ("shell", "dumpsys", "package", "android"):
                return 0, "", ""
            if args == ("shell", "ps", "-A", "-o", "USER,UID,PID,NAME"):
                return 0, "USER UID PID NAME\n", ""
            if args == ("shell", "pm", "list", "users"):
                return 0, "Users:\n UserInfo{0:Owner:13}\n UserInfo{10:Driver:12}\n UserInfo{11:RearPassenger:10}", ""
            if args == ("shell", "am", "get-current-user"):
                return 0, "10", ""
            raise AssertionError(f"unexpected adb call: {args}")

        with patch.object(app_manager.android, "device_adb", side_effect=adb_call):
            result = app_manager.details({"app_launches": {}}, "com.bytedance.byteautoservice3")

        self.assertEqual(["/data/app/byteauto/base.apk"], result["apk_paths"])

    def test_launch_resolves_launcher_activity_without_saved_configuration(self):
        with patch.object(app_manager, "_installed_user", return_value=(10, "")), patch.object(app_manager.android, "device_adb", side_effect=[
            (0, "priority=0\ncom.example.app/.MainActivity", ""),
            (0, "Starting: Intent", ""),
        ]) as adb:
            result = app_manager.launch({"app_launches": {}}, "com.example.app", 10)

        self.assertTrue(result["ok"])
        self.assertEqual("com.example.app/.MainActivity", result["component"])
        self.assertEqual(
            ("shell", "am", "start", "--user", "10", "-n", "com.example.app/.MainActivity"),
            adb.call_args_list[1].args[1:],
        )

    def test_launch_prefers_existing_special_launch_configuration(self):
        settings = {"app_launches": {"com.example.app": {"command": "am start -a com.example.SPECIAL"}}}
        with patch.object(app_manager, "_installed_user", return_value=(11, "")), patch.object(app_manager.device, "launch", return_value={"ok": True}) as launch:
            result = app_manager.launch(settings, "com.example.app", 11)

        self.assertTrue(result["ok"])
        launch.assert_called_once_with(settings, "com.example.app", 11)

    def test_clear_data_requires_confirmation(self):
        with patch.object(app_manager, "_installed_user", return_value=(10, "")), patch.object(app_manager.android, "device_adb") as adb:
            result = app_manager.clear_data({}, "com.example.app", 10, False)
        self.assertTrue(result["requires_confirmation"])
        adb.assert_not_called()

    def test_disable_requires_confirmation_and_targets_selected_user(self):
        with patch.object(app_manager, "_installed_user", return_value=(11, "")), patch.object(app_manager.android, "device_adb", return_value=(0, "disabled", "")) as adb:
            pending = app_manager.set_enabled({}, "android", 11, False, False)
            result = app_manager.set_enabled({}, "android", 11, False, True)

        self.assertTrue(pending["requires_confirmation"])
        self.assertTrue(result["ok"])
        adb.assert_called_once_with({}, "shell", "pm", "disable-user", "--user", "11", "android", timeout=45)

    def test_stop_targets_selected_user(self):
        with patch.object(app_manager, "_installed_user", return_value=(10, "")), patch.object(app_manager.android, "device_adb", return_value=(0, "", "")) as adb:
            result = app_manager.stop({}, "com.larus.nova", 10)

        self.assertTrue(result["ok"])
        adb.assert_called_once_with({}, "shell", "am", "force-stop", "--user", "10", "com.larus.nova")

    def test_operation_rejects_user_where_package_is_not_installed(self):
        package_dump = "User 10: installed=true stopped=false enabled=0\n"
        with patch.object(app_manager.android, "device_adb", return_value=(0, package_dump, "")) as adb:
            with self.assertRaisesRegex(ValueError, "未安装在 User 11"):
                app_manager.stop({}, "com.example.app", 11)

        adb.assert_called_once_with({}, "shell", "dumpsys", "package", "com.example.app", timeout=45)

    def test_uninstall_targets_only_selected_user(self):
        with patch.object(app_manager, "_installed_user", return_value=(11, "")), patch.object(app_manager.android, "device_adb", side_effect=[
            (0, "Success", ""),
            (0, "User 10: installed=true stopped=false enabled=0\nUser 11: installed=false stopped=true enabled=0", ""),
        ]) as adb:
            result = app_manager.uninstall({}, "com.example.app", 11, True)

        self.assertTrue(result["ok"])
        self.assertEqual([10], result["remaining_users"])
        self.assertEqual(({}, "shell", "pm", "uninstall", "--user", "11", "com.example.app"), adb.call_args_list[0].args)
        self.assertEqual(60, adb.call_args_list[0].kwargs["timeout"])

    def test_stop_all_targets_each_running_user(self):
        processes = {"com.larus.nova": [{"user_id": "0"}, {"user_id": "10"}, {"user_id": "11"}]}
        with patch.object(app_manager, "_running_processes", return_value=processes), patch.object(app_manager.android, "device_adb", return_value=(0, "", "")) as adb:
            result = app_manager.stop_all({}, "com.larus.nova", True)

        self.assertTrue(result["ok"])
        self.assertEqual(3, adb.call_count)
        self.assertEqual(({}, "shell", "am", "force-stop", "--user", "0", "com.larus.nova"), adb.call_args_list[0].args)

    def test_pull_apk_returns_browser_download(self):
        with patch.object(app_manager.android, "device_adb", return_value=(0, "package:/data/app/example/base.apk", "")), patch.object(
            app_manager.device_files, "pull_known_file", return_value={"ok": True, "name": "com.example.app.apk", "url": "/download"}
        ) as pull:
            result = app_manager.pull_apk({}, "com.example.app")

        self.assertEqual("com.example.app.apk", result["name"])
        pull.assert_called_once_with({}, "/data/app/example/base.apk", "com.example.app.apk")


if __name__ == "__main__":
    unittest.main()
