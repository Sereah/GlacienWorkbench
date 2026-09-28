import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "codes" / "package_linux_deb.py"
SPEC = importlib.util.spec_from_file_location("package_linux_deb", MODULE_PATH)
package_linux_deb = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(package_linux_deb)


class LinuxDebPackageTest(unittest.TestCase):
    def test_desktop_entry_matches_linux_window_identity(self):
        desktop_file = (
            Path(__file__).resolve().parents[1]
            / "codes"
            / "packaging"
            / "linux"
            / "glacien-workbench.desktop"
        )
        content = desktop_file.read_text(encoding="utf-8")

        self.assertIn("Icon=glacien-workbench\n", content)
        self.assertIn("StartupWMClass=Glacien\n", content)

    def test_reads_dependencies_and_ignores_comments_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dependencies.txt"
            path.write_text(
                "# Qt runtime\nlibxcb-cursor0\nlibxkbcommon-x11-0 (>= 1.0)\nlibxcb-cursor0\n",
                encoding="utf-8",
            )

            self.assertEqual(
                package_linux_deb.read_dependencies(path),
                ["libxcb-cursor0", "libxkbcommon-x11-0 (>= 1.0)"],
            )

    def test_rejects_invalid_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dependencies.txt"
            path.write_text("libxcb-cursor0\nInjected: value\n", encoding="utf-8")

            with self.assertRaises(SystemExit):
                package_linux_deb.read_dependencies(path)

    def test_reads_release_version(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.json"
            path.write_text('{"version": "1.2.3"}', encoding="utf-8")

            self.assertEqual(package_linux_deb.read_release_version(path), "1.2.3")


if __name__ == "__main__":
    unittest.main()
