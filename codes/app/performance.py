"""Android 快速性能采样、会话归档与受控导出。"""

from __future__ import annotations

import csv
import json
import re
import shutil
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path

from . import android, storage


PACKAGE_NAME = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")
SESSION_ID = re.compile(r"[a-f0-9]{32}")
SAFE_DOWNLOAD_PART = re.compile(r"[^A-Za-z0-9._-]+")
MEMORY_VALUE = re.compile(r"^(?P<name>[A-Za-z_()]+):\s+(?P<value>\d+)\s+kB", re.MULTILINE)
FOREGROUND_ACTIVITY = re.compile(
    r"(?P<package>[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/(?P<activity>[A-Za-z0-9_.$]+)"
)
DISPLAY_ID = re.compile(r"(?:displayId|mDisplayId)=(\d+)")
PUBLIC_SESSION_KEYS = {
    "state", "session_id", "serial", "package", "sample_interval_seconds", "started_at",
    "finished_at", "paused_at", "sample_count", "message", "error", "downloads",
}
CSV_FIELDS = [
    "timestamp", "elapsed_ms", "system_cpu_percent", "memory_total_bytes", "memory_used_bytes",
    "data_total_bytes", "data_used_bytes", "pid", "process_cpu_percent", "rss_bytes", "pss_bytes",
    "battery_level", "battery_status", "current_raw", "current_ma", "temperature_c",
    "thermal_status", "foreground_package", "foreground_activity", "display_id",
]

_lock = threading.RLock()
_session: dict = {}


def _sessions_root() -> Path:
    return storage.data_dir("performance_diagnostics", "sessions")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _package(value: object) -> str:
    package = str(value or "").strip()
    if not PACKAGE_NAME.fullmatch(package):
        raise ValueError("应用包名格式无效")
    return package


def _number(value: object, minimum: float, maximum: float, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label}无效") from error
    if not minimum <= number <= maximum:
        raise ValueError(f"{label}必须在 {minimum:g}-{maximum:g} 之间")
    return number


def _command(settings: dict, *args: str, timeout: int = 15) -> tuple[str, str]:
    code, output, error = android.device_adb(settings, *args, timeout=timeout)
    return (output if code == 0 else "", "" if code == 0 else (error or output or "ADB 命令执行失败"))


def _parse_proc_stat(text: str) -> dict | None:
    lines = text.splitlines()
    if not lines or not lines[0].startswith("cpu "):
        return None
    values = [int(value) for value in lines[0].split()[1:] if value.isdigit()]
    if len(values) < 4:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    cores = sum(1 for line in lines[1:] if re.match(r"cpu\d+\s", line)) or 1
    return {"total": sum(values), "idle": idle, "cores": cores}


def _parse_process_stat(text: str) -> dict | None:
    closing = text.rfind(")")
    if closing < 0:
        return None
    fields = text[closing + 2:].split()
    if len(fields) < 13:
        return None
    try:
        return {"ticks": int(fields[11]) + int(fields[12])}
    except ValueError:
        return None


def _delta_percent(current: dict | None, previous: dict | None, process: bool = False) -> float | None:
    if not current or not previous:
        return None
    total_delta = current.get("system_total", current.get("total", 0)) - previous.get("system_total", previous.get("total", 0))
    if total_delta <= 0:
        return None
    if process:
        value = (current["ticks"] - previous["ticks"]) * current.get("cores", 1) * 100 / total_delta
    else:
        idle_delta = current["idle"] - previous["idle"]
        value = (total_delta - idle_delta) * 100 / total_delta
    return round(max(0.0, value), 1)


def _parse_memory(text: str) -> dict:
    values = {match.group("name"): int(match.group("value")) * 1024 for match in MEMORY_VALUE.finditer(text)}
    total = values.get("MemTotal")
    available = values.get("MemAvailable", values.get("MemFree"))
    return {"total_bytes": total, "used_bytes": total - available if total is not None and available is not None else None}


def _parse_df(text: str) -> dict:
    for line in reversed(text.splitlines()):
        columns = line.split()
        if len(columns) >= 4 and all(value.isdigit() for value in columns[1:4]):
            total, used = int(columns[1]) * 1024, int(columns[2]) * 1024
            return {"total_bytes": total, "used_bytes": used}
    return {"total_bytes": None, "used_bytes": None}


def _parse_rss(text: str) -> int | None:
    match = re.search(r"^VmRSS:\s+(\d+)\s+kB", text, re.MULTILINE)
    return int(match.group(1)) * 1024 if match else None


def _parse_pss(text: str) -> int | None:
    patterns = [r"TOTAL PSS:\s*(\d+)", r"^\s*TOTAL\s+(\d+)\s+", r"^\s*TOTAL:\s+(\d+)\s+kB"]
    for pattern in patterns:
        match = re.search(pattern, text, re.MULTILINE | re.IGNORECASE)
        if match:
            return int(match.group(1)) * 1024
    return None


def _parse_battery(text: str, current_text: str) -> dict:
    def integer(name: str) -> int | None:
        match = re.search(rf"^\s*{re.escape(name)}:\s*(-?\d+)", text, re.MULTILINE)
        return int(match.group(1)) if match else None
    raw = None
    try:
        raw = int(current_text.strip())
    except ValueError:
        pass
    temperature = integer("temperature")
    statuses = {1: "unknown", 2: "charging", 3: "discharging", 4: "not_charging", 5: "full"}
    status = integer("status")
    return {
        "level": integer("level"), "status": statuses.get(status, "unknown"), "current_raw": raw,
        "current_ma": round(raw / 1000, 1) if raw is not None else None,
        "temperature_c": round(temperature / 10, 1) if temperature is not None else None,
    }


def _parse_thermal(text: str) -> dict:
    match = re.search(r"(?:Thermal Status|mStatus):\s*(\d+)", text, re.IGNORECASE)
    value = int(match.group(1)) if match else None
    names = {0: "NONE", 1: "LIGHT", 2: "MODERATE", 3: "SEVERE", 4: "CRITICAL", 5: "EMERGENCY", 6: "SHUTDOWN"}
    return {"status": names.get(value, str(value) if value is not None else None), "status_code": value}


def _parse_foreground(text: str, target_package: str = "") -> dict:
    """解析各 Display 的 resumed Activity，并优先返回被采样应用所在窗口。"""
    current_display = None
    candidates = []
    global_candidate = None
    for line in text.splitlines():
        display_header = re.search(r"^Display #(\d+)", line.strip())
        if display_header:
            current_display = int(display_header.group(1))
            continue
        if not any(marker in line for marker in ("topResumedActivity=", "mResumedActivity:", "ResumedActivity:", "mCurrentFocus=", "mFocusedApp=")):
            continue
        match = FOREGROUND_ACTIVITY.search(line)
        if not match:
            continue
        inline_display = DISPLAY_ID.search(line)
        is_global = "ResumedActivity:" in line and "topResumedActivity=" not in line
        display_id = int(inline_display.group(1)) if inline_display else (None if is_global else current_display)
        item = {
            "package": match.group("package"), "activity": match.group("activity"),
            "component": f"{match.group('package')}/{match.group('activity')}", "display_id": display_id,
        }
        if is_global:
            global_candidate = item
        if "topResumedActivity=" in line or "mResumedActivity:" in line:
            candidates.append(item)
    if global_candidate and global_candidate["display_id"] is None:
        matching = next((item for item in candidates if item["component"] == global_candidate["component"]), None)
        if matching:
            global_candidate["display_id"] = matching["display_id"]
    target = next((item for item in candidates if item["package"] == target_package), None)
    return target or global_candidate or (candidates[0] if candidates else {"package": None, "activity": None, "display_id": None})


def _sample(settings: dict, package: str, previous: dict, tick: int, started_monotonic: float) -> tuple[dict, dict]:
    errors = []
    proc_text, error = _command(settings, "shell", "cat", "/proc/stat")
    if error: errors.append(error)
    system_stat = _parse_proc_stat(proc_text)
    memory_text, error = _command(settings, "shell", "cat", "/proc/meminfo")
    if error: errors.append(error)
    df_text, error = _command(settings, "shell", "df", "-k", "/data")
    if error: errors.append(error)
    pid_text, error = _command(settings, "shell", "pidof", package)
    if error and "not found" not in error.lower(): errors.append(error)
    pid = next((part for part in pid_text.split() if part.isdigit()), None)
    process_stat = None
    rss = None
    if pid:
        process_text, process_error = _command(settings, "shell", "cat", f"/proc/{pid}/stat")
        status_text, status_error = _command(settings, "shell", "cat", f"/proc/{pid}/status")
        if process_error: errors.append(process_error)
        if status_error: errors.append(status_error)
        process_stat = _parse_process_stat(process_text)
        rss = _parse_rss(status_text)
    if process_stat and system_stat:
        process_stat.update({"system_total": system_stat["total"], "cores": system_stat["cores"], "pid": pid})
    previous_process = previous.get("process") if previous.get("process", {}).get("pid") == pid else None
    process_cpu = _delta_percent(process_stat, previous_process, process=True)
    pss = previous.get("pss")
    pss_updated_at = previous.get("pss_updated_at")
    if tick % 3 == 0:
        pss_text, pss_error = _command(settings, "shell", "dumpsys", "meminfo", package, timeout=30)
        if pss_error: errors.append(pss_error)
        pss = _parse_pss(pss_text)
        pss_updated_at = _now() if pss is not None else None
    foreground = previous.get("foreground", {"package": None, "activity": None, "display_id": None})
    activity_text, activity_error = _command(settings, "shell", "dumpsys", "activity", "activities", timeout=20)
    if activity_error:
        errors.append(activity_error)
    else:
        foreground = _parse_foreground(activity_text, package)
    battery = previous.get("battery", {})
    thermal = previous.get("thermal", {})
    if tick % 5 == 0:
        battery_text, battery_error = _command(settings, "shell", "dumpsys", "battery")
        current_text, _ = _command(settings, "shell", "cat", "/sys/class/power_supply/battery/current_now")
        thermal_text, thermal_error = _command(settings, "shell", "dumpsys", "thermalservice", timeout=20)
        if battery_error: errors.append(battery_error)
        if thermal_error: errors.append(thermal_error)
        battery = _parse_battery(battery_text, current_text)
        thermal = _parse_thermal(thermal_text)
    sample = {
        "timestamp": _now(), "elapsed_ms": round((time.monotonic() - started_monotonic) * 1000),
        "system": {"cpu_percent": _delta_percent(system_stat, previous.get("system")), "memory": _parse_memory(memory_text), "data_storage": _parse_df(df_text)},
        "process": {"package": package, "pid": int(pid) if pid else None, "cpu_percent": process_cpu, "rss_bytes": rss, "pss_bytes": pss, "pss_updated_at": pss_updated_at},
        "battery": battery, "thermal": thermal, "foreground": foreground,
        "errors": list(dict.fromkeys(errors))[:5],
    }
    next_previous = {"system": system_stat, "process": process_stat or {}, "pss": pss, "pss_updated_at": pss_updated_at, "battery": battery, "thermal": thermal, "foreground": foreground}
    return sample, next_previous


def _public_session(include_samples: bool = True) -> dict:
    if not _session:
        return {"state": "idle", "samples": []}
    result = {key: value for key, value in _session.items() if key in PUBLIC_SESSION_KEYS}
    result["latest"] = _session.get("latest")
    result["samples"] = list(_session.get("samples", ())) if include_samples else []
    return result


def status() -> dict:
    with _lock:
        if _session:
            return _public_session()
    manifests = sorted(_sessions_root().glob("*/manifest.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    for manifest in manifests:
        try:
            value = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if value.get("storage_key") != "performance_diagnostics":
            continue
        state = value.get("state")
        if state in {"running", "paused", "stopping"}:
            value.update({"state": "interrupted", "message": "Workbench 上次退出时采样未正常完成", "downloads": {}})
        return {key: value.get(key) for key in PUBLIC_SESSION_KEYS if key in value} | {"latest": value.get("latest"), "samples": []}
    return {"state": "idle", "samples": []}


def _append_event(event: dict) -> None:
    with _session["events_path"].open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False) + "\n")


def _write_manifest() -> None:
    manifest = {key: value for key, value in _session.items() if key in PUBLIC_SESSION_KEYS}
    manifest["latest"] = _session.get("latest")
    storage.write_artifact_json("performance_diagnostics", _session["directory"] / "manifest.json", manifest)


def _worker() -> None:
    previous: dict = {}
    tick = 0
    with _lock:
        session_id = _session.get("session_id")
        stop_event = _session["stop_event"]
    next_sample_at = time.monotonic()
    while not stop_event.is_set():
        with _lock:
            if _session.get("session_id") != session_id:
                return
            state = _session.get("state")
            settings = _session.get("settings")
            package = _session.get("package")
            started_monotonic = _session.get("started_monotonic")
            interval = _session.get("sample_interval_seconds", 2)
        if state == "paused":
            previous = {}
            stop_event.wait(.2)
            continue
        if state != "running":
            break
        try:
            sample, previous = _sample(settings, package, previous, tick, started_monotonic)
        except Exception as error:  # 采样异常必须可见，但不能静默杀死整个会话。
            sample = {"timestamp": _now(), "elapsed_ms": round((time.monotonic() - started_monotonic) * 1000), "errors": [str(error)]}
            previous = {}
        with _lock:
            if _session.get("session_id") != session_id or _session.get("state") not in {"running", "paused"}:
                break
            _append_event({"type": "sample", **sample})
            _session["samples"].append(sample)
            _session["latest"] = sample
            _session["sample_count"] += 1
        tick += 1
        # 使用固定节拍而不是“采样耗时 + 间隔”，减小 ADB 查询造成的画面卡顿。
        next_sample_at += interval
        remaining = next_sample_at - time.monotonic()
        if remaining <= 0:
            next_sample_at = time.monotonic()
            continue
        stop_event.wait(remaining)


def _flatten(sample: dict) -> dict:
    system, process = sample.get("system", {}), sample.get("process", {})
    memory, data = system.get("memory", {}), system.get("data_storage", {})
    battery, foreground = sample.get("battery", {}), sample.get("foreground", {})
    return {
        "timestamp": sample.get("timestamp"), "elapsed_ms": sample.get("elapsed_ms"),
        "system_cpu_percent": system.get("cpu_percent"), "memory_total_bytes": memory.get("total_bytes"), "memory_used_bytes": memory.get("used_bytes"),
        "data_total_bytes": data.get("total_bytes"), "data_used_bytes": data.get("used_bytes"), "pid": process.get("pid"),
        "process_cpu_percent": process.get("cpu_percent"), "rss_bytes": process.get("rss_bytes"), "pss_bytes": process.get("pss_bytes"),
        "battery_level": battery.get("level"), "battery_status": battery.get("status"), "current_raw": battery.get("current_raw"),
        "current_ma": battery.get("current_ma"), "temperature_c": battery.get("temperature_c"), "thermal_status": sample.get("thermal", {}).get("status"),
        "foreground_package": foreground.get("package"), "foreground_activity": foreground.get("activity"), "display_id": foreground.get("display_id"),
    }


def _read_samples(events_path: Path) -> list[dict]:
    result = []
    if not events_path.is_file():
        return result
    for line in events_path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "sample":
            event.pop("type", None)
            result.append(event)
    return result


def _finalize() -> None:
    samples = _read_samples(_session["events_path"])
    storage.write_artifact_json("performance_diagnostics", _session["directory"] / "performance.json", {"session_id": _session["session_id"], "samples": samples})
    csv_path = _session["directory"] / "performance.csv"
    temporary = csv_path.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(_flatten(sample) for sample in samples)
    temporary.replace(csv_path)
    _session["downloads"] = {
        "csv": f"/api/performance/download?id={_session['session_id']}&format=csv",
        "json": f"/api/performance/download?id={_session['session_id']}&format=json",
    }
    _write_manifest()


def start(settings: dict, body: dict) -> dict:
    package = _package(body.get("package"))
    interval = _number(body.get("sample_interval_seconds", 1), 1, 10, "采样间隔")
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    output, error = _command(settings, "shell", "pm", "path", package)
    if error or not any(line.startswith("package:") for line in output.splitlines()):
        raise ValueError("目标应用未安装在当前设备")
    with _lock:
        if _session.get("state") in {"running", "paused", "stopping"}:
            raise ValueError("已有性能采样任务正在运行")
        session_id = uuid.uuid4().hex
        directory = _sessions_root() / session_id
        directory.mkdir(parents=True, exist_ok=False)
        stop_event = threading.Event()
        _session.clear()
        _session.update({
            "state": "running", "session_id": session_id, "serial": serial, "package": package,
            "sample_interval_seconds": interval, "started_at": _now(), "started_monotonic": time.monotonic(),
            "sample_count": 0, "message": "性能采样中", "settings": settings, "directory": directory,
            "events_path": directory / "events.jsonl", "samples": deque(maxlen=180), "stop_event": stop_event,
        })
        _append_event({"type": "state", "state": "running", "timestamp": _session["started_at"]})
        _write_manifest()
        worker = threading.Thread(target=_worker, name="glacien-performance", daemon=True)
        _session["worker"] = worker
        worker.start()
        return _public_session()


def pause() -> dict:
    with _lock:
        if _session.get("state") != "running":
            raise ValueError("当前没有正在采样的性能任务")
        _session["state"] = "paused"
        _session["paused_at"] = _now()
        _session["message"] = "性能采样已暂停"
        _append_event({"type": "state", "state": "paused", "timestamp": _session["paused_at"]})
        _write_manifest()
        return _public_session()


def resume() -> dict:
    with _lock:
        if _session.get("state") != "paused":
            raise ValueError("当前性能任务未暂停")
        _session["state"] = "running"
        _session.pop("paused_at", None)
        _session["message"] = "性能采样中"
        _append_event({"type": "state", "state": "running", "timestamp": _now()})
        _write_manifest()
        return _public_session()


def stop() -> dict:
    with _lock:
        if _session.get("state") not in {"running", "paused"}:
            raise ValueError("当前没有正在采样的性能任务")
        _session["state"] = "stopping"
        _session["message"] = "正在停止并生成导出文件"
        _session["stop_event"].set()
        worker = _session.get("worker")
    if worker:
        worker.join(timeout=15)
    with _lock:
        _session["state"] = "completed"
        _session["finished_at"] = _now()
        _session["message"] = "性能采样已归档"
        _append_event({"type": "state", "state": "completed", "timestamp": _session["finished_at"]})
        _finalize()
        return _public_session()


def resolve_download(session_value: object, format_value: object) -> Path:
    session_id = str(session_value or "").strip()
    file_format = str(format_value or "").strip().lower()
    if not SESSION_ID.fullmatch(session_id) or file_format not in {"csv", "json"}:
        raise ValueError("性能采样文件 ID 无效")
    root = _sessions_root().resolve()
    path = (root / session_id / f"performance.{file_format}").resolve()
    if root not in path.parents or not path.is_file() or path.is_symlink():
        raise ValueError("性能采样文件不存在")
    return path


def download_name(session_value: object, format_value: object) -> str:
    path = resolve_download(session_value, format_value)
    manifest_path = path.parent / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    package = SAFE_DOWNLOAD_PART.sub("_", str(manifest.get("package") or "app")).strip("._-") or "app"
    serial = SAFE_DOWNLOAD_PART.sub("_", str(manifest.get("serial") or "device")).strip("._-") or "device"
    try:
        started = datetime.fromisoformat(str(manifest.get("started_at"))).strftime("%Y%m%d-%H%M%S")
    except (TypeError, ValueError):
        started = path.parent.name[:8]
    return f"performance-{package[:80]}-{serial[:48]}-{started}.{path.suffix.lstrip('.')}"


def _session_directory(value: object) -> Path:
    session_id = str(value or "").strip()
    if not SESSION_ID.fullmatch(session_id):
        raise ValueError("性能采样会话 ID 无效")
    root = _sessions_root().resolve()
    directory = root / session_id
    if directory.is_symlink() or not directory.is_dir() or directory.resolve().parent != root:
        raise ValueError("性能采样会话不存在")
    return directory


def _directory_size(directory: Path) -> int:
    size = 0
    for item in directory.rglob("*"):
        try:
            if item.is_file() and not item.is_symlink():
                size += item.stat().st_size
        except OSError:
            continue
    return size


def sessions() -> dict:
    items = []
    root = _sessions_root()
    with _lock:
        active_id = _session.get("session_id") if _session.get("state") in {"running", "paused", "stopping"} else None
        active_snapshot = _public_session(include_samples=False) if active_id else {}
    for directory in root.iterdir():
        if directory.is_symlink() or not directory.is_dir() or not SESSION_ID.fullmatch(directory.name):
            continue
        manifest_path = directory / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            modified = datetime.fromtimestamp(directory.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("storage_key") != "performance_diagnostics":
            continue
        state = manifest.get("state", "unknown")
        if state in {"running", "paused", "stopping"} and directory.name != active_id:
            state = "interrupted"
        if directory.name == active_id:
            manifest = {**manifest, **active_snapshot}
            state = manifest.get("state", state)
        items.append({
            "id": directory.name, "package": manifest.get("package", ""), "serial": manifest.get("serial", ""),
            "state": state, "started_at": manifest.get("started_at"), "finished_at": manifest.get("finished_at"),
            "sample_count": int(manifest.get("sample_count", 0) or 0), "size": _directory_size(directory),
            "active": directory.name == active_id,
            "downloads": {
                name: f"/api/performance/download?id={directory.name}&format={name}"
                for name in ("csv", "json") if (directory / f"performance.{name}").is_file()
            },
            "modified": modified,
        })
    items.sort(key=lambda item: item["modified"], reverse=True)
    return {"items": items, "total": len(items), "total_size": sum(item["size"] for item in items)}


def delete_sessions(values: object, confirmed: object = False) -> dict:
    if confirmed is not True:
        raise ValueError("删除性能采样记录需要明确确认")
    if not isinstance(values, list) or not values or len(values) > 100:
        raise ValueError("请选择 1-100 条性能采样记录")
    session_ids = list(dict.fromkeys(str(value or "").strip() for value in values))
    directories = [_session_directory(session_id) for session_id in session_ids]
    with _lock:
        active_id = _session.get("session_id") if _session.get("state") in {"running", "paused", "stopping"} else None
        if active_id in session_ids:
            raise ValueError("正在采样的会话不能删除，请先停止采样")
        for directory in directories:
            shutil.rmtree(directory)
        if _session.get("session_id") in session_ids:
            _session.clear()
    return {"ok": True, "deleted": session_ids}
