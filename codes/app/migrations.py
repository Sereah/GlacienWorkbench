"""各稳定存储域的逐版本数据迁移。

迁移函数只能修改所属域的数据结构，必须保持可重复执行，并由 storage 在备份后调用。
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import uuid


def _legacy_command_id(name: str, command: object) -> str:
    """为既有命令生成跨设备一致的 ID，便于旧数据首次导入时去重。"""
    identity = {
        "name": str(name),
        "category": str(command.get("category", "")) if isinstance(command, dict) else "",
        "command": str(command.get("command", "")) if isinstance(command, dict) else "",
    }
    digest = hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:24]
    return f"cmd_{digest}"


def _commands_v1_to_v2(value: dict) -> dict:
    commands = value.get("commands", {})
    if not isinstance(commands, dict):
        raise ValueError("commands.commands 必须是对象")
    migrated = {}
    for name, command in commands.items():
        if not isinstance(command, dict):
            raise ValueError(f"命令格式无效：{name}")
        migrated[name] = {"id": command.get("id") or _legacy_command_id(name, command), **command}
    return {**value, "commands": migrated}


def _legacy_launch_command(package: str, config: object) -> str:
    """将旧版拆分启动入口转换成新的设备端命令。"""
    if not isinstance(config, dict):
        return ""
    existing = str(config.get("command", "")).strip()
    if existing:
        return existing
    args = ["am", "start"]
    action = str(config.get("action", "")).strip()
    component = str(config.get("component", "")).strip()
    activity = str(config.get("activity", "")).strip()
    if action:
        args.extend(("-a", action))
    if component:
        args.extend(("-n", component))
    elif activity:
        args.extend(("-n", activity if "/" in activity else f"{package}/{activity}"))
    for extra in config.get("extras", []):
        if not isinstance(extra, dict):
            continue
        key = str(extra.get("key", "")).strip()
        value = str(extra.get("value", ""))
        option = {"string": "--es", "int": "--ei", "long": "--el", "bool": "--ez", "float": "--ef"}.get(extra.get("type", "string"))
        if key and option:
            args.extend((option, key, value))
    return shlex.join(args) if len(args) > 2 else ""


def _processes_v1_to_v2(value: dict) -> dict:
    launches = value.get("app_launches", {})
    if not isinstance(launches, dict):
        raise ValueError("processes.app_launches 必须是对象")
    migrated = {
        package: {"command": _legacy_launch_command(str(package), config)}
        for package, config in launches.items()
    }
    return {**value, "app_launches": migrated}


def _offline_logs_v1_to_v2(value: dict) -> dict:
    """保留现有目录来源；v2 将同一绝对路径字段扩展为文件或目录。"""
    sources = value.get("offline_log_sources", {})
    if not isinstance(sources, dict):
        raise ValueError("offline_logs.offline_log_sources 必须是对象")
    return value


def _legacy_offline_source_id(name: str, path: object) -> str:
    identity = json.dumps({"name": str(name), "path": str(path)}, ensure_ascii=False, sort_keys=True)
    return "legacy_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def _offline_logs_v2_to_v3(value: dict) -> dict:
    """旧来源只转换为 legacy 记录，不在 JSON 迁移中移动用户日志文件。"""
    sources = value.get("offline_log_sources", {})
    if not isinstance(sources, dict):
        raise ValueError("offline_logs.offline_log_sources 必须是对象")
    migrated = {}
    for name, raw in sources.items():
        if isinstance(raw, dict):
            migrated[str(name)] = raw
            continue
        migrated[str(name)] = {
            "id": _legacy_offline_source_id(str(name), raw),
            "path": str(raw),
            "managed": False,
            "legacy": True,
            "original_path": str(raw),
            "description": "",
            "ignored_archives": [],
        }
    return {**value, "offline_log_sources": migrated}


def _offline_logs_v3_to_v4(value: dict) -> dict:
    """新增按日志来源保存的分析快照，旧数据默认没有来源级覆盖。"""
    sessions = value.get("offline_source_presets", {})
    if sessions is not None and not isinstance(sessions, dict):
        raise ValueError("offline_logs.offline_source_presets 必须是对象")
    return {**value, "offline_source_presets": sessions or {}}


def _normalize_offline_preset(raw: object) -> dict:
    modes = {"include_any", "include_all", "exclude_any"}
    source = {"filters": raw} if isinstance(raw, list) else raw if isinstance(raw, dict) else {}
    filters = []
    for item in source.get("filters", []) if isinstance(source.get("filters", []), list) else []:
        if not isinstance(item, dict):
            continue
        terms = [str(term).strip() for term in item.get("terms", []) if str(term).strip()] if isinstance(item.get("terms"), list) else []
        if terms:
            filters.append({"mode": item.get("mode") if item.get("mode") in modes else "include_any", "terms": terms})
    constraints = []
    for item in source.get("priority_constraints", []) if isinstance(source.get("priority_constraints", []), list) else []:
        if not isinstance(item, dict):
            continue
        term, priority = str(item.get("term", "")).strip(), str(item.get("minimum_priority", "")).strip().upper()
        if term and priority in {"V", "D", "I", "W", "E", "F", "A"}:
            constraints.append({"term": term, "minimum_priority": priority})
    highlights = {}
    raw_highlights = source.get("highlights", {})
    if isinstance(raw_highlights, dict):
        for color in ("violet", "cyan", "green", "yellow", "orange", "red"):
            terms = [str(term).strip() for term in raw_highlights.get(color, []) if str(term).strip()] if isinstance(raw_highlights.get(color), list) else []
            if terms:
                highlights[color] = terms
    return {"filters": filters, "priority_constraints": constraints, "highlights": highlights, "highlight_case_sensitive": bool(source.get("highlight_case_sensitive"))}


def _normalize_offline_source_preset(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    preset = _normalize_offline_preset(raw)
    return {
        **preset,
        "source_name": str(raw.get("source_name", "")).strip(),
        "base_preset": str(raw.get("base_preset", "")).strip(),
        "updated_at": str(raw.get("updated_at", "")).strip(),
    }


def normalize(feature: str, value: dict) -> dict:
    """修复当前 schema 下可安全补齐的字段，不改变既有业务含义。"""
    if feature == "offline_logs":
        sources = value.get("offline_log_sources", {})
        if not isinstance(sources, dict):
            raise ValueError("offline_logs.offline_log_sources 必须是对象")
        normalized = {}
        for name, raw in sources.items():
            clean_name = str(name).strip()
            if not clean_name:
                continue
            if isinstance(raw, dict):
                source = dict(raw)
                source["id"] = str(source.get("id") or _legacy_offline_source_id(clean_name, source.get("path", "")))
                source["managed"] = bool(source.get("managed"))
                source["description"] = str(source.get("description", ""))
                source["ignored_archives"] = source.get("ignored_archives") if isinstance(source.get("ignored_archives"), list) else []
                normalized[clean_name] = source
            else:
                normalized[clean_name] = {
                    "id": _legacy_offline_source_id(clean_name, raw),
                    "path": str(raw),
                    "managed": False,
                    "legacy": True,
                    "original_path": str(raw),
                    "description": "",
                    "ignored_archives": [],
                }
        sessions = value.get("offline_source_presets", {})
        if not isinstance(sessions, dict):
            raise ValueError("offline_logs.offline_source_presets 必须是对象")
        normalized_sessions = {}
        for source_id, raw in sessions.items():
            clean_id = str(source_id).strip()
            session = _normalize_offline_source_preset(raw)
            if clean_id and session:
                normalized_sessions[clean_id] = session
        return {**value, "offline_log_sources": normalized, "offline_source_presets": normalized_sessions}
    if feature == "processes":
        launches = value.get("app_launches", {})
        if not isinstance(launches, dict):
            raise ValueError("processes.app_launches 必须是对象")
        watched = value.get("watched_packages", [])
        if not isinstance(watched, list):
            raise ValueError("processes.watched_packages 必须是数组")
        watched_packages = []
        for raw_package in watched:
            package = str(raw_package).strip()
            if package and re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*", package) and package not in watched_packages:
                watched_packages.append(package)
        normalized = {}
        for package, raw in launches.items():
            if not isinstance(raw, dict):
                raise ValueError(f"拉起配置格式无效：{package}")
            command = _legacy_launch_command(str(package), raw)
            retained = {key: item for key, item in raw.items() if key not in {"action", "component", "activity", "extras"}}
            normalized[package] = {**retained, "command": command}
        return {**value, "watched_packages": watched_packages, "app_launches": normalized}
    if feature != "commands":
        return value
    commands = value.get("commands", {})
    if not isinstance(commands, dict):
        raise ValueError("commands.commands 必须是对象")
    normalized = {}
    used_ids = set()
    for name, raw in commands.items():
        if not isinstance(raw, dict):
            raise ValueError(f"命令格式无效：{name}")
        command = dict(raw)
        command_id = str(command.get("id", "")).strip()
        if not command_id or command_id in used_ids:
            command_id = _legacy_command_id(name, command)
            while command_id in used_ids:
                command_id = f"cmd_{uuid.uuid4().hex}"
        command["id"] = command_id
        used_ids.add(command_id)
        normalized[name] = command
    return {**value, "commands": normalized}


MIGRATIONS = {
    "commands": {1: _commands_v1_to_v2},
    "processes": {1: _processes_v1_to_v2},
    "offline_logs": {1: _offline_logs_v1_to_v2, 2: _offline_logs_v2_to_v3, 3: _offline_logs_v3_to_v4},
}


def migrate(feature: str, value: dict, source_version: int, target_version: int) -> dict:
    current = dict(value)
    version = source_version
    while version < target_version:
        migration = MIGRATIONS.get(feature, {}).get(version)
        if migration is None:
            raise ValueError(f"{feature} 缺少 schema v{version} -> v{version + 1} 迁移")
        current = migration(current)
        version += 1
        current["schema_version"] = version
    return normalize(feature, current)
