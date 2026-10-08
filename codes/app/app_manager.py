"""已安装 Android 应用的列表、详情和受控管理操作。"""

from __future__ import annotations

import re

from . import android, device, device_files


PACKAGE_NAME = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")
PACKAGE_LINE = re.compile(r"^package:(?P<path>.+?)=(?P<package>[A-Za-z0-9_.]+)(?:\s+uid:(?P<uid>\d+(?:,\d+)*))?$")
PACKAGE_USER_LINE = re.compile(r"^\s*User (?P<user_id>\d+):\s*(?P<state>.*)$", re.MULTILINE)
USER_INFO_LINE = re.compile(r"UserInfo\{(?P<user_id>\d+):(?P<name>[^:]*):")
ENABLED_STATE = re.compile(r"^\s*enabled=(\d+)\s*$", re.MULTILINE)
FIRST_INSTALL = re.compile(r"^\s*firstInstallTime=(.*?)\s*$", re.MULTILINE)
LAST_UPDATE = re.compile(r"^\s*lastUpdateTime=(.*?)\s*$", re.MULTILINE)


def _package(value: object) -> str:
    package = str(value or "").strip()
    if not PACKAGE_NAME.fullmatch(package):
        raise ValueError("应用包名格式无效")
    return package


def _user_id(value: object) -> int:
    raw = str(value).strip()
    if isinstance(value, bool) or not re.fullmatch(r"\d{1,4}", raw):
        raise ValueError("Android User ID 无效")
    return int(raw)


def _command(settings: dict, *args: str, timeout: int = 30) -> str:
    code, output, error = android.device_adb(settings, *args, timeout=timeout)
    if code:
        raise ValueError(error or output or f"ADB 命令执行失败：{' '.join(args)}")
    return output


def _parse_running_processes(output: str, has_numeric_uid: bool) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = {}
    for line in output.splitlines()[1:]:
        columns = line.split()
        minimum_columns = 4 if has_numeric_uid else 2
        if len(columns) < minimum_columns:
            continue
        user, uid, pid = (columns[0], columns[1], columns[2]) if has_numeric_uid else (columns[0], "", columns[1])
        if not pid.isdigit() or (uid and not uid.isdigit()):
            continue
        name = columns[-1]
        package = name.split(":", 1)[0]
        if PACKAGE_NAME.fullmatch(package):
            user_id = str(int(uid) // 100000) if uid else ""
            result.setdefault(package, []).append({"user_id": user_id, "user": user, "uid": uid, "pid": pid, "name": name})
    return result


def _running_processes(settings: dict) -> dict[str, list[dict]]:
    code, output, _ = android.device_adb(settings, "shell", "ps", "-A", "-o", "USER,UID,PID,NAME", timeout=30)
    if code == 0:
        return _parse_running_processes(output, True)
    return _parse_running_processes(_command(settings, "shell", "ps", "-A"), False)


def _third_party_packages(settings: dict) -> set[str]:
    output = _command(settings, "shell", "pm", "list", "packages", "-3")
    return {line.removeprefix("package:").strip() for line in output.splitlines() if line.startswith("package:")}


def _parse_package_rows(output: str) -> list[dict]:
    rows = []
    for line in output.splitlines():
        match = PACKAGE_LINE.match(line.strip())
        if not match:
            continue
        rows.append({
            "package": match.group("package"),
            "apk_path": match.group("path"),
            "uid": match.group("uid") or "",
        })
    return rows


def applications(settings: dict) -> dict:
    """批量读取应用基础信息；不得在列表阶段逐包调用 dumpsys。"""
    rows = _parse_package_rows(_command(settings, "shell", "pm", "list", "packages", "-f", "-U"))
    third_party = _third_party_packages(settings)
    running = _running_processes(settings)
    launch_configs = device.launch_configs(settings)
    for row in rows:
        package = row["package"]
        row.update({
            "kind": "user" if package in third_party else "system",
            "running": package in running,
            "processes": running.get(package, []),
            "pids": [process["pid"] for process in running.get(package, [])],
            "launch_configured": package in launch_configs,
        })
    rows.sort(key=lambda item: (item["kind"] != "user", item["package"].lower()))
    return {"items": rows, "total": len(rows)}


def _match(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text or "")
    return match.group(1).strip() if match else ""


def _package_user_states(package_dump: str) -> list[dict]:
    users = []
    for match in PACKAGE_USER_LINE.finditer(package_dump or ""):
        values = dict(re.findall(r"([A-Za-z][A-Za-z0-9_]*)=([^\s]+)", match.group("state")))
        if values.get("installed") != "true":
            continue
        enabled_state = values.get("enabled", "0")
        users.append({
            "user_id": int(match.group("user_id")),
            "installed": True,
            "enabled_state": enabled_state,
            "enabled": enabled_state not in {"2", "3", "4"},
            "stopped": values.get("stopped") == "true",
        })
    return users


def _user_context(settings: dict, package_dump: str) -> list[dict]:
    users = _package_user_states(package_dump)
    if not users:
        return []
    _, user_output, _ = android.device_adb(settings, "shell", "pm", "list", "users", timeout=30)
    names = {
        int(match.group("user_id")): ("System" if match.group("user_id") == "0" and match.group("name") in {"", "null"} else match.group("name") or f"User {match.group('user_id')}")
        for match in USER_INFO_LINE.finditer(user_output)
    }
    _, current_output, _ = android.device_adb(settings, "shell", "am", "get-current-user", timeout=30)
    current_user = int(current_output.strip()) if current_output.strip().isdigit() else -1
    for user in users:
        user["name"] = names.get(user["user_id"], f"User {user['user_id']}")
        user["current"] = user["user_id"] == current_user
    return users


def _installed_user(settings: dict, package: str, user_value: object) -> tuple[int, str]:
    user_id = _user_id(user_value)
    package_dump = _command(settings, "shell", "dumpsys", "package", package, timeout=45)
    if user_id not in {user["user_id"] for user in _package_user_states(package_dump)}:
        raise ValueError(f"{package} 未安装在 User {user_id}")
    return user_id, package_dump


def details(settings: dict, package_value: object) -> dict:
    package = _package(package_value)
    package_dump = _command(settings, "shell", "dumpsys", "package", package, timeout=45)
    versions = device.package_version(package_dump)
    paths = device.installed_apk_paths(settings, package, package_dump)
    enabled = _match(ENABLED_STATE, package_dump)
    _, platform_dump, _ = android.device_adb(settings, "shell", "dumpsys", "package", "android", timeout=45)
    signature = android.signature(package_dump)
    platform_signature = android.signature(platform_dump)
    signature_status = "unknown" if not signature or not platform_signature else ("platform" if signature == platform_signature else "non_platform")
    processes = _running_processes(settings).get(package, [])
    return {
        "package": package,
        **versions,
        "uid": _match(re.compile(r"^\s*userId=(\d+)\s*$", re.MULTILINE), package_dump),
        "enabled_state": enabled or "0",
        "enabled": enabled not in {"2", "3", "4"},
        "first_install_time": _match(FIRST_INSTALL, package_dump),
        "last_update_time": _match(LAST_UPDATE, package_dump),
        "apk_paths": paths,
        "signature": signature,
        "signature_status": signature_status,
        "launch_configured": package in device.launch_configs(settings),
        "users": _user_context(settings, package_dump),
        "processes": processes,
    }


def launch(settings: dict, package_value: object, user_value: object) -> dict:
    package = _package(package_value)
    user_id, _ = _installed_user(settings, package, user_value)
    if package in device.launch_configs(settings):
        return device.launch(settings, package, user_id)
    output = _command(settings, "shell", "cmd", "package", "resolve-activity", "--brief", "--user", str(user_id), package)
    component = next((line.strip() for line in reversed(output.splitlines()) if "/" in line), "")
    if not component:
        raise ValueError("未找到可启动 Activity，请为该应用配置自定义拉起命令")
    code, stdout, error = android.device_adb(settings, "shell", "am", "start", "--user", str(user_id), "-n", component, timeout=30)
    return {"ok": code == 0, "output": stdout or error, "component": component, "user_id": user_id}


def stop(settings: dict, package_value: object, user_value: object) -> dict:
    package = _package(package_value)
    user_id, _ = _installed_user(settings, package, user_value)
    code, output, error = android.device_adb(settings, "shell", "am", "force-stop", "--user", str(user_id), package)
    return {"ok": code == 0, "output": output or error, "user_id": user_id}


def stop_all(settings: dict, package_value: object, confirmed: object) -> dict:
    package = _package(package_value)
    if not confirmed:
        return {"requires_confirmation": True, "package": package, "message": "将强制停止所有运行 User 下的该应用"}
    processes = _running_processes(settings).get(package, [])
    user_ids = sorted({int(process["user_id"]) for process in processes if process.get("user_id", "").isdigit()})
    if not user_ids:
        raise ValueError("未识别到运行进程所属的 Android User")
    results = []
    for user_id in user_ids:
        code, output, error = android.device_adb(settings, "shell", "am", "force-stop", "--user", str(user_id), package)
        results.append({"user_id": user_id, "ok": code == 0, "output": output or error})
    return {"ok": all(result["ok"] for result in results), "results": results}


def clear_data(settings: dict, package_value: object, user_value: object, confirmed: object) -> dict:
    package = _package(package_value)
    user_id, _ = _installed_user(settings, package, user_value)
    if not confirmed:
        return {"requires_confirmation": True, "package": package, "user_id": user_id, "message": f"清除 User {user_id} 的应用数据后不可恢复"}
    code, output, error = android.device_adb(settings, "shell", "pm", "clear", "--user", str(user_id), package, timeout=60)
    return {"ok": code == 0 and "success" in output.lower(), "output": output or error, "user_id": user_id}


def set_enabled(settings: dict, package_value: object, user_value: object, enabled: object, confirmed: object) -> dict:
    package = _package(package_value)
    user_id, _ = _installed_user(settings, package, user_value)
    if not isinstance(enabled, bool):
        raise ValueError("应用启用状态无效")
    enable = enabled
    if not enable and not confirmed:
        return {"requires_confirmation": True, "package": package, "user_id": user_id, "message": f"禁用 User {user_id} 的应用可能影响依赖它的系统功能"}
    action = "enable" if enable else "disable-user"
    args = ["shell", "pm", action, "--user", str(user_id)]
    args.append(package)
    code, output, error = android.device_adb(settings, *args, timeout=45)
    return {"ok": code == 0, "output": output or error, "enabled": enable, "user_id": user_id}


def uninstall(settings: dict, package_value: object, user_value: object, confirmed: object) -> dict:
    package = _package(package_value)
    user_id, _ = _installed_user(settings, package, user_value)
    if not confirmed:
        return {"requires_confirmation": True, "package": package, "user_id": user_id, "message": f"将从 User {user_id} 卸载该应用并删除其用户数据"}
    code, output, error = android.device_adb(settings, "shell", "pm", "uninstall", "--user", str(user_id), package, timeout=60)
    ok = code == 0 and "success" in output.lower()
    remaining_users = None
    if ok:
        dump_code, package_dump, _ = android.device_adb(settings, "shell", "dumpsys", "package", package, timeout=45)
        if dump_code == 0:
            remaining_users = [user["user_id"] for user in _package_user_states(package_dump)]
    return {"ok": ok, "output": output or error, "user_id": user_id, "remaining_users": remaining_users}


def pull_apk(settings: dict, package_value: object) -> dict:
    """将已安装应用的 base.apk 放入下载暂存区，由桌面宿主选择保存位置。"""
    package = _package(package_value)
    paths = device.installed_apk_paths(settings, package)
    source = next((path for path in paths if path.endswith("/base.apk")), paths[0] if paths else "")
    if not source.startswith("/"):
        raise ValueError("未找到应用 base.apk")
    result = device_files.pull_known_file(settings, source, f"{package}.apk")
    return {**result, "source": source}
