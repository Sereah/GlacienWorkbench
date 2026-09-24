"""本地 PCM 文件管理与 FFmpeg 播放预览。"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from urllib.parse import quote

from . import proc, runtime, storage

# 导入模块时不写磁盘；目录由存储初始化或首次业务操作创建。
INPUT_ROOT = storage.ROOT / "local-tools" / "audio-processing" / "inputs"
PREVIEW_ROOT = storage.ROOT / "local-tools" / "audio-processing" / "previews"
MAX_PCM_SIZE = 2 * 1024 * 1024 * 1024
MAX_CHANNELS = 32
PREVIEW_TIMEOUT_SECONDS = 300
MAX_PREVIEWS = 20
PCM_FORMATS = {
    "u8": {"bytes": 1, "label": "Unsigned 8-bit"},
    "s16le": {"bytes": 2, "label": "Signed 16-bit LE"},
    "s24le": {"bytes": 3, "label": "Signed 24-bit LE"},
    "s32le": {"bytes": 4, "label": "Signed 32-bit LE"},
    "f32le": {"bytes": 4, "label": "Float 32-bit LE"},
    "f64le": {"bytes": 8, "label": "Float 64-bit LE"},
}
COMMON_SAMPLE_RATES = {8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000}
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _candidates() -> list[Path]:
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return [Path("/opt/homebrew/bin/ffmpeg"), Path("/usr/local/bin/ffmpeg"), Path("/opt/local/bin/ffmpeg")]
    if system == "Windows":
        result = [home / "scoop/shims/ffmpeg.exe"]
        for variable, relative in (("LOCALAPPDATA", "Microsoft/WinGet/Links/ffmpeg.exe"), ("PROGRAMDATA", "chocolatey/bin/ffmpeg.exe")):
            if root := os.environ.get(variable):
                result.append(Path(root) / relative)
        return result
    return [Path("/usr/bin/ffmpeg"), Path("/usr/local/bin/ffmpeg"), Path("/snap/bin/ffmpeg"), home / ".local/bin/ffmpeg"]


def _valid_executable(path: Path) -> bool:
    return path.name.lower() in {"ffmpeg", "ffmpeg.exe"} and path.is_file() and os.access(path, os.X_OK)


def ffmpeg_executable(settings: dict) -> str | None:
    configured = str(settings.get("ffmpeg_path", "")).strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        return str(path) if _valid_executable(path) else None
    if found := shutil.which("ffmpeg"):
        return found
    return next((str(path) for path in _candidates() if _valid_executable(path)), None)


def _version(executable: str) -> str:
    try:
        result = proc.run([executable, "-version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"无法执行 FFmpeg：{error}") from error
    if result.returncode:
        raise ValueError(result.stderr.strip() or "FFmpeg 版本检查失败")
    return (result.stdout.splitlines() or ["FFmpeg"])[0].strip()


def capability(settings: dict) -> dict:
    executable = ffmpeg_executable(settings)
    if not executable:
        return {"available": False, "path": "", "version": "", "configured_path": str(settings.get("ffmpeg_path", ""))}
    try:
        version = _version(executable)
    except ValueError as error:
        return {"available": False, "path": executable, "version": "", "configured_path": str(settings.get("ffmpeg_path", "")), "error": str(error)}
    return {"available": True, "path": executable, "version": version, "configured_path": str(settings.get("ffmpeg_path", ""))}


def save_ffmpeg_path(value: object) -> dict:
    raw = str(value or "").strip()
    if raw:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise ValueError("FFmpeg 路径必须是绝对路径")
        path = path.resolve()
        if not _valid_executable(path):
            raise ValueError("请选择名为 ffmpeg 或 ffmpeg.exe 的可执行文件")
        _version(str(path))
        raw = str(path)
    storage.update("audio_processing", {"ffmpeg_path": raw})
    settings = {"ffmpeg_path": raw}
    return {"ok": True, **capability(settings)}


def _safe_stem(filename: object) -> str:
    name = Path(str(filename or "")).name
    if not name or name in {".", ".."}:
        raise ValueError("PCM 文件名无效")
    stem = Path(name).stem if Path(name).suffix else name
    return SAFE_NAME.sub("_", stem).strip("._")[:80] or "audio"


def _resolve(root: Path, file_id: object, suffix: str) -> Path:
    value = str(file_id or "").strip()
    pattern = r"[a-f0-9]{32}(?:_[A-Za-z0-9._-]{1,84})?" + re.escape(suffix)
    if not re.fullmatch(pattern, value):
        raise ValueError("音频文件 ID 无效")
    path = (root / value).resolve()
    if path.parent != root.resolve() or not path.is_file() or path.is_symlink():
        raise ValueError("音频文件不存在")
    return path


def _payload(path: Path) -> dict:
    stat = path.stat()
    display_name = path.name.split("_", 1)[1] if "_" in path.name else path.name
    return {"id": path.name, "name": display_name, "size": stat.st_size, "modified": int(stat.st_mtime)}


def upload(filename: object, content: bytes) -> dict:
    if not content:
        raise ValueError("PCM 文件为空")
    if len(content) > MAX_PCM_SIZE:
        raise ValueError("PCM 文件不能超过 2 GB")
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix not in {"", ".pcm", ".raw"}:
        raise ValueError("仅支持 .pcm、.raw 或无扩展名的裸 PCM 文件")
    stored_name = f"{uuid.uuid4().hex}_{_safe_stem(filename)}.pcm"
    INPUT_ROOT.mkdir(parents=True, exist_ok=True)
    path = INPUT_ROOT / stored_name
    path.write_bytes(content)
    return {"ok": True, "file": _payload(path)}


def files() -> dict:
    items = [_payload(path) for path in INPUT_ROOT.glob("*.pcm") if path.is_file() and not path.is_symlink()]
    items.sort(key=lambda item: (item["modified"], item["name"]), reverse=True)
    return {"items": items}


def _pcm_parameters(body: dict) -> tuple[str, int, int, str, int | None]:
    sample_format = str(body.get("sample_format", "")).strip()
    if sample_format not in PCM_FORMATS:
        raise ValueError("PCM 采样格式无效")
    try:
        sample_rate = int(body.get("sample_rate"))
        channels = int(body.get("channels"))
    except (TypeError, ValueError) as error:
        raise ValueError("采样率和通道数必须是整数") from error
    if sample_rate not in COMMON_SAMPLE_RATES:
        raise ValueError("请选择受支持的采样率")
    if channels < 1 or channels > MAX_CHANNELS:
        raise ValueError(f"通道数必须为 1-{MAX_CHANNELS}")
    mode = str(body.get("mode", "all"))
    if mode not in {"all", "channel"}:
        raise ValueError("播放模式无效")
    channel = None
    if mode == "channel":
        try:
            channel = int(body.get("channel"))
        except (TypeError, ValueError) as error:
            raise ValueError("请选择要播放的通道") from error
        if channel < 1 or channel > channels:
            raise ValueError(f"通道必须为 1-{channels}")
    return sample_format, sample_rate, channels, mode, channel


def estimate(file_id: object, body: dict) -> dict:
    path = _resolve(INPUT_ROOT, file_id, ".pcm")
    sample_format, sample_rate, channels, _, _ = _pcm_parameters(body)
    frame_bytes = PCM_FORMATS[sample_format]["bytes"] * channels
    size = path.stat().st_size
    return {"duration_seconds": round(size / frame_bytes / sample_rate, 3), "frame_bytes": frame_bytes, "trailing_bytes": size % frame_bytes}


def preview(settings: dict, body: dict) -> dict:
    source = _resolve(INPUT_ROOT, body.get("id"), ".pcm")
    sample_format, sample_rate, channels, mode, channel = _pcm_parameters(body)
    executable = ffmpeg_executable(settings)
    if not executable:
        raise ValueError("未找到 FFmpeg，请先安装或配置 ffmpeg 可执行文件路径")
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    output = PREVIEW_ROOT / f"{uuid.uuid4().hex}.wav"
    command = [executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", sample_format, "-ar", str(sample_rate), "-ac", str(channels), "-i", str(source)]
    if mode == "channel":
        command.extend(["-af", f"pan=mono|c0=c{channel - 1}", "-ac", "1"])
    elif channels > 2:
        command.extend(["-ac", "2"])
    command.extend(["-c:a", "pcm_s16le", "-y", str(output)])
    try:
        result = proc.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=PREVIEW_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        output.unlink(missing_ok=True)
        raise ValueError(f"PCM 预览生成超时（>{PREVIEW_TIMEOUT_SECONDS} 秒）") from error
    except OSError as error:
        output.unlink(missing_ok=True)
        raise ValueError(f"无法执行 FFmpeg：{error}") from error
    if result.returncode or not output.is_file():
        output.unlink(missing_ok=True)
        raise ValueError(result.stderr.strip() or "FFmpeg 未生成播放预览")
    # 预览是可再生缓存，只保留最近文件，避免长期播放逐步占满用户数据目录。
    previews = sorted((path for path in PREVIEW_ROOT.glob("*.wav") if path.is_file() and not path.is_symlink()), key=lambda path: path.stat().st_mtime, reverse=True)
    for stale in previews[MAX_PREVIEWS:]:
        stale.unlink(missing_ok=True)
    storage.update("audio_processing", {"sample_format": sample_format, "sample_rate": sample_rate, "channels": channels})
    duration = estimate(source.name, body)["duration_seconds"]
    return {"ok": True, "preview_id": output.name, "url": "/api/audio/preview?id=" + quote(output.name), "duration_seconds": duration}


def resolve_preview(file_id: object) -> Path:
    return _resolve(PREVIEW_ROOT, file_id, ".wav")


def delete(file_id: object) -> dict:
    path = _resolve(INPUT_ROOT, file_id, ".pcm")
    path.unlink()
    return {"ok": True}


def reveal_outputs() -> dict:
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    return runtime.reveal_directory(PREVIEW_ROOT, "PCM 预览目录")
