"""已安装 Android 应用的列表、详情和受控管理操作。"""

from __future__ import annotations

import re

from . import android, device, device_files


PACKAGE_NAME = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")
PACKAGE_LINE = re.compile(r"^package:(?P<path>.+?)=(?P<package>[A-Za-z0-9_.]+)(?:\s+uid:(?P<uid>\d+))?$")
ENABLED_STATE = re.compile(r"^\s*enabled=(\d+)\s*$", re.MULTILINE)
FIRST_INSTALL = re.compile(r"^\s*firstInstallTime=(.*?)\s*$", re.MULTILINE)
LAST_UPDATE = re.compile(r"^\s*lastUpdateTime=(.*?)\s*$", re.MULTILINE)


def _package(value: object) -> str:
    package = str(value or "").strip()
    if not PACKAGE_NAME.fullmatch(package):
        raise ValueError("应用包名格式无效")
    return package


def _command(settings: dict, *args: str, timeout: int = 30) -> str:
    code, output, error = android.device_adb(settings, *args, timeout=timeout)
    if code:
        raise ValueError(error or output or f"ADB 命令执行失败：{' '.join(args)}")
    return output


def _running_processes(settings: dict) -> dict[str, list[str]]:
    output = _command(settings, "shell", "ps", "-A")
    result: dict[str, list[str]] = {}
    for line in output.splitlines()[1:]:
        columns = line.split()
        if len(columns) < 2 or not columns[1].isdigit():
            continue
        name = columns[-1]
        package = name.split(":", 1)[0]
        if PACKAGE_NAME.fullmatch(package):
            result.setdefault(package, []).append(columns[1])
    return result


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
            "pids": running.get(package, []),
            "launch_configured": package in launch_configs,
        })
    rows.sort(key=lambda item: (item["kind"] != "user", item["package"].lower()))
    return {"items": rows, "total": len(rows)}


def _match(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text or "")
    return match.group(1).strip() if match else ""


def details(settings: dict, package_value: object) -> dict:
    package = _package(package_value)
    package_dump = _command(settings, "shell", "dumpsys", "package", package, timeout=45)
    versions = device.package_version(package_dump)
    path_output = _command(settings, "shell", "pm", "path", package)
    paths = [line.removeprefix("package:").strip() for line in path_output.splitlines() if line.startswith("package:")]
    enabled = _match(ENABLED_STATE, package_dump)
    _, platform_dump, _ = android.device_adb(settings, "shell", "dumpsys", "package", "android", timeout=45)
    signature = android.signature(package_dump)
    platform_signature = android.signature(platform_dump)
    signature_status = "unknown" if not signature or not platform_signature else ("platform" if signature == platform_signature else "non_platform")
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
    }


def launch(settings: dict, package_value: object) -> dict:
    package = _package(package_value)
    if package in device.launch_configs(settings):
        return device.launch(settings, package)
    output = _command(settings, "shell", "cmd", "package", "resolve-activity", "--brief", package)
    component = next((line.strip() for line in reversed(output.splitlines()) if "/" in line), "")
    if not component:
        raise ValueError("未找到可启动 Activity，请为该应用配置自定义拉起命令")
    code, stdout, error = android.device_adb(settings, "shell", "am", "start", "-n", component, timeout=30)
    return {"ok": code == 0, "output": stdout or error, "component": component}


def stop(settings: dict, package_value: object) -> dict:
    package = _package(package_value)
    code, output, error = android.device_adb(settings, "shell", "am", "force-stop", package)
    return {"ok": code == 0, "output": output or error}


def clear_data(settings: dict, package_value: object, confirmed: object) -> dict:
    package = _package(package_value)
    if not confirmed:
        return {"requires_confirmation": True, "package": package, "message": "清除后应用账号、数据库和设置将不可恢复"}
    code, output, error = android.device_adb(settings, "shell", "pm", "clear", "--user", "current", package, timeout=60)
    return {"ok": code == 0 and "success" in output.lower(), "output": output or error}


def set_enabled(settings: dict, package_value: object, enabled: object, confirmed: object) -> dict:
    package = _package(package_value)
    enable = bool(enabled)
    if not enable and not confirmed:
        return {"requires_confirmation": True, "package": package, "message": "禁用应用可能影响依赖它的系统功能"}
    action = "enable" if enable else "disable-user"
    args = ["shell", "pm", action, "--user", "current"]
    args.append(package)
    code, output, error = android.device_adb(settings, *args, timeout=45)
    return {"ok": code == 0, "output": output or error, "enabled": enable}


def uninstall(settings: dict, package_value: object, confirmed: object) -> dict:
    return device.uninstall(settings, _package(package_value), bool(confirmed))


def pull_apk(settings: dict, package_value: object) -> dict:
    """将已安装应用的 base.apk 放入下载暂存区，由桌面宿主选择保存位置。"""
    package = _package(package_value)
    output = _command(settings, "shell", "pm", "path", package)
    paths = [line.removeprefix("package:").strip() for line in output.splitlines() if line.startswith("package:")]
    source = next((path for path in paths if path.endswith("/base.apk")), paths[0] if paths else "")
    if not source.startswith("/"):
        raise ValueError("未找到应用 base.apk")
    result = device_files.pull_known_file(settings, source, f"{package}.apk")
    return {**result, "source": source}
