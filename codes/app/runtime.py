"""源码运行与桌面打包共用的程序资源、用户数据路径。"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

from . import proc


APP_NAME = "GlacienWorkbench"


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def source_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resource_root() -> Path:
    """返回只读程序资源根目录，兼容源码、PyInstaller onefile 和 macOS Bundle。"""
    candidates = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(Path(bundle_root))
    executable = Path(sys.executable).resolve()
    candidates.extend((
        executable.parent,
        executable.parent.parent / "Resources",
        source_root(),
    ))
    for candidate in candidates:
        if (candidate / "web" / "index.html").is_file() or (candidate / "codes" / "web" / "index.html").is_file():
            # macOS Bundle 的 Contents/Frameworks/web 可能是指向 Resources/web 的符号链接。
            # 统一返回真实路径，避免静态文件 containment 校验误判合法首页为越界。
            return candidate.resolve()
    return source_root()


def resource_path(relative: str) -> Path:
    root = resource_root()
    direct = root / relative
    if direct.exists():
        return direct.resolve()
    return (root / "codes" / relative).resolve()


def release_info() -> dict:
    """读取随程序分发的版本与本地更新记录。"""
    try:
        value = json.loads(resource_path("release.json").read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("release.json 必须是对象")
    except (OSError, ValueError, json.JSONDecodeError):
        return {"version": "0.3.6", "releases": []}
    version = str(value.get("version", "")).strip() or "0.3.6"
    releases = []
    for item in value.get("releases", []):
        if not isinstance(item, dict):
            continue
        changes = item.get("changes", [])
        if not isinstance(changes, list):
            continue
        releases.append({
            "version": str(item.get("version", "")).strip(),
            "date": str(item.get("date", "")).strip(),
            "title": str(item.get("title", "")).strip(),
            "changes": [str(change).strip() for change in changes if str(change).strip()],
        })
    return {"version": version, "releases": releases}


def release_version() -> str:
    return release_info()["version"]


def user_guide_markdown() -> str:
    """读取随程序分发的用户须知 Markdown。"""
    path = resource_path("用户须知.md")
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"无法读取用户须知：{error}") from error


def data_root() -> Path:
    """源码与打包版统一使用系统标准可写目录。"""
    override = os.environ.get("GLACIEN_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if system == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        return Path(base) / APP_NAME if base else Path.home() / "AppData" / "Local" / APP_NAME
    base = os.environ.get("XDG_DATA_HOME", "").strip()
    return (Path(base).expanduser() if base else Path.home() / ".local" / "share") / APP_NAME


def web_profile_root() -> Path:
    from . import storage
    return storage.data_dir("runtime", "web-profile")


def reveal_directory(directory: Path, label: str = "目录") -> dict:
    """用当前系统文件管理器打开已由业务层验证的目录。"""
    system = platform.system().lower()
    if system == "darwin":
        args = ["open", str(directory)]
    elif system == "windows":
        args = ["explorer", str(directory)]
    else:
        args = ["xdg-open", str(directory)]
    try:
        result = proc.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "directory": str(directory), "error": f"打开{label}超时"}
    except OSError as error:
        return {"ok": False, "directory": str(directory), "error": f"无法打开{label}：{error}"}
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or f"系统命令退出码 {result.returncode}"
        return {"ok": False, "directory": str(directory), "error": message}
    return {"ok": True, "directory": str(directory)}


def reveal_data_root() -> dict:
    """用当前系统文件管理器打开用户数据根目录。"""
    directory = data_root()
    directory.mkdir(parents=True, exist_ok=True)
    return reveal_directory(directory, "用户数据目录")
