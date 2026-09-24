from __future__ import annotations

import unittest
from unittest.mock import patch

from codes.app import android


class WirelessAdbTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
