#!/usr/bin/env python3
"""在当前操作系统构建 Glacien 桌面应用。"""

from __future__ import annotations

import argparse
import json
import os
import platform
import plistlib
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
        return str(json.loads((ROOT / "release.json").read_text(encoding="utf-8"))["version"])
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"无法读取 release.json 版本：{error}") from error


def build(clean: bool) -> Path:
    started_at = time.perf_counter()
    require_modules()
    icon = generate_icon()
    system = platform.system()
    if system not in {"Darwin", "Windows", "Linux"}:
        raise SystemExit(f"不支持的构建平台：{system}")
    if clean:
        shutil.rmtree(BUILD_ROOT / "work", ignore_errors=True)
        output = DIST_ROOT / (f"{APP_NAME}.app" if system == "Darwin" else (f"{APP_NAME}.exe" if system == "Windows" else APP_NAME))
        if output.is_dir():
            shutil.rmtree(output)
        elif output.exists():
            output.unlink()
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
    print(f"正在为 {system} {mode}构建 {APP_NAME} {release_version()}…", flush=True)
    environment = os.environ.copy()
    environment.setdefault("PYINSTALLER_CONFIG_DIR", str(BUILD_ROOT / "pyinstaller-cache"))
    run_stage("PyInstaller 构建", command, environment=environment)
    if system == "Darwin":
        output = DIST_ROOT / f"{APP_NAME}.app"
        plist_path = output / "Contents" / "Info.plist"
        with plist_path.open("rb") as stream:
            plist = plistlib.load(stream)
        plist["CFBundleIdentifier"] = APP_ID
        plist["CFBundleShortVersionString"] = release_version()
        plist["CFBundleVersion"] = release_version()
        with plist_path.open("wb") as stream:
            plistlib.dump(plist, stream)
        run_stage(
            "macOS 临时签名",
            ["codesign", "--force", "--deep", "--sign", "-", str(output)],
        )
        auxiliary = DIST_ROOT / APP_NAME
        if auxiliary.is_dir():
            shutil.rmtree(auxiliary)
    else:
        output = DIST_ROOT / (f"{APP_NAME}.exe" if system == "Windows" else APP_NAME)
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
