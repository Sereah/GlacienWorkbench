#!/usr/bin/env python3
"""打包 Glacien 源码与默认种子配置，排除用户产物与密钥。"""

from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT.parent / "Glacien-Workbench.zip"

# defaults.json 是只读初始化种子；系统用户数据目录与构建产物不进入源码包。
EXCLUDED_DIRS = {
    "captures",
    "downloads",
    "logs",
    "target",
    "keystore",
    "apk-center",
    "resource-deployment",
    "signing",
    "processes",
    "broadcasts",
    "live-logs",
    "offline-logs",
    "device-logs",
    "device-files",
    "runtime",
    "local-tools",
    "adb-tools",
    ".glacien",
    "__pycache__",
    ".pytest_cache",
    ".desktop-build-venv",
    "build",
    "dist",
    "release-output",
}
EXCLUDED_FILES = {
    ".DS_Store",
    "active_settings.json",
    "settings.json",
    "settings.macos.json",
    "settings.windows.json",
    "settings.ubuntu.json",
}
EXCLUDED_SUFFIXES = {
    ".apk",
    ".apks",
    ".aab",
    ".tar",
    ".gz",
    ".zip",
    ".log",
    ".idsig",
    ".jks",
    ".keystore",
    ".pyc",
}


def should_include(path: Path) -> bool:
    """判断文件是否适合放入轻量分发包。"""
    relative = path.relative_to(ROOT)
    if any(part in EXCLUDED_DIRS for part in relative.parts[:-1]):
        return False
    return path.name not in EXCLUDED_FILES and path.suffix.lower() not in EXCLUDED_SUFFIXES


def create_package(output: Path) -> tuple[int, int]:
    """创建 ZIP，返回写入文件数量与总字节数。"""
    output.parent.mkdir(parents=True, exist_ok=True)
    count, size = 0, 0
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file() or not should_include(path):
                continue
            archive_path = Path(ROOT.name) / path.relative_to(ROOT)
            archive.write(path, archive_path)
            count += 1
            size += path.stat().st_size
    return count, size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT, help="输出 ZIP 路径")
    args = parser.parse_args()

    output = args.output.resolve()
    if output.exists():
        output.unlink()
    count, size = create_package(output)
    print(f"已生成：{output}")
    print(f"包含 {count} 个文件，源文件合计 {size / 1024:.1f} KiB")
    print("保留：只读 defaults.json；已排除：所有用户数据、构建产物与本机配置。")


if __name__ == "__main__":
    main()
