"""Glacien 用户数据目录与功能域 JSON 的统一原子存储。"""

from __future__ import annotations

import json
import os
import platform
import shutil
import threading
from datetime import datetime
from pathlib import Path

from . import runtime


ROOT = runtime.data_root()
_LOCK = threading.RLock()
_MIGRATION_SESSION = datetime.now().strftime("%Y%m%d-%H%M%S-%f")

STORAGE_DOMAINS = {
    "app": {"config": "app/config.json", "default": {"storage_key": "app", "schema_version": 1, "port": 8910}, "directories": ()},
    "adb": {"config": "adb-tools/adb/config.json", "default": {"storage_key": "adb", "schema_version": 1, "sdk_root": ""}, "directories": ()},
    "apk_center": {"config": "adb-tools/apk-center/config.json", "default": {"storage_key": "apk_center", "schema_version": 1, "apk_sources": {}, "apk_push_device_paths": {}}, "directories": ("files",)},
    "signing": {"config": "adb-tools/apk-center/signing.json", "default": {"storage_key": "signing", "schema_version": 1, "keystores": {}}, "directories": ("keystores",)},
    "resources": {"config": "adb-tools/resource-deployment/config.json", "default": {"storage_key": "resources", "schema_version": 1, "resource_device_paths": {}}, "directories": ("files",)},
    "processes": {"config": "adb-tools/processes/config.json", "default": {"storage_key": "processes", "schema_version": 2, "process_package_keywords": [], "watched_packages": [], "app_launches": {}}, "directories": ()},
    "broadcasts": {"config": "adb-tools/broadcasts/presets.json", "default": {"storage_key": "broadcasts", "schema_version": 1, "broadcasts": {}}, "directories": ()},
    "live_logs": {"config": "adb-tools/live-logs/presets.json", "default": {"storage_key": "live_logs", "schema_version": 1, "log_filters": {}}, "directories": ("exports",)},
    "device_logs": {"config": "adb-tools/device-logs/sources.json", "default": {"storage_key": "device_logs", "schema_version": 1, "device_log_sources": {}}, "directories": ()},
    "commands": {"config": "adb-tools/commands/commands.json", "default": {"storage_key": "commands", "schema_version": 2, "categories": [], "commands": {}}, "directories": ()},
    "captures": {"config": "adb-tools/device-tools/config.json", "default": {"storage_key": "captures", "schema_version": 1, "scrcpy_path": ""}, "directories": ("screenshots", "recordings", "recording-covers")},
    "device_files": {"config": None, "root": "adb-tools/device-tools", "directories": ("downloads",)},
    "bugreports": {"config": None, "root": "adb-tools/bugreports", "directories": ("files", "runtime")},
    "offline_logs": {"config": "local-tools/offline-logs/config.json", "default": {"storage_key": "offline_logs", "schema_version": 2, "offline_filter_presets": {}, "offline_log_sources": {}}, "directories": ()},
    "audio_processing": {"config": "local-tools/audio-processing/config.json", "default": {"storage_key": "audio_processing", "schema_version": 1, "ffmpeg_path": "", "sample_format": "s16le", "sample_rate": 48000, "channels": 2}, "directories": ("inputs", "previews")},
    "themes": {"config": "runtime/themes.json", "default": {"storage_key": "themes", "schema_version": 1, "selected_theme": "", "themes": {}}, "directories": ()},
    "runtime": {"config": None, "root": "runtime", "directories": ("web-profile",)},
}


def initialize() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for definition in STORAGE_DOMAINS.values():
        config = definition.get("config")
        if config:
            (ROOT / config).parent.mkdir(parents=True, exist_ok=True)
        base = ROOT / definition.get("root", Path(config).parent if config else "")
        for relative in definition.get("directories", ()):
            (base / relative).mkdir(parents=True, exist_ok=True)


def path(feature: str) -> Path:
    try:
        relative = STORAGE_DOMAINS[feature]["config"]
    except KeyError as error:
        raise ValueError(f"未知数据域：{feature}") from error
    if not relative:
        raise ValueError(f"数据域没有配置文件：{feature}")
    return ROOT / relative


def default(feature: str) -> dict:
    try:
        value = STORAGE_DOMAINS[feature]["default"]
    except KeyError as error:
        raise ValueError(f"数据域没有默认配置：{feature}") from error
    # 经 JSON 往返生成深拷贝，调用方不能修改注册表中的嵌套默认值。
    return json.loads(json.dumps(value))


def config_defaults() -> dict[str, dict]:
    return {feature: default(feature) for feature, value in STORAGE_DOMAINS.items() if value.get("config")}


def _backup_before_migration(feature: str, item: Path) -> Path:
    destination = ROOT / "runtime" / "migration-backups" / _MIGRATION_SESSION / item.relative_to(ROOT)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(item, destination)
    return destination


def _normalize(feature: str, value: dict, item: Path) -> tuple[dict, bool]:
    from . import migrations

    expected = default(feature)
    expected_version = expected["schema_version"]
    stored_key = value.get("storage_key")
    if stored_key not in (None, feature):
        raise ValueError(f"{item.relative_to(ROOT)} 的 storage_key 应为 {feature}，实际为 {stored_key}")
    try:
        stored_version = int(value.get("schema_version", 1))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{item.relative_to(ROOT)} 的 schema_version 无效") from error
    if stored_version > expected_version:
        raise ValueError(
            f"{item.relative_to(ROOT)} 来自更高版本（schema v{stored_version}），"
            f"当前仅支持 v{expected_version}，已拒绝回写"
        )
    normalized = {**expected, **value, "storage_key": feature}
    if stored_version < expected_version:
        normalized = migrations.migrate(feature, normalized, stored_version, expected_version)
    normalized = migrations.normalize(feature, normalized)
    normalized["schema_version"] = expected_version
    return normalized, normalized != value


def read(feature: str, fallback):
    item = path(feature)
    if not item.is_file():
        return fallback
    try:
        value = json.loads(item.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取 {item.relative_to(ROOT)}：{error}") from error
    if not isinstance(value, type(fallback)):
        raise ValueError(f"{item.relative_to(ROOT)} 数据类型无效")
    if not isinstance(value, dict):
        return value
    with _LOCK:
        normalized, changed = _normalize(feature, value, item)
        if changed:
            _backup_before_migration(feature, item)
            write(feature, normalized)
        return normalized


def write(feature: str, value) -> None:
    if isinstance(value, dict):
        from . import migrations

        expected = default(feature)
        expected_version = expected["schema_version"]
        stored_key = value.get("storage_key")
        if stored_key not in (None, feature):
            raise ValueError(f"{feature} 写入数据的 storage_key 不匹配：{stored_key}")
        stored_version = int(value.get("schema_version", expected_version))
        if stored_version > expected_version:
            raise ValueError(f"{feature} 数据版本高于当前程序，已拒绝回写")
        value = {**default(feature), **value, "storage_key": feature}
        if stored_version < expected_version:
            value = migrations.migrate(feature, value, stored_version, expected_version)
        value["schema_version"] = expected_version
        value = migrations.normalize(feature, value)
    item = path(feature)
    item.parent.mkdir(parents=True, exist_ok=True)
    temporary = item.with_suffix(item.suffix + ".tmp")
    with _LOCK:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(item)


def update(feature: str, values: dict) -> dict:
    """在同一把锁内合并一个存储域，保留该域未来新增的未知字段。"""
    if not isinstance(values, dict):
        raise ValueError("配置更新内容必须是对象")
    with _LOCK:
        current = read(feature, default(feature))
        protected = {"storage_key", "schema_version"}
        merged = {**current, **{key: value for key, value in values.items() if key not in protected}}
        write(feature, merged)
        return merged


def data_dir(feature: str, name: str) -> Path:
    try:
        definition = STORAGE_DOMAINS[feature]
    except KeyError as error:
        raise ValueError(f"未知数据域：{feature}") from error
    directories = definition.get("directories", ())
    if name not in directories:
        raise ValueError(f"未知数据目录：{feature}.{name}")
    config = definition.get("config")
    base = ROOT / definition.get("root", Path(config).parent if config else "")
    item = base / name
    item.mkdir(parents=True, exist_ok=True)
    return item


def downloads_dir() -> Path:
    """返回当前系统的下载目录；Linux 尊重 XDG 用户目录配置。"""
    system = platform.system().lower()
    if system == "windows":
        try:
            import winreg

            key_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            expanded = os.path.expandvars(str(value)).strip()
            if expanded:
                return Path(expanded).expanduser()
        except (ImportError, OSError, ValueError):
            pass
    if system == "linux":
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        user_dirs = config_home / "user-dirs.dirs"
        try:
            for line in user_dirs.read_text(encoding="utf-8").splitlines():
                if not line.startswith("XDG_DOWNLOAD_DIR="):
                    continue
                value = line.split("=", 1)[1].strip().strip('\"').replace("$HOME", str(Path.home()))
                if value:
                    return Path(value).expanduser()
        except OSError:
            pass
    return Path.home() / "Downloads"


def migrate_file(source: Path, destination: Path) -> bool:
    """仅在目标不存在时迁移普通文件；冲突时保留旧文件供人工处理。"""
    if not source.is_file() or source.is_symlink() or destination.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return True
