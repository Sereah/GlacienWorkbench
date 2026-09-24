#!/usr/bin/env python3
"""仅在桌面依赖清单变化时安装构建依赖。"""

from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / "requirements-desktop.txt"
STAMP = Path(sys.prefix) / "glacien-requirements.sha256"
REQUIRED_MODULES = ("PySide6", "PyInstaller", "PIL")


def requirements_digest() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def dependencies_are_current(digest: str) -> bool:
    try:
        stamp_matches = STAMP.read_text(encoding="utf-8").strip() == digest
    except FileNotFoundError:
        return False
    return stamp_matches and all(importlib.util.find_spec(module) is not None for module in REQUIRED_MODULES)


def main() -> None:
    digest = requirements_digest()
    if dependencies_are_current(digest):
        print("桌面构建依赖未变化，跳过安装。")
        return

    print("正在安装桌面构建依赖…", flush=True)
    started_at = time.perf_counter()
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)],
        cwd=ROOT,
        check=True,
    )
    STAMP.write_text(digest + "\n", encoding="utf-8")
    print(f"桌面构建依赖准备完成，耗时 {time.perf_counter() - started_at:.1f} 秒")


if __name__ == "__main__":
    main()
