import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "codes" / "build_desktop.py"
SPEC = importlib.util.spec_from_file_location("build_desktop", MODULE_PATH)
build_desktop = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(build_desktop)


class DesktopBuildTest(unittest.TestCase):
    def test_versioned_output_names_keep_platform_suffixes(self):
        self.assertEqual(build_desktop.build_output_path("Darwin", "1.2.3").name, "Glacien-1.2.3.app")
        self.assertEqual(build_desktop.build_output_path("Windows", "1.2.3").name, "Glacien-1.2.3.exe")
        self.assertEqual(build_desktop.build_output_path("Linux", "1.2.3").name, "Glacien-1.2.3")

    def test_publish_versioned_output_replaces_same_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "Glacien"
            target = root / "Glacien-1.2.3"
            source.write_text("new", encoding="utf-8")
            target.write_text("old", encoding="utf-8")

            output = build_desktop.publish_versioned_output(source, target)

            self.assertEqual(output, target)
            self.assertEqual(target.read_text(encoding="utf-8"), "new")
            self.assertFalse(source.exists())


if __name__ == "__main__":
    unittest.main()
