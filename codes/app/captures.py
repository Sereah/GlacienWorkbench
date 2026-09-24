"""设备截图、录屏会话和受控本地媒体文件。"""
from __future__ import annotations

import json
import mimetypes
import os
import platform
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from . import android
from . import proc
from . import storage

CAPTURE_ROOT = storage.data_dir("captures", "screenshots").parent
SCREENSHOT_ROOT = storage.data_dir("captures", "screenshots")
RECORDING_ROOT = storage.data_dir("captures", "recordings")
RECORDING_COVER_ROOT = storage.data_dir("captures", "recording-covers")
PNG_HEADER = b"\x89PNG\r\n\x1a\n"
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
CAPTURE_DIRECTORIES = {"screenshots", "recordings", "recording-covers"}
INVALID_FILENAME_CHARACTERS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
MAX_RECORDING_NAME_LENGTH = 80
DISPLAY_INFO_PATTERN = re.compile(r'DisplayInfo\{"([^"]*)", displayId (\d+).*?real (\d+) x (\d+).*?uniqueId "([^"]+)"')
SCRCPY_CANDIDATES = {
    "darwin": ("/opt/homebrew/bin/scrcpy", "/usr/local/bin/scrcpy", "/Applications/scrcpy.app/Contents/MacOS/scrcpy"),
    "windows": (),
    "linux": ("/usr/bin/scrcpy", "/usr/local/bin/scrcpy", "/snap/bin/scrcpy"),
}
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
_record_lock = threading.RLock()
_recording: dict = {}


def _serial(settings: dict) -> str:
    value = str(settings.get("_selected_adb_serial", "")).strip()
    if not value:
        raise ValueError("缺少已选择的 ADB 设备")
    return value


def _safe_part(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_.") or "device"


def _filename(settings: dict, suffix: str) -> str:
    serial = _safe_part(_serial(settings))
    return f"{serial}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]}{suffix}"


def _recording_output(settings: dict, requested_name: object) -> Path:
    raw_name = str(requested_name or "")
    if not raw_name.strip():
        return RECORDING_ROOT / _filename(settings, ".mp4")
    if raw_name != raw_name.strip():
        raise ValueError("录屏文件名不能以空格开头或结尾")
    name = raw_name
    if name.lower().endswith(".mp4"):
        name = name[:-4].rstrip()
    if not name or name in {".", ".."}:
        raise ValueError("录屏文件名不能为空")
    if len(name) > MAX_RECORDING_NAME_LENGTH:
        raise ValueError(f"录屏文件名不能超过 {MAX_RECORDING_NAME_LENGTH} 个字符")
    if INVALID_FILENAME_CHARACTERS.search(name) or name.endswith((".", " ")):
        raise ValueError('录屏文件名不能包含 < > : " / \ | ? *、控制字符或以点和空格结尾')
    # 统一拒绝 Windows 设备名，保证同一个自定义名称在三端都能安全落盘。
    if name.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES:
        raise ValueError("录屏文件名不能使用系统保留名称")
    output = RECORDING_ROOT / f"{name}.mp4"
    index = 2
    while output.exists():
        output = RECORDING_ROOT / f"{name}-{index}.mp4"
        index += 1
    return output


def _file_payload(path: Path) -> dict:
    relative = path.relative_to(CAPTURE_ROOT).as_posix()
    stat = path.stat()
    payload = {
        "id": relative, "name": path.name, "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "url": "/api/captures/file?id=" + quote(relative),
        "type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
    }
    if path.parent.resolve() == RECORDING_ROOT.resolve() and path.suffix.lower() == ".mp4":
        cover = RECORDING_COVER_ROOT / f"{path.stem}.png"
        if cover.is_file() and not cover.is_symlink():
            payload["cover"] = _file_payload(cover)
    return payload


def resolve_file(value: object) -> Path:
    file_id = str(value or "").strip()
    relative = PurePosixPath(file_id)
    if len(relative.parts) != 2 or relative.parts[0] not in CAPTURE_DIRECTORIES:
        raise ValueError("无效的捕获文件 ID")
    path = (CAPTURE_ROOT / Path(*relative.parts)).resolve()
    root = CAPTURE_ROOT.resolve()
    if root not in path.parents or not path.is_file() or path.is_symlink():
        raise ValueError("捕获文件不存在")
    return path

def files(kind: object = "all", offset: object = 0, limit: object = 50) -> dict:
    clean_kind = str(kind or "all").strip()
    if clean_kind not in {"all", "screenshot", "recording"}:
        raise ValueError("媒体类型无效")
    try:
        start, count = max(0, int(offset)), min(100, max(1, int(limit)))
    except (TypeError, ValueError):
        raise ValueError("媒体分页参数无效")
    items = []
    if clean_kind in {"all", "screenshot"} and SCREENSHOT_ROOT.is_dir():
        items.extend(_file_payload(path) for path in SCREENSHOT_ROOT.glob("*.png") if path.is_file() and not path.is_symlink())
    if clean_kind in {"all", "recording"} and RECORDING_ROOT.is_dir():
        items.extend(_file_payload(path) for path in RECORDING_ROOT.glob("*.mp4") if path.is_file() and not path.is_symlink())
    items.sort(key=lambda item: (item["modified"], item["name"]), reverse=True)
    page = items[start:start + count]
    return {"items": page, "total": len(items), "offset": start, "limit": count, "has_more": start + len(page) < len(items)}

def delete_file(value: object) -> dict:
    global _recording
    path = resolve_file(value)
    if path.parent.resolve() == RECORDING_COVER_ROOT.resolve():
        raise ValueError("录屏封面不能单独删除")
    file_id = path.relative_to(CAPTURE_ROOT).as_posix()
    path.unlink()
    cleanup_warning = ""
    if path.parent.resolve() == RECORDING_ROOT.resolve():
        cover = RECORDING_COVER_ROOT / f"{path.stem}.png"
        try:
            cover.unlink(missing_ok=True)
        except OSError as error:
            # 主视频已经按用户要求删除，封面清理失败需明确返回，但不能把删除结果误报为失败。
            cleanup_warning = f"录屏已删除，但封面清理失败：{error}"
    with _record_lock:
        recorded = _recording.get("file") if _recording else None
        if recorded and recorded.get("id") == file_id:
            _recording = {}
    return {"ok": True, "id": file_id, "name": path.name, "warning": cleanup_warning}


def delete_files(values: object) -> dict:
    """逐项复用受控文件删除校验，并明确返回部分失败。"""
    if not isinstance(values, list) or not values:
        raise ValueError("请选择要删除的媒体文件")
    if len(values) > 100:
        raise ValueError("单次最多删除 100 个媒体文件")
    results = []
    for value in values:
        try:
            results.append(delete_file(value))
        except (OSError, ValueError) as error:
            results.append({"ok": False, "id": str(value or ""), "error": str(error)})
    deleted = sum(1 for item in results if item["ok"])
    return {"ok": deleted == len(results), "deleted": deleted, "failed": len(results) - deleted, "results": results}


def _capture_png(settings: dict, output: Path, display_id: object = "") -> None:
    executable = android.tool("adb", settings)
    if not executable:
        raise ValueError("未找到 adb")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [executable, "-s", _serial(settings), "exec-out", "screencap", "-p"]
    clean_display_id = str(display_id or "").strip()
    if clean_display_id:
        if not re.fullmatch(r"\d+", clean_display_id):
            raise ValueError("Display ID 必须是非负整数")
        command.extend(["-d", clean_display_id])
    try:
        result = proc.run(
            command,
            capture_output=True, timeout=30, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("设备截图超时") from error
    if result.returncode or not result.stdout.startswith(PNG_HEADER):
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(message or "设备未返回有效 PNG 截图")
    temporary = output.with_suffix(".png.tmp")
    temporary.write_bytes(result.stdout)
    temporary.replace(output)


def screenshot(settings: dict, body: dict | None = None) -> dict:
    output = SCREENSHOT_ROOT / _filename(settings, ".png")
    _capture_png(settings, output, (body or {}).get("display_id", ""))
    return {"ok": True, "file": _file_payload(output)}


def displays(settings: dict) -> dict:
    """返回逻辑 Display ID 及截图/录屏所需的 SurfaceFlinger 物理 ID。"""
    code, output, error = android.device_adb(settings, "shell", "dumpsys", "display", timeout=30)
    if code:
        raise ValueError(error or output or "无法读取设备屏幕列表")
    found = {}
    for name, logical_id, width, height, unique_id in DISPLAY_INFO_PATTERN.findall(output):
        if logical_id in found:
            continue
        physical_id = unique_id.removeprefix("local:") if unique_id.startswith("local:") else ""
        found[logical_id] = {
            "logical_id": logical_id, "physical_id": physical_id,
            "name": name or f"Display {logical_id}", "width": int(width), "height": int(height),
        }
    if not found:
        found["0"] = {"logical_id": "0", "physical_id": "", "name": "主屏", "width": 0, "height": 0}
    return {"items": list(found.values())}


def _configured_scrcpy(settings: dict) -> Path | None:
    value = str(settings.get("scrcpy_path", "")).strip()
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        return None
    resolved = path.resolve()
    if resolved.name.lower() not in {"scrcpy", "scrcpy.exe"} or not resolved.is_file() or not os.access(resolved, os.X_OK):
        return None
    return resolved


def _scrcpy_path(settings: dict) -> tuple[Path | None, str]:
    if configured := _configured_scrcpy(settings):
        return configured, "configured"
    if found := shutil.which("scrcpy"):
        return Path(found).resolve(), "auto"
    for candidate in SCRCPY_CANDIDATES.get(platform.system().lower(), ()):
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path.resolve(), "auto"
    return None, "missing"


def scrcpy_status(settings: dict) -> dict:
    path, source = _scrcpy_path(settings)
    return {
        "available": path is not None, "path": str(path) if path else "", "source": source,
        "configured_path": str(settings.get("scrcpy_path", "")),
    }


def save_scrcpy_path(value: object) -> dict:
    raw = str(value or "").strip()
    if raw:
        path = Path(raw).expanduser()
        resolved = path.resolve()
        if not path.is_absolute() or resolved.name.lower() not in {"scrcpy", "scrcpy.exe"} or not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise ValueError("scrcpy 路径必须指向名为 scrcpy 或 scrcpy.exe 的可执行文件绝对路径")
        raw = str(resolved)
    current = storage.read("captures", storage.default("captures"))
    storage.update("captures", {"scrcpy_path": raw})
    return scrcpy_status({"scrcpy_path": raw})


def launch_scrcpy(settings: dict, body: dict) -> dict:
    executable, _ = _scrcpy_path(settings)
    if not executable:
        raise ValueError("未找到 scrcpy，请先安装或配置可执行文件路径")
    logical_id = str(body.get("display_id", "")).strip()
    if logical_id and not re.fullmatch(r"\d+", logical_id):
        raise ValueError("Display ID 必须是非负整数")
    args = [str(executable), "--serial", _serial(settings)]
    if logical_id:
        args.extend(["--display-id", logical_id])
    environment = os.environ.copy()
    if adb := android.tool("adb", settings):
        environment["ADB"] = adb
    # 用临时文件捕获启动阶段日志；不能长期使用 PIPE，否则外部进程持续输出后可能阻塞。
    with tempfile.TemporaryFile(mode="w+b") as launch_log:
        try:
            process = proc.Popen(args, stdin=subprocess.DEVNULL, stdout=launch_log, stderr=subprocess.STDOUT, env=environment)
        except OSError as error:
            raise ValueError(f"无法启动 scrcpy：{error}") from error
        try:
            process.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            return {"ok": True, "pid": process.pid, "path": str(executable)}
        launch_log.seek(0)
        output = ANSI_ESCAPE.sub("", launch_log.read().decode("utf-8", errors="replace")).strip()
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    message = next((line for line in reversed(lines) if "ERROR" in line.upper()), lines[-1] if lines else "scrcpy 进程提前退出")
    raise ValueError(f"scrcpy 启动失败：{message}")


def _record_args(settings: dict, body: dict, remote_path: str) -> list[str]:
    executable = android.tool("adb", settings)
    if not executable:
        raise ValueError("未找到 adb")
    try:
        limit = int(body.get("time_limit", 180))
        bit_rate = int(body.get("bit_rate", 12_000_000))
    except (TypeError, ValueError):
        raise ValueError("录屏时长或码率格式无效")
    if not 1 <= limit <= 180:
        raise ValueError("录屏时长必须为 1-180 秒")
    if not 100_000 <= bit_rate <= 100_000_000:
        raise ValueError("录屏码率必须为 100000-100000000 bit/s")
    size = str(body.get("size", "")).strip()
    if size and not re.fullmatch(r"[1-9]\d{1,4}x[1-9]\d{1,4}", size):
        raise ValueError("录屏分辨率格式应为 WIDTHxHEIGHT")
    display_id = str(body.get("display_id", "")).strip()
    if display_id and not re.fullmatch(r"\d+", display_id):
        raise ValueError("Display ID 必须是非负整数")
    command = ["screenrecord", "--time-limit", str(limit), "--bit-rate", str(bit_rate)]
    if size: command.extend(["--size", size])
    if display_id: command.extend(["--display-id", display_id])
    if body.get("bugreport"): command.append("--bugreport")
    command.append(remote_path)
    script = shlex.join(command) + " & pid=$!; echo $pid; wait $pid"
    # adb shell 会在设备端重新拼接参数；sh -c 脚本必须整体再加一层引用。
    quoted_script = "'" + script.replace("'", "'\"'\"'") + "'"
    return [executable, "-s", _serial(settings), "shell", "sh", "-c", quoted_script]


def _mp4_duration(path: Path) -> float | None:
    """读取 MP4 的 mvhd 时长；仅用于拒绝未写入有效媒体时间线的录屏。"""
    with path.open("rb") as stream:
        total = path.stat().st_size
        cursor = 0
        while cursor + 8 <= total:
            box = _mp4_box(stream, cursor, total)
            if not box:
                return None
            box_type, payload_start, box_end = box
            if box_type == b"moov":
                return _movie_header_duration(stream, payload_start, box_end)
            cursor = box_end
    return None


def _mp4_box(stream, start: int, limit: int) -> tuple[bytes, int, int] | None:
    stream.seek(start)
    header = stream.read(8)
    if len(header) != 8:
        return None
    size = int.from_bytes(header[:4], "big")
    box_type = header[4:]
    header_size = 8
    if size == 1:
        extended_size = stream.read(8)
        if len(extended_size) != 8:
            return None
        size = int.from_bytes(extended_size, "big")
        header_size = 16
    elif size == 0:
        size = limit - start
    end = start + size
    if size < header_size or end > limit:
        return None
    return box_type, start + header_size, end


def _movie_header_duration(stream, start: int, end: int) -> float | None:
    cursor = start
    while cursor + 8 <= end:
        box = _mp4_box(stream, cursor, end)
        if not box:
            return None
        box_type, payload_start, box_end = box
        if box_type == b"mvhd":
            stream.seek(payload_start)
            payload = stream.read(min(32, box_end - payload_start))
            if len(payload) < 20:
                return None
            version = payload[0]
            if version == 0 and len(payload) >= 20:
                timescale = int.from_bytes(payload[12:16], "big")
                duration = int.from_bytes(payload[16:20], "big")
            elif version == 1 and len(payload) >= 32:
                timescale = int.from_bytes(payload[20:24], "big")
                duration = int.from_bytes(payload[24:32], "big")
            else:
                return None
            return duration / timescale if timescale else None
        cursor = box_end
    return None


def _recording_process_error(process: subprocess.Popen) -> str:
    if not process.stderr:
        return ""
    return process.stderr.read().strip()


def start_recording(settings: dict, body: dict) -> dict:
    global _recording
    with _record_lock:
        if _recording and _recording.get("process") and _recording["process"].poll() is None:
            raise ValueError("已有屏幕录制正在进行")
        token = uuid.uuid4().hex
        requested_name = str(body.get("filename", "") or "")
        _recording_output(settings, requested_name)
        remote = f"/data/local/tmp/glacien-screenrecord-{token}.mp4"
        args = _record_args(settings, body, remote)
        process = proc.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1)
        pid_line = process.stdout.readline().strip() if process.stdout else ""
        remote_pid = int(pid_line) if pid_line.isdigit() else 0
        time.sleep(.2)
        if process.poll() is not None:
            error = _recording_process_error(process)
            raise ValueError(error or "screenrecord 启动失败")
        if not remote_pid:
            process.terminate()
            raise ValueError("无法获取设备端 screenrecord PID")
        cover = RECORDING_COVER_ROOT / f"{token}.png"
        cover_error = ""
        try:
            _capture_png(settings, cover, body.get("display_id", ""))
        except (OSError, ValueError) as error:
            cover_error = str(error)
        _recording = {
            "id": token, "process": process, "settings": dict(settings), "serial": _serial(settings),
            "remote": remote, "remote_pid": remote_pid, "started_at": time.time(), "time_limit": int(body.get("time_limit", 180)),
            "requested_name": requested_name,
            "pending_cover": cover if cover.is_file() else None, "cover_error": cover_error,
            "state": "recording", "file": None, "error": "",
        }
        return recording_status()


def _finish_recording(stop_process: bool) -> dict:
    global _recording
    with _record_lock:
        session = _recording
        if not session:
            raise ValueError("当前没有屏幕录制任务")
        process = session["process"]
        if stop_process and process.poll() is None:
            android.device_adb(session["settings"], "shell", "kill", "-2", str(session["remote_pid"]), timeout=15)
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate(); process.wait(timeout=3)
        elif process.poll() is None:
            return recording_status()
        if session.get("file"):
            return recording_status()
        time.sleep(.3)
        RECORDING_ROOT.mkdir(parents=True, exist_ok=True)
        output = _recording_output(session["settings"], session.get("requested_name"))
        code, pull_output, pull_error = android.device_adb(session["settings"], "pull", session["remote"], str(output), timeout=300)
        if code or not output.is_file() or output.stat().st_size == 0:
            if output.exists(): output.unlink()
            pending_cover = session.get("pending_cover")
            if pending_cover: pending_cover.unlink(missing_ok=True)
            session["state"] = "failed"; session["error"] = pull_error or pull_output or "录屏文件 Pull 失败"
            raise ValueError(session["error"])
        duration = _mp4_duration(output)
        if not duration or duration <= 0:
            # 保留本地异常 MP4 供下载分析；不要误报为录制完成或删除设备端原始文件。
            details = _recording_process_error(process)
            session["state"] = "failed"
            session["error"] = "录屏未生成有效视频帧，本地异常文件已保留供排查" + (f"：{details}" if details else "")
            pending_cover = session.get("pending_cover")
            if pending_cover: pending_cover.unlink(missing_ok=True)
            raise ValueError(session["error"])
        pending_cover = session.get("pending_cover")
        if pending_cover and pending_cover.is_file():
            RECORDING_COVER_ROOT.mkdir(parents=True, exist_ok=True)
            pending_cover.replace(RECORDING_COVER_ROOT / f"{output.stem}.png")
        android.device_adb(session["settings"], "shell", "rm", "-f", session["remote"], timeout=20)
        session["state"] = "completed"; session["file"] = _file_payload(output)
        session["duration"] = round(duration, 1)
        return recording_status()


def stop_recording() -> dict:
    return _finish_recording(True)


def recording_status() -> dict:
    global _recording
    with _record_lock:
        if not _recording:
            return {"state": "idle"}
        if _recording["state"] == "recording" and _recording["process"].poll() is not None:
            return _finish_recording(False)
        recorded = _recording.get("file")
        if recorded:
            try:
                path = resolve_file(recorded.get("id", ""))
                _recording["file"] = _file_payload(path)
            except ValueError:
                _recording = {}
                return {"state": "idle"}
        return {
            "state": _recording["state"], "id": _recording["id"], "serial": _recording["serial"],
            "started_at": _recording["started_at"], "elapsed": round(time.time() - _recording["started_at"], 1),
            "time_limit": _recording["time_limit"], "file": _recording.get("file"),
            "duration": _recording.get("duration"), "error": _recording.get("error", ""),
            "cover_error": _recording.get("cover_error", ""),
        }


def reveal(value: object) -> dict:
    path = resolve_file(value)
    system = platform.system().lower()
    if system == "darwin": args = ["open", str(path.parent)]
    elif system == "windows": args = ["explorer", f"/select,{path}"]
    else: args = ["xdg-open", str(path.parent)]
    try:
        result = proc.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10, check=False)
        if result.returncode:
            return {"ok": False, "file": path.name, "directory": str(path.parent), "error": result.stderr.strip() or result.stdout.strip() or f"系统命令退出码 {result.returncode}"}
    except subprocess.TimeoutExpired as error:
        return {"ok": False, "file": path.name, "directory": str(path.parent), "error": "打开文件位置超时"}
    except OSError as error:
        return {"ok": False, "file": path.name, "directory": str(path.parent), "error": f"无法打开文件位置：{error}"}
    return {"ok": True, "file": path.name, "directory": str(path.parent)}


def open_recording(value: object) -> dict:
    """用系统播放器打开受控录屏文件，作为 WebEngine 解码失败时的降级方案。"""
    path = resolve_file(value)
    if path.parent.resolve() != RECORDING_ROOT.resolve() or path.suffix.lower() != ".mp4":
        raise ValueError("只能使用系统播放器打开录屏文件")
    system = platform.system().lower()
    try:
        if system == "windows":
            os.startfile(path)
            return {"ok": True, "file": path.name}
        args = ["open", str(path)] if system == "darwin" else ["xdg-open", str(path)]
        result = proc.run(
            args, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("打开系统播放器超时") from error
    except OSError as error:
        raise ValueError(f"无法打开系统播放器：{error}") from error
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or f"系统命令退出码 {result.returncode}"
        raise ValueError(f"无法打开系统播放器：{message}")
    return {"ok": True, "file": path.name}
