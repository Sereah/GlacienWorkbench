"""ADB Bugreport 长任务与受控产物管理。"""

from __future__ import annotations

import re
import os
import shutil
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from . import android, proc, storage


SAFE_NOTE = re.compile(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+")
_lock = threading.RLock()
_session: dict = {}


def _files_root() -> Path:
    return storage.data_dir("bugreports", "files")


def _runtime_root() -> Path:
    return storage.data_dir("bugreports", "runtime")


def _safe_part(value: object, fallback: str) -> str:
    text = SAFE_NOTE.sub("_", str(value or "").strip()).strip("._-")
    return text[:48] or fallback


def _payload(path: Path) -> dict:
    stat = path.stat()
    return {
        "id": path.name,
        "name": path.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "url": "/api/bugreports/download?id=" + quote(path.name),
    }


def resolve_file(value: object) -> Path:
    name = str(value or "").strip()
    if not name or Path(name).name != name or not name.lower().endswith(".zip"):
        raise ValueError("Bugreport 文件 ID 无效")
    root = _files_root().resolve()
    path = (root / name).resolve()
    if path.parent != root or not path.is_file() or path.is_symlink():
        raise ValueError("Bugreport 文件不存在")
    return path


def files() -> dict:
    items = [_payload(path) for path in _files_root().glob("*.zip") if path.is_file() and not path.is_symlink()]
    items.sort(key=lambda item: (item["modified"], item["name"]), reverse=True)
    return {"items": items}


def _public_session() -> dict:
    if not _session:
        return {"state": "idle"}
    return {key: value for key, value in _session.items() if key not in {"process", "temporary_directory"}}


def status() -> dict:
    with _lock:
        return _public_session()


def _finish(process, temporary_directory: Path, requested_output: Path) -> None:
    stdout, stderr = process.communicate()
    with _lock:
        if _session.get("process") is not process:
            shutil.rmtree(temporary_directory, ignore_errors=True)
            return
        cancelled = _session.get("state") == "cancelling"
        candidates = sorted(temporary_directory.rglob("*.zip"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not cancelled and process.returncode == 0 and candidates and candidates[0].stat().st_size > 0:
            output = requested_output
            index = 2
            while output.exists():
                output = requested_output.with_name(f"{requested_output.stem}-{index}.zip")
                index += 1
            shutil.move(str(candidates[0]), output)
            _session.clear()
            _session.update({"state": "completed", "finished_at": time.time(), "file": _payload(output), "message": "Bugreport 采集完成"})
        elif cancelled:
            _session.clear()
            _session.update({"state": "cancelled", "finished_at": time.time(), "message": "Bugreport 已取消"})
        else:
            message = (stderr or stdout or "Bugreport 采集失败").strip().splitlines()[-1]
            _session.clear()
            _session.update({"state": "failed", "finished_at": time.time(), "message": message})
    shutil.rmtree(temporary_directory, ignore_errors=True)


def start(settings: dict, body: dict) -> dict:
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    executable = android.tool("adb", settings)
    if not serial or not executable:
        raise ValueError("未找到可用的 ADB 设备")
    with _lock:
        if _session.get("state") in {"running", "cancelling"}:
            raise ValueError("已有 Bugreport 正在采集")
        temporary_directory = _runtime_root() / f"task-{uuid.uuid4().hex}"
        temporary_directory.mkdir(parents=True, exist_ok=False)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"bugreport-{_safe_part(serial, 'device')}-{timestamp}"
        note = _safe_part(body.get("note"), "")
        if note:
            name += f"-{note}"
        output = _files_root() / f"{name}.zip"
        try:
            process = proc.Popen(
                [executable, "-s", serial, "bugreport", str(temporary_directory)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as error:
            shutil.rmtree(temporary_directory, ignore_errors=True)
            raise ValueError(f"无法启动 Bugreport：{error}") from error
        _session.clear()
        _session.update({
            "state": "running", "serial": serial, "started_at": time.time(), "message": "正在采集 Bugreport…",
            "process": process, "temporary_directory": temporary_directory,
        })
        threading.Thread(target=_finish, args=(process, temporary_directory, output), name="glacien-bugreport", daemon=True).start()
        return _public_session()


def _terminate_after_grace(process, seconds: float = 5.0) -> None:
    """中断未生效时终止子进程，避免取消状态永久挂起。"""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return
        time.sleep(.1)
    try:
        process.terminate()
    except OSError:
        pass


def cancel() -> dict:
    with _lock:
        process = _session.get("process")
        if _session.get("state") != "running" or process is None:
            raise ValueError("当前没有正在采集的 Bugreport")
        _session["state"] = "cancelling"
        _session["message"] = "正在取消 Bugreport…"
        try:
            if os.name != "nt" and hasattr(signal, "SIGINT"):
                process.send_signal(signal.SIGINT)
            else:
                process.terminate()
        except OSError:
            process.terminate()
        threading.Thread(target=_terminate_after_grace, args=(process,), name="glacien-bugreport-cancel", daemon=True).start()
        return _public_session()


def delete(value: object) -> dict:
    path = resolve_file(value)
    path.unlink()
    return {"ok": True, "id": path.name}
