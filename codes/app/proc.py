"""跨平台子进程入口。

桌面打包为 --windowed（无控制台）进程：在 Windows 上直接 subprocess.run/Popen
外部控制台程序（adb/rg/ffmpeg 等）会为每个子进程新开一个可见命令行窗口，
一闪而过。统一从这里启动子进程，Windows 下自动附加 CREATE_NO_WINDOW 隐藏窗口，
其它平台行为与 subprocess 一致。
"""
from __future__ import annotations

import subprocess
import sys


def _creation_flags() -> int:
    """Windows 下返回隐藏控制台标志，其它平台返回 0。"""
    if sys.platform == "win32":
        return subprocess.CREATE_NO_WINDOW
    return 0


def run(*args, **kwargs):
    """subprocess.run 的包装：Windows 下附加 CREATE_NO_WINDOW。"""
    if sys.platform == "win32":
        kwargs.setdefault("creationflags", _creation_flags())
    return subprocess.run(*args, **kwargs)


def Popen(*args, **kwargs):
    """subprocess.Popen 的包装：Windows 下附加 CREATE_NO_WINDOW。"""
    if sys.platform == "win32":
        kwargs.setdefault("creationflags", _creation_flags())
    return subprocess.Popen(*args, **kwargs)
