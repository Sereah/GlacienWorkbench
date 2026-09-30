from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codes.app import artifacts


class ArtifactRenameTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.apk_root = self.root / "apks"
        self.resource_root = self.root / "resources"
        self.keystore_root = self.root / "keystores"
        self.apk_root.mkdir()
        self.resource_root.mkdir()
        self.keystore_root.mkdir()
        self.apk_patch = patch.object(artifacts.config, "TARGET_ROOT", self.apk_root)
        self.resource_patch = patch.object(artifacts.config, "RESOURCE_ROOT", self.resource_root)
        self.keystore_root_patch = patch.object(artifacts.config, "KEYSTORE_ROOT", self.keystore_root)
        self.keystore_patch = patch.object(artifacts, "keystore_files", return_value=[])
        self.apk_patch.start()
        self.resource_patch.start()
        self.keystore_root_patch.start()
        self.keystore_patch.start()

    def tearDown(self):
        self.keystore_patch.stop()
        self.keystore_root_patch.stop()
        self.resource_patch.stop()
        self.apk_patch.stop()
        self.temporary.cleanup()

    def test_rename_apk_keeps_extension_and_content(self):
        source = self.apk_root / "old.apk"
        source.write_bytes(b"apk-content")

        result = artifacts.rename_apk({}, {"file": str(source), "name": "new-release"})

        output = self.apk_root / "new-release.apk"
        self.assertEqual("new-release.apk", result["file"]["name"])
        self.assertEqual(b"apk-content", output.read_bytes())
        self.assertFalse(source.exists())

    def test_rename_accepts_name_with_expected_extension(self):
        source = self.apk_root / "old.apk"
        source.write_bytes(b"apk")

        result = artifacts.rename_apk({}, {"file": str(source), "name": "new.apk"})

        self.assertEqual("new.apk", result["file"]["name"])
        self.assertTrue((self.apk_root / "new.apk").is_file())

    def test_rename_apk_moves_v4_signature_sidecar(self):
        source = self.apk_root / "old.apk"
        source.write_bytes(b"apk")
        source_idsig = self.apk_root / "old.apk.idsig"
        source_idsig.write_bytes(b"idsig")

        artifacts.rename_apk({}, {"file": str(source), "name": "new"})

        self.assertFalse(source_idsig.exists())
        self.assertEqual(b"idsig", (self.apk_root / "new.apk.idsig").read_bytes())

    def test_delete_apk_removes_v4_signature_sidecar(self):
        source = self.apk_root / "old.apk"
        source.write_bytes(b"apk")
        sidecar = self.apk_root / "old.apk.idsig"
        sidecar.write_bytes(b"idsig")

        result = artifacts.delete({}, {"file": str(source)})

        self.assertTrue(result["idsig_deleted"])
        self.assertFalse(source.exists())
        self.assertFalse(sidecar.exists())

    def test_rename_rejects_unsafe_names(self):
        source = self.apk_root / "old.apk"
        source.write_bytes(b"apk")

        for name in ("", "../outside", "folder/name", r"folder\name", "bad*name", "CON"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                artifacts.rename_apk({}, {"file": str(source), "name": name})

        self.assertTrue(source.exists())

    def test_rename_does_not_overwrite_existing_file(self):
        source = self.apk_root / "old.apk"
        destination = self.apk_root / "existing.apk"
        source.write_bytes(b"source")
        destination.write_bytes(b"destination")

        with self.assertRaisesRegex(ValueError, "文件已存在"):
            artifacts.rename_apk({}, {"file": str(source), "name": "existing"})

        self.assertEqual(b"source", source.read_bytes())
        self.assertEqual(b"destination", destination.read_bytes())

    def test_resource_rename_migrates_device_path(self):
        source = self.resource_root / "old.tar.gz"
        source.write_bytes(b"resource")
        settings = {"resource_device_paths": {"old.tar.gz": "/data/resources", "other.tar.gz": "/data/other"}}

        with patch.object(artifacts.storage, "update") as update:
            result = artifacts.rename_resource(settings, {"file": str(source), "name": "new"})

        self.assertEqual("new.tar.gz", result["file"]["name"])
        self.assertEqual("/data/resources", result["file"]["device_path"])
        update.assert_called_once_with("resources", {"resource_device_paths": {"other.tar.gz": "/data/other", "new.tar.gz": "/data/resources"}})

    def test_resource_rename_rolls_back_when_config_write_fails(self):
        source = self.resource_root / "old.tar.gz"
        source.write_bytes(b"resource")
        settings = {"resource_device_paths": {"old.tar.gz": "/data/resources"}}

        with patch.object(artifacts.storage, "update", side_effect=RuntimeError("write failed")):
            with self.assertRaisesRegex(RuntimeError, "write failed"):
                artifacts.rename_resource(settings, {"file": str(source), "name": "new"})

        self.assertTrue(source.exists())
        self.assertFalse((self.resource_root / "new.tar.gz").exists())

    def test_sign_disables_v4_and_cleans_generated_sidecar(self):
        source = self.apk_root / "source.apk"
        source.write_bytes(b"source")
        keystore = self.keystore_root / "release.jks"
        keystore.write_bytes(b"key")

        def run(command, _timeout):
            output = Path(command[command.index("--out") + 1])
            output.write_bytes(b"signed")
            Path(str(output) + ".idsig").write_bytes(b"idsig")
            return 0, "signed", ""

        with patch.object(artifacts.android, "tool", side_effect=lambda name, _settings: "/tools/apksigner" if name == "apksigner" else None), patch.object(artifacts.android, "run", side_effect=run) as runner:
            result = artifacts.sign({}, {"files": [str(source)], "keystore": "release.jks", "store_password": "store", "key_password": "key"})

        command = runner.call_args.args[0]
        self.assertIn(["--v4-signing-enabled", "false"], [command[index:index + 2] for index in range(len(command) - 1)])
        output = self.apk_root / "source-release.apk"
        self.assertTrue(result["results"][0]["ok"])
        self.assertTrue(output.exists())
        self.assertFalse(Path(str(output) + ".idsig").exists())


if __name__ == "__main__":
    unittest.main()
