#!/usr/bin/env python3
"""在当前操作系统构建 Glacien 桌面应用。"""

from __future__ import annotations

import argparse
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_ROOT = ROOT / "build" / "desktop"
DIST_ROOT = ROOT / "dist"
GENERATED_ASSETS = BUILD_ROOT / "assets"
APP_NAME = "Glacien"
APP_ID = "com.glacien.workbench"
VERSION_PATTERN = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]*")


def run_stage(label: str, command: list[str], *, environment: dict[str, str] | None = None) -> None:
    """执行构建阶段并输出耗时。"""
    print(f"{label}…", flush=True)
    started_at = time.perf_counter()
    subprocess.run(command, cwd=ROOT, env=environment, check=True)
    print(f"{label}完成，耗时 {time.perf_counter() - started_at:.1f} 秒", flush=True)


def require_modules() -> None:
    missing = []
    for module, package in (("PySide6", "PySide6"), ("PyInstaller", "pyinstaller"), ("PIL", "Pillow")):
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    if missing:
        raise SystemExit(
            "缺少桌面构建依赖：" + ", ".join(missing)
            + "\n请先运行：python3 -m pip install -r requirements-desktop.txt"
        )


def draw_icon(size: int):
    from PIL import Image, ImageDraw

    scale = size / 512
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(112 * scale), fill=(35, 34, 74, 255))
    glyph = (235, 233, 255, 255)
    accent = (114, 215, 242, 255)
    ring_width = max(2, int(42 * scale))
    draw.arc(tuple(int(value * scale) for value in (98, 98, 404, 414)), start=38, end=326, fill=glyph, width=ring_width)
    draw.line([(int(283 * scale), int(259 * scale)), (int(391 * scale), int(259 * scale)), (int(391 * scale), int(342 * scale))], fill=glyph, width=ring_width, joint="curve")
    prompt_width = max(2, int(28 * scale))
    draw.line([(int(174 * scale), int(216 * scale)), (int(217 * scale), int(256 * scale)), (int(174 * scale), int(296 * scale))], fill=accent, width=prompt_width, joint="curve")
    draw.line([(int(239 * scale), int(303 * scale)), (int(307 * scale), int(303 * scale))], fill=accent, width=prompt_width)
    radius = max(1, int(13 * scale))
    center_x, center_y = int(391 * scale), int(342 * scale)
    draw.ellipse((center_x-radius, center_y-radius, center_x+radius, center_y+radius), fill=(168, 230, 207, 255))
    return image


def generate_icon() -> Path:
    GENERATED_ASSETS.mkdir(parents=True, exist_ok=True)
    system = platform.system()
    if system == "Windows":
        output = GENERATED_ASSETS / "glacien.ico"
        draw_icon(256).save(output, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        return output
    if system == "Darwin":
        output = GENERATED_ASSETS / "Glacien.icns"
        # Pillow 直接写入标准 ICNS，避免不同 macOS 版本的 iconutil 对 iconset 校验不一致。
        draw_icon(1024).save(output, format="ICNS", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
        return output
    output = GENERATED_ASSETS / "glacien.png"
    draw_icon(512).save(output)
    return output


def data_argument(source: Path, destination: str) -> str:
    separator = ";" if platform.system() == "Windows" else ":"
    return f"{source}{separator}{destination}"


def release_version() -> str:
    try:
        version = str(json.loads((ROOT / "release.json").read_text(encoding="utf-8"))["version"]).strip()
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"无法读取 release.json 版本：{error}") from error
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit(f"release.json 中的版本不适用于产物文件名：{version!r}")
    return version


def build_output_path(system: str, version: str | None = None) -> Path:
    """返回 PyInstaller 临时产物或带版本号的最终产物路径。"""
    name = APP_NAME if version is None else f"{APP_NAME}-{version}"
    if system == "Darwin":
        return DIST_ROOT / f"{name}.app"
    if system == "Windows":
        return DIST_ROOT / f"{name}.exe"
    return DIST_ROOT / name


def remove_output(path: Path) -> None:
    """只清理已确定的单个构建产物。"""
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def publish_versioned_output(source: Path, target: Path) -> Path:
    """将稳定内部名称的构建结果发布为带版本号的顶层产物。"""
    remove_output(target)
    source.replace(target)
    return target


def build(clean: bool) -> Path:
    started_at = time.perf_counter()
    require_modules()
    icon = generate_icon()
    system = platform.system()
    if system not in {"Darwin", "Windows", "Linux"}:
        raise SystemExit(f"不支持的构建平台：{system}")
    version = release_version()
    temporary_output = build_output_path(system)
    versioned_output = build_output_path(system, version)
    if clean:
        shutil.rmtree(BUILD_ROOT / "work", ignore_errors=True)
        remove_output(temporary_output)
        remove_output(versioned_output)
    command = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--windowed",
        "--name", APP_NAME,
        "--distpath", str(DIST_ROOT),
        "--workpath", str(BUILD_ROOT / "work"),
        "--specpath", str(BUILD_ROOT),
        "--icon", str(icon),
        "--add-data", data_argument(ROOT / "codes" / "web", "web"),
        "--add-data", data_argument(ROOT / "codes" / "用户须知.md", "."),
        "--add-data", data_argument(ROOT / "assets", "assets"),
        "--add-data", data_argument(ROOT / "defaults.json", "."),
        "--add-data", data_argument(ROOT / "release.json", "."),
    ]
    if clean:
        command.append("--clean")
    if system == "Darwin":
        command.extend(("--osx-bundle-identifier", APP_ID))
    if system in {"Windows", "Linux"}:
        command.append("--onefile")
    command.append(str(ROOT / "codes" / "desktop_launcher.py"))
    mode = "全量" if clean else "增量"
    print(f"正在为 {system} {mode}构建 {APP_NAME} {version}…", flush=True)
    environment = os.environ.copy()
    environment.setdefault("PYINSTALLER_CONFIG_DIR", str(BUILD_ROOT / "pyinstaller-cache"))
    run_stage("PyInstaller 构建", command, environment=environment)
    if system == "Darwin":
        plist_path = temporary_output / "Contents" / "Info.plist"
        with plist_path.open("rb") as stream:
            plist = plistlib.load(stream)
        plist["CFBundleIdentifier"] = APP_ID
        plist["CFBundleShortVersionString"] = version
        plist["CFBundleVersion"] = version
        with plist_path.open("wb") as stream:
            plistlib.dump(plist, stream)
        run_stage(
            "macOS 临时签名",
            ["codesign", "--force", "--deep", "--sign", "-", str(temporary_output)],
        )
        auxiliary = DIST_ROOT / APP_NAME
        if auxiliary.is_dir():
            shutil.rmtree(auxiliary)
    output = publish_versioned_output(temporary_output, versioned_output)
    print(f"桌面构建总耗时 {time.perf_counter() - started_at:.1f} 秒", flush=True)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean", action="store_true", help="清理缓存并执行全量构建")
    args = parser.parse_args()
    output = build(args.clean)
    print(f"构建完成：{output}")
    print("注意：PyInstaller 只能构建当前操作系统的产物，三端需分别运行本脚本。")


if __name__ == "__main__":
    main()
