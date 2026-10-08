from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from codes.app import android


class WirelessAdbTest(unittest.TestCase):
    def test_parse_users_keeps_current_and_running_state(self):
        output = """Users:
 UserInfo{0:机主:4c13} running
 UserInfo{10:新用户:400}
 UserInfo{11:新用户:400} running
"""

        self.assertEqual([
            {"user_id": 0, "name": "机主", "current": True, "running": True},
            {"user_id": 10, "name": "新用户", "current": False, "running": False},
            {"user_id": 11, "name": "新用户", "current": False, "running": True},
        ], android.parse_users(output, 0))

    def test_validated_user_ids_rejects_unknown_user(self):
        catalog = {"current_user_id": 0, "items": [{"user_id": 0}, {"user_id": 10}]}
        with patch.object(android, "users", return_value=catalog):
            with self.assertRaisesRegex(ValueError, "User 不存在：11"):
                android.validated_user_ids({}, [0, 11])

    def test_mdns_only_keeps_connectable_services(self):
        output = """List of discovered mdns services
pixel _adb._tcp 192.168.1.20:5555
secure _adb-tls-connect._tcp 192.168.1.21:37123
pair _adb-tls-pairing._tcp 192.168.1.21:37124
"""
        with patch.object(android, "adb", return_value=(0, output, "")):
            self.assertEqual(
                [("192.168.1.20", 5555), ("192.168.1.21", 37123)],
                android._mdns_wireless_endpoints({}),
            )

    def test_cleanup_only_disconnects_offline_wireless_transports(self):
        listed = [
            {"serial": "USB123", "state": "offline"},
            {"serial": "192.168.1.20:5555", "state": "offline"},
            {"serial": "192.168.1.21:5555", "state": "device"},
        ]
        with patch.object(android, "devices", return_value=listed), patch.object(android, "adb", return_value=(0, "disconnected", "")) as adb_call:
            result = android.clean_offline_wireless({})

        self.assertEqual(["192.168.1.20:5555"], result["removed"])
        adb_call.assert_called_once_with({}, "disconnect", "192.168.1.20:5555", timeout=5)

    def test_scan_merges_connected_mdns_gateway_and_subnet_candidates(self):
        listed = [{"serial": "192.168.1.20:5555", "state": "device", "model": "Pixel"}]
        open_ips = {"192.168.1.1", "192.168.1.30"}
        with patch.object(android, "clean_offline_wireless", return_value={"removed": []}), \
             patch.object(android, "devices", return_value=listed), \
             patch.object(android, "_host_ipv4", return_value="192.168.1.10"), \
             patch.object(android, "_default_gateway", return_value=("192.168.1.1", "en0")), \
             patch.object(android, "_mdns_wireless_endpoints", return_value=[("192.168.1.20", 5555)]), \
             patch.object(android, "_tcp_endpoint_open", side_effect=lambda ip, port, timeout=.22: ip in open_ips):
            result = android.scan_wireless({}, {"port": 5555})

        by_serial = {item["serial"]: item for item in result["devices"]}
        self.assertEqual("device", by_serial["192.168.1.20:5555"]["state"])
        self.assertEqual(["connected", "mdns"], by_serial["192.168.1.20:5555"]["sources"])
        self.assertIn("gateway", by_serial["192.168.1.1:5555"]["sources"])
        self.assertIn("subnet", by_serial["192.168.1.30:5555"]["sources"])
        self.assertEqual("192.168.1.0/24", result["subnet"])

    def test_disconnect_validates_endpoint(self):
        with patch.object(android, "adb", return_value=(0, "disconnected", "")) as adb_call:
            result = android.disconnect_wireless({}, {"ip": "192.168.1.20", "port": 5555})
        self.assertEqual("192.168.1.20:5555", result["serial"])
        adb_call.assert_called_once_with({}, "disconnect", "192.168.1.20:5555", timeout=8)

    def test_pairing_status_separates_pair_and_connect_services(self):
        output = """List of discovered mdns services
pixel-pair _adb-tls-pairing._tcp 192.168.1.20:37124
pixel-connect _adb-tls-connect._tcp 192.168.1.20:37123
"""
        with patch.object(android, "tool", return_value="/sdk/adb"), patch.object(
            android, "adb", side_effect=[(0, "pair HOST[:PORT] [PAIRING CODE]", ""), (0, output, "")]
        ):
            result = android.wireless_pairing_status({})

        self.assertTrue(result["supported"])
        self.assertEqual("192.168.1.20:37124", result["pairing_services"][0]["endpoint"])
        self.assertEqual("192.168.1.20:37123", result["connect_services"][0]["endpoint"])

    def test_pairing_code_uses_stdin_instead_of_command_argument(self):
        completed = SimpleNamespace(returncode=0, stdout="Successfully paired to 192.168.1.20:37124", stderr="")
        with patch.object(android, "tool", return_value="/sdk/adb"), patch.object(
            android.proc, "run", return_value=completed
        ) as run_call, patch.object(
            android, "wireless_pairing_status", return_value={"connect_services": []}
        ):
            result = android.pair_wireless({}, {"ip": "192.168.1.20", "port": 37124, "pairing_code": "123456"})

        self.assertTrue(result["ok"])
        self.assertEqual(["/sdk/adb", "pair", "192.168.1.20:37124"], run_call.call_args.args[0])
        self.assertEqual("123456\n", run_call.call_args.kwargs["input"])
        self.assertNotIn("123456", run_call.call_args.args[0])

    def test_pairing_rejects_invalid_code_before_running_adb(self):
        with patch.object(android.proc, "run") as run_call:
            with self.assertRaisesRegex(ValueError, "六位"):
                android.pair_wireless({}, {"ip": "192.168.1.20", "port": 37124, "pairing_code": "12ab"})
        run_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
