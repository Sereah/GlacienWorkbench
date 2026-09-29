#!/usr/bin/env python3
"""将 Linux 桌面产物封装为可解析系统依赖的 Debian 软件包。"""

from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGING_ROOT = ROOT / "codes" / "packaging" / "linux"
ICON = ROOT / "assets" / "glacien.svg"
RELEASE_FILE = ROOT / "release.json"
OUTPUT_ROOT = ROOT / "release-output"
CONTROL_TEMPLATE = PACKAGING_ROOT / "control.template"
DEPENDENCIES_FILE = PACKAGING_ROOT / "dependencies.txt"
DESKTOP_FILE = PACKAGING_ROOT / "glacien-workbench.desktop"
PACKAGE_NAME = "glacien-workbench"
DEPENDENCY_PATTERN = re.compile(
    r"^[a-z0-9][a-z0-9+.-]*(?:\s*\((?:<<|<=|=|>=|>>)\s*[0-9A-Za-z.+:~-]+\))?$"
)


def read_release_version(path: Path = RELEASE_FILE) -> str:
    """读取并校验 Debian 可接受的发布版本。"""
    try:
        version = str(json.loads(path.read_text(encoding="utf-8"))["version"]).strip()
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"无法读取发布版本：{error}") from error
    if not version or not re.fullmatch(r"[0-9A-Za-z.+:~\-]+", version):
        raise SystemExit(f"release.json 中的版本不适用于 Debian 软件包：{version!r}")
    return version


def desktop_executable_path(version: str) -> Path:
    """返回当前版本的 Linux 桌面可执行文件。"""
    return ROOT / "dist" / f"Glacien-{version}"


def read_dependencies(path: Path = DEPENDENCIES_FILE) -> list[str]:
    """读取每行一个的 Debian 依赖，拒绝可能破坏 control 格式的内容。"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise SystemExit(f"无法读取 Linux 依赖配置：{error}") from error
    dependencies: list[str] = []
    for line_number, raw_line in enumerate(lines, start=1):
        dependency = raw_line.strip()
        if not dependency or dependency.startswith("#"):
            continue
        if not DEPENDENCY_PATTERN.fullmatch(dependency):
            raise SystemExit(f"Linux 依赖配置第 {line_number} 行格式无效：{dependency}")
        if dependency not in dependencies:
            dependencies.append(dependency)
    if not dependencies:
        raise SystemExit("Linux 依赖配置不能为空")
    return dependencies


def detect_architecture() -> str:
    """使用目标 Linux 系统的 dpkg 架构名称。"""
    try:
        result = subprocess.run(
            ["dpkg", "--print-architecture"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("无法读取 dpkg 架构，请确认已安装 dpkg") from error
    architecture = result.stdout.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", architecture):
        raise SystemExit(f"dpkg 返回了无效架构：{architecture!r}")
    return architecture


def render_control(version: str, architecture: str, installed_size: int) -> str:
    """根据模板生成 Debian control 文件。"""
    try:
        content = CONTROL_TEMPLATE.read_text(encoding="utf-8")
    except OSError as error:
        raise SystemExit(f"无法读取 Debian control 模板：{error}") from error
    replacements = {
        "{{VERSION}}": version,
        "{{ARCHITECTURE}}": architecture,
        "{{INSTALLED_SIZE}}": str(installed_size),
        "{{DEPENDS}}": ", ".join(read_dependencies()),
    }
    for placeholder, value in replacements.items():
        content = content.replace(placeholder, value)
    if "{{" in content or "}}" in content:
        raise SystemExit("Debian control 模板中存在未替换的占位符")
    return content


def require_linux_tools() -> str:
    """限制在 Linux 打包，并返回 dpkg-deb 的绝对路径。"""
    if platform.system() != "Linux":
        raise SystemExit("DEB 只能在 Linux 系统构建")
    dpkg_deb = shutil.which("dpkg-deb")
    if not dpkg_deb:
        raise SystemExit("未找到 dpkg-deb，请先安装 dpkg")
    return dpkg_deb


def copy_package_files(package_root: Path, executable: Path) -> int:
    """复制应用、图标和菜单入口，并返回安装体积 KiB。"""
    for required in (executable, ICON, DESKTOP_FILE):
        if not required.is_file():
            raise SystemExit(f"缺少 DEB 打包文件：{required}")

    app_target = package_root / "opt" / "glacien-workbench" / "Glacien"
    icon_target = package_root / "usr" / "share" / "icons" / "hicolor" / "scalable" / "apps" / "glacien-workbench.svg"
    desktop_target = package_root / "usr" / "share" / "applications" / "glacien-workbench.desktop"
    for target in (app_target, icon_target, desktop_target):
        target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(executable, app_target)
    shutil.copy2(ICON, icon_target)
    shutil.copy2(DESKTOP_FILE, desktop_target)
    app_target.chmod(0o755)
    icon_target.chmod(0o644)
    desktop_target.chmod(0o644)
    total_bytes = sum(path.stat().st_size for path in (app_target, icon_target, desktop_target))
    return max(1, (total_bytes + 1023) // 1024)


def build_deb() -> Path:
    """创建 release-output 下的 DEB 安装包。"""
    dpkg_deb = require_linux_tools()
    version = read_release_version()
    executable = desktop_executable_path(version)
    architecture = detect_architecture()
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_ROOT / f"{PACKAGE_NAME}_{version}_{architecture}.deb"

    with tempfile.TemporaryDirectory(prefix="glacien-deb-") as temporary_directory:
        package_root = Path(temporary_directory) / PACKAGE_NAME
        control_directory = package_root / "DEBIAN"
        control_directory.mkdir(parents=True)
        installed_size = copy_package_files(package_root, executable)
        control = control_directory / "control"
        control.write_text(render_control(version, architecture, installed_size), encoding="utf-8")
        control.chmod(0o644)
        subprocess.run(
            [dpkg_deb, "--root-owner-group", "--build", str(package_root), str(output)],
            cwd=ROOT,
            check=True,
        )
    return output


def main() -> None:
    output = build_deb()
    print(f"DEB 构建完成：{output}")
    print(f"运行依赖配置：{DEPENDENCIES_FILE}")


if __name__ == "__main__":
    main()
