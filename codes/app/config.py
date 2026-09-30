"""聚合各功能域配置，并负责从旧 settings 一次性迁移。"""

from __future__ import annotations

import json
import platform
import hashlib
import re
import uuid
from pathlib import Path, PurePosixPath

from . import runtime, storage


ROOT = storage.ROOT
TARGET_ROOT = storage.data_dir("apk_center", "files")
RESOURCE_ROOT = storage.data_dir("resources", "files")
KEYSTORE_ROOT = storage.data_dir("signing", "keystores")
MIGRATION_MARKER = ROOT / ".storage-v2"

DEFAULT_APP = storage.default("app")
DEFAULTS = {
    feature: storage.default(feature) for feature in ("adb", "apk_center", "resources", "signing", "processes", "broadcasts", "live_logs", "offline_logs", "audio_processing", "device_logs", "commands", "captures", "themes")
}
DOMAIN_FIELDS = {
    "app": {"port"},
    "adb": {"sdk_root"},
    "apk_center": {"apk_sources", "apk_push_device_paths"},
    "signing": {"signing"},
    "resources": {"resource_device_paths"},
    "processes": {"process_package_keywords", "watched_packages", "app_launches"},
    "broadcasts": {"broadcasts"},
    "live_logs": {"log_filters"},
    "offline_logs": {"offline_filter_presets", "offline_log_sources"},
    "audio_processing": {"ffmpeg_path", "audio_sample_format", "audio_sample_rate", "audio_channels"},
    "device_logs": {"device_log_sources"},
    "commands": {"adb_commands", "adb_command_categories"},
    "captures": {"scrcpy_path"},
    "themes": {"selected_theme"},
}


def _legacy_settings() -> dict:
    candidates = []
    legacy_roots = [ROOT]
    source_root = runtime.source_root()
    if source_root != ROOT:
        legacy_roots.append(source_root)
    for legacy_root in legacy_roots:
        active = legacy_root / "active_settings.json"
        try:
            chosen = json.loads(active.read_text(encoding="utf-8")).get("active_file", "")
            if chosen and Path(chosen).name == chosen:
                candidates.append(legacy_root / chosen)
        except (OSError, json.JSONDecodeError):
            pass
        candidates.append(legacy_root / "settings.json")
    candidates.append(runtime.resource_path("defaults.json"))
    for candidate in candidates:
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                return value
        except (OSError, json.JSONDecodeError):
            continue
    return {}


def _legacy_values(value: dict) -> dict:
    profiles = value.get("profiles", {}) if isinstance(value.get("profiles", {}), dict) else {}
    old_profiles = [item for item in profiles.values() if isinstance(item, dict)]
    keywords = value.get("process_package_keywords")
    if keywords is None:
        keywords = [word for item in old_profiles for word in item.get("package_keywords", [])]
    push_paths = value.get("apk_push_device_paths") or next((item.get("apk_push_device_paths") for item in old_profiles if item.get("apk_push_device_paths")), {})
    return {
        "app": {**DEFAULT_APP, "port": value.get("port", 8910)},
        "adb": {**DEFAULTS["adb"], "sdk_root": value.get("sdk_root", "")},
        "apk_center": {**DEFAULTS["apk_center"], "apk_sources": value.get("apk_sources", {}), "apk_push_device_paths": push_paths or {}},
        "resources": {**DEFAULTS["resources"], "resource_device_paths": value.get("resource_device_paths", {})},
        "signing": {**DEFAULTS["signing"], **value.get("signing", {})},
        "processes": {**DEFAULTS["processes"], "process_package_keywords": keywords or [], "watched_packages": value.get("watched_packages", []), "app_launches": value.get("app_launches", {})},
        "broadcasts": {**DEFAULTS["broadcasts"], "broadcasts": value.get("broadcasts", {})},
        "live_logs": {**DEFAULTS["live_logs"], "log_filters": value.get("log_filters", {})},
        "offline_logs": {**DEFAULTS["offline_logs"], "offline_filter_presets": value.get("offline_filter_presets", {}), "offline_log_sources": value.get("offline_log_sources", {})},
        "audio_processing": DEFAULTS["audio_processing"],
        "device_logs": {**DEFAULTS["device_logs"], "device_log_sources": value.get("device_log_sources", {})},
        "commands": {**DEFAULTS["commands"], "categories": value.get("adb_command_categories", []), "commands": value.get("adb_commands", {})},
        "captures": {**DEFAULTS["captures"], "scrcpy_path": value.get("scrcpy_path", "")},
    }


def _migrate_legacy_files() -> None:
    roots = [ROOT]
    if runtime.source_root() != ROOT:
        roots.append(runtime.source_root())
    for legacy_root in roots:
        old_target = legacy_root / "target"
        if old_target.is_dir() and old_target != TARGET_ROOT:
            for item in old_target.rglob("*"):
                if item.is_file() and not item.is_symlink():
                    if item.suffix.lower() == ".apk":
                        storage.migrate_file(item, TARGET_ROOT / item.name)
                    elif item.name.endswith(".tar.gz"):
                        storage.migrate_file(item, RESOURCE_ROOT / item.name)
        old_keystore = legacy_root / "keystore"
        if old_keystore.is_dir() and old_keystore != KEYSTORE_ROOT:
            for item in old_keystore.iterdir():
                if item.suffix.lower() in {".jks", ".keystore"}:
                    storage.migrate_file(item, KEYSTORE_ROOT / item.name)
        old_logs = legacy_root / "logs" / "device-pulls"
        if old_logs.is_dir():
            legacy_pull_root = storage.downloads_dir() / "GlacienWorkbench" / "device-logs" / "legacy"
            for item in old_logs.rglob("*"):
                if item.is_file() and not item.is_symlink():
                    storage.migrate_file(item, legacy_pull_root / item.relative_to(old_logs))
        old_downloads = legacy_root / "downloads" / "device-explorer"
        if old_downloads.is_dir():
            for item in old_downloads.rglob("*"):
                if item.is_file() and not item.is_symlink():
                    storage.migrate_file(item, storage.data_dir("device_files", "downloads") / item.relative_to(old_downloads))


def _ensure_current_configs(values: dict) -> None:
    """每次启动补齐当前注册功能，新增功能不依赖历史迁移标记。"""
    for feature, default in storage.config_defaults().items():
        if storage.path(feature).exists():
            storage.read(feature, default)
        else:
            storage.write(feature, values.get(feature, default))


def migrate() -> None:
    storage.initialize()
    values = _legacy_values(_legacy_settings())
    _ensure_current_configs(values)
    if MIGRATION_MARKER.exists():
        return
    _migrate_legacy_files()
    MIGRATION_MARKER.write_text("storage-v2\n", encoding="utf-8")


def _resource_paths(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("resource_device_paths 必须是对象")
    result = {}
    for raw_name, raw_path in value.items():
        name, path = str(raw_name).strip(), str(raw_path).strip()
        if Path(name).name != name or not name.endswith(".tar.gz"):
            raise ValueError("资源路径映射必须使用 .tar.gz 文件名")
        if not path.startswith("/") or path == "/" or any(ord(char) in (0, 10, 13) for char in path):
            raise ValueError(f"{name} 的资源部署路径必须是非根设备绝对目录")
        if any(part in {".", ".."} for part in path.split("/")):
            raise ValueError(f"{name} 的资源部署路径不能包含 . 或 ..")
        result[name] = str(PurePosixPath(path))
    return result


def load() -> dict:
    migrate()
    app = storage.read("app", DEFAULT_APP.copy())
    adb = storage.read("adb", DEFAULTS["adb"].copy())
    apk = storage.read("apk_center", DEFAULTS["apk_center"].copy())
    resources = storage.read("resources", DEFAULTS["resources"].copy())
    signing = storage.read("signing", DEFAULTS["signing"].copy())
    processes = storage.read("processes", DEFAULTS["processes"].copy())
    broadcasts = storage.read("broadcasts", DEFAULTS["broadcasts"].copy())
    live_logs = storage.read("live_logs", DEFAULTS["live_logs"].copy())
    offline_logs = storage.read("offline_logs", DEFAULTS["offline_logs"].copy())
    audio_processing = storage.read("audio_processing", DEFAULTS["audio_processing"].copy())
    device_logs = storage.read("device_logs", DEFAULTS["device_logs"].copy())
    commands = storage.read("commands", DEFAULTS["commands"].copy())
    captures = storage.read("captures", DEFAULTS["captures"].copy())
    themes = storage.read("themes", DEFAULTS["themes"].copy())
    return {
        "port": int(app.get("port", 8910)), "sdk_root": str(adb.get("sdk_root", "")),
        "apk_sources": apk.get("apk_sources", {}), "apk_push_device_paths": apk.get("apk_push_device_paths", {}),
        "resource_device_paths": _resource_paths(resources.get("resource_device_paths", {})),
        "signing": {"keystores": signing.get("keystores", {})},
        "process_package_keywords": processes.get("process_package_keywords", []), "watched_packages": processes.get("watched_packages", []), "app_launches": processes.get("app_launches", {}),
        "broadcasts": broadcasts.get("broadcasts", {}), "log_filters": live_logs.get("log_filters", {}),
        "offline_filter_presets": offline_logs.get("offline_filter_presets", {}), "offline_log_sources": offline_logs.get("offline_log_sources", {}),
        "ffmpeg_path": str(audio_processing.get("ffmpeg_path", "")),
        "audio_sample_format": str(audio_processing.get("sample_format", "s16le")),
        "audio_sample_rate": int(audio_processing.get("sample_rate", 48000)),
        "audio_channels": int(audio_processing.get("channels", 2)),
        "device_log_sources": device_logs.get("device_log_sources", {}),
        "adb_commands": commands.get("commands", {}), "adb_command_categories": commands.get("categories", []),
        "scrcpy_path": str(captures.get("scrcpy_path", "")),
        "selected_theme": str(themes.get("selected_theme", "")),
    }


def payload(settings: dict) -> dict:
    release = runtime.release_info()
    return {**settings, "_meta": {"platform": platform.system(), "version": release["version"], "releases": release["releases"], "data_root": str(ROOT), "app_config": str(storage.path("app"))}}


def save(settings: dict) -> dict:
    """阻止旧代码恢复全域覆盖保存。"""
    raise ValueError("聚合配置保存已停用，请使用 update_domain() 按稳定存储域保存")


def update_domain(feature: str, values: object) -> dict:
    """只更新一个稳定数据域，避免页面中的旧快照覆盖其他功能数据。"""
    allowed = DOMAIN_FIELDS.get(feature)
    if allowed is None:
        raise ValueError(f"未知或不可写的存储域：{feature}")
    if not isinstance(values, dict) or not values or not set(values).issubset(allowed):
        raise ValueError(f"{feature} 配置字段无效")
    updates = dict(values)
    if feature == "signing":
        updates = {"keystores": values.get("signing", {}).get("keystores", {})}
    elif feature == "commands":
        current = load()
        updates = {
            "commands": values.get("adb_commands", current.get("adb_commands", {})),
            "categories": values.get("adb_command_categories", current.get("adb_command_categories", [])),
        }
    elif feature == "audio_processing":
        field_names = {"audio_sample_format": "sample_format", "audio_sample_rate": "sample_rate", "audio_channels": "channels"}
        updates = {field_names.get(key, key): value for key, value in values.items()}
    elif feature == "themes":
        selected_theme = str(values.get("selected_theme", "")).strip()
        if selected_theme and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", selected_theme):
            raise ValueError("主题 ID 格式无效")
        updates = {"selected_theme": selected_theme}
    if feature == "resources" and "resource_device_paths" in updates:
        updates["resource_device_paths"] = _resource_paths(updates["resource_device_paths"])
    storage.update(feature, updates)
    return {"ok": True, "domain": feature, "config": payload(load())}


def shareable_payload(settings: dict) -> dict:
    return {
        "format": "glacien-rules-bundle",
        "schema_version": 2,
        "created_by_version": runtime.release_version(),
        "features": {
            "commands": {"schema_version": 2, "categories": settings.get("adb_command_categories", []), "commands": settings.get("adb_commands", {})},
            "broadcasts": {"schema_version": 1, "items": settings.get("broadcasts", {})},
            "live_logs": {"schema_version": 1, "presets": settings.get("log_filters", {})},
            "offline_logs": {"schema_version": 1, "presets": settings.get("offline_filter_presets", {})},
            "device_logs": {"schema_version": 1, "sources": settings.get("device_log_sources", {})},
        },
    }


def import_shared(value: object) -> dict:
    if not isinstance(value, dict) or value.get("format") != "glacien-rules-bundle":
        raise ValueError("不是有效的 Glacien 规则包")
    bundle_version = value.get("schema_version", 1)
    if bundle_version not in {1, 2}:
        raise ValueError(f"不支持规则包 schema v{bundle_version}")
    if bundle_version == 1:
        features = {
            "commands": {"schema_version": 1, "categories": value.get("command_categories", []), "commands": value.get("commands", {})},
            "broadcasts": {"schema_version": 1, "items": value.get("broadcasts", {})},
            "live_logs": {"schema_version": 1, "presets": value.get("live_log_presets", {})},
            "offline_logs": {"schema_version": 1, "presets": value.get("offline_log_presets", {})},
            "device_logs": {"schema_version": 1, "sources": value.get("device_log_sources", {})},
        }
    else:
        features = value.get("features", {})
        if not isinstance(features, dict):
            raise ValueError("规则包 features 必须是对象")
    settings = load()
    mappings = (("broadcasts", "items", "broadcasts"), ("live_logs", "presets", "log_filters"), ("offline_logs", "presets", "offline_filter_presets"), ("device_logs", "sources", "device_log_sources"))
    imported = {}
    for feature, source, target in mappings:
        section = features.get(feature, {})
        if not isinstance(section, dict):
            raise ValueError(f"{feature} 必须是对象")
        if section.get("schema_version", 1) != 1:
            raise ValueError(f"不支持 {feature} schema v{section.get('schema_version')}")
        incoming = section.get(source, {})
        if not isinstance(incoming, dict):
            raise ValueError(f"{feature}.{source} 必须是对象")
        merged = {**settings.get(target, {}), **incoming}
        update_domain(feature, {target: merged})
        settings[target] = merged
        imported[feature] = len(incoming)
    commands = features.get("commands", {"schema_version": 2, "categories": [], "commands": {}})
    if not isinstance(commands, dict):
        raise ValueError("commands 必须是对象")
    command_result = command_import({"schema_version": 2, **commands, "format": "glacien-commands"})
    imported["commands"] = command_result["added"]
    known = {"commands", "broadcasts", "live_logs", "offline_logs", "device_logs"}
    return {"imported": imported, "skipped_features": sorted(set(features) - known), "config": payload(load())}


def command_export() -> dict:
    settings = load()
    return {"format": "glacien-commands", "schema_version": 2, "categories": settings.get("adb_command_categories", []), "commands": settings.get("adb_commands", {})}


def _imported_command_id(name: str, command: dict) -> str:
    identity = {"name": name, "category": command["category"], "command": command["command"]}
    digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:24]
    return f"cmd_{digest}"


def command_import(value: object) -> dict:
    if not isinstance(value, dict) or value.get("format") != "glacien-commands" or value.get("schema_version") not in {1, 2}:
        raise ValueError("不是受支持的 Glacien 自定义命令 JSON")
    incoming_commands, incoming_categories = value.get("commands", {}), value.get("categories", [])
    if not isinstance(incoming_commands, dict) or not isinstance(incoming_categories, list) or not all(isinstance(item, str) for item in incoming_categories):
        raise ValueError("自定义命令 JSON 格式无效")
    settings = load()
    commands = dict(settings.get("adb_commands", {}))
    categories = list(settings.get("adb_command_categories", []))
    commands_by_id = {item.get("id"): name for name, item in commands.items() if isinstance(item, dict) and item.get("id")}
    added, skipped, renamed = 0, 0, {}
    for raw_name, raw_command in incoming_commands.items():
        name = str(raw_name).strip()
        if not name or not isinstance(raw_command, dict) or not str(raw_command.get("command", "")).strip():
            raise ValueError(f"导入命令格式无效：{raw_name}")
        command = {
            "category": str(raw_command.get("category", "未分类")).strip() or "未分类",
            "description": str(raw_command.get("description", "")).strip(),
            "command": str(raw_command["command"]).strip(),
            "timeout_seconds": max(1, min(300, int(raw_command.get("timeout_seconds", 30)))),
        }
        command["id"] = str(raw_command.get("id", "")).strip() or _imported_command_id(name, command)
        existing_name = commands_by_id.get(command["id"])
        if existing_name:
            existing = commands[existing_name]
            if existing == command:
                skipped += 1
                continue
            command["id"] = f"cmd_{uuid.uuid4().hex}"
        comparable = {key: item for key, item in command.items() if key != "id"}
        if any(
            isinstance(existing, dict)
            and {key: item for key, item in existing.items() if key != "id"} == comparable
            for existing in commands.values()
        ):
            skipped += 1
            continue
        destination = name
        if destination in commands:
            index = 1
            while destination in commands:
                suffix = "（导入）" if index == 1 else f"（导入 {index}）"
                destination = name + suffix
                index += 1
            renamed[name] = destination
        commands[destination] = command
        commands_by_id[command["id"]] = destination
        if command["category"] not in categories:
            categories.append(command["category"])
        added += 1
    for category in incoming_categories:
        clean = category.strip()
        if clean and clean not in categories:
            categories.append(clean)
    update_domain("commands", {"adb_commands": commands, "adb_command_categories": categories})
    return {"added": added, "skipped": skipped, "renamed": renamed, "config": payload(load())}
