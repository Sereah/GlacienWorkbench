"""用 Chromium 应用模式打开 Glacien，失败时回退到默认浏览器。"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import webbrowser
from pathlib import Path

from . import proc


MACOS_BROWSERS = (
    ("Google Chrome", Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    ("Microsoft Edge", Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")),
    ("Chromium", Path("/Applications/Chromium.app/Contents/MacOS/Chromium")),
)
WINDOWS_BROWSERS = (
    ("Google Chrome", "Google/Chrome/Application/chrome.exe"),
    ("Microsoft Edge", "Microsoft/Edge/Application/msedge.exe"),
)
LINUX_BROWSERS = (
    ("Google Chrome", "google-chrome"),
    ("Google Chrome", "google-chrome-stable"),
    ("Chromium", "chromium"),
    ("Chromium", "chromium-browser"),
    ("Microsoft Edge", "microsoft-edge"),
    ("Microsoft Edge", "microsoft-edge-stable"),
)


def _macos_candidates() -> list[tuple[str, Path]]:
    user_apps = Path.home() / "Applications"
    candidates = list(MACOS_BROWSERS)
    candidates.extend((name, user_apps / path.relative_to("/Applications")) for name, path in MACOS_BROWSERS)
    return candidates


def _windows_candidates() -> list[tuple[str, Path]]:
    roots = []
    for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        value = os.environ.get(variable)
        if value:
            roots.append(Path(value))
    return [(name, root / relative) for name, relative in WINDOWS_BROWSERS for root in roots]


def app_window_command(url: str) -> tuple[str, list[str]] | None:
    """返回首个可用 Chromium 浏览器及其应用窗口启动参数。"""
    system = platform.system()
    if system == "Darwin":
        candidates = _macos_candidates()
    elif system == "Windows":
        candidates = _windows_candidates()
    else:
        for name, executable in LINUX_BROWSERS:
            resolved = shutil.which(executable)
            if resolved:
                return name, [resolved, f"--app={url}"]
        return None

    for name, executable in candidates:
        if executable.is_file():
            return name, [str(executable), f"--app={url}"]
    return None


def open_app_window(url: str) -> str:
    """优先打开无地址栏的独立窗口，并返回实际使用的打开方式。"""
    command = app_window_command(url)
    if command:
        name, arguments = command
        try:
            proc.Popen(arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return f"{name} 独立窗口"
        except OSError:
            pass
    webbrowser.open(url)
    return "系统默认浏览器"
