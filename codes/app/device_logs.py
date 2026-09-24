"""设备日志压缩包扫描、时间识别与安全 Pull。

浏览器只能提交日志源名称和已扫描出的文件名；设备目录与解析规则始终从
当前 settings 重新读取，避免任意设备路径和本机输出路径穿越。
"""
from __future__ import annotations

import fnmatch
import gzip
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import android
from . import runtime, storage

def pull_root() -> Path:
    root = storage.downloads_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root
SAFE_SOURCE_NAME = re.compile(r"[\w .-]{1,80}", re.UNICODE)
SAFE_DEVICE_PATH = re.compile(r"/[A-Za-z0-9._/-]+")
SAFE_PULL_FOLDER = re.compile(r"device-logs-\d{8}-\d{6}(?:-\d+)?")
TIME_TYPES = {"none", "mtime", "filename_auto"}
LEGACY_FILENAME_TIME_TYPES = {"filename_single", "filename_range", "local_and_utc"}
TIME_MEANINGS = {"instant", "archive_start", "archive_end", "time_range"}
ARCHIVE_TYPES = {"none", "gzip"}
STAT_SEPARATOR = "\x1f"
AUTO_TIME_PATTERNS = (
    (re.compile(r"(?<!\d)(\d{14})(?!\d)"), "%Y%m%d%H%M%S"),
    (re.compile(r"(?<!\d)(\d{8}[_-]\d{6})(?!\d)"), None),
    (re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2}[T_ -]\d{2}[-:]\d{2}[-:]\d{2})(?!\d)"), None),
    (re.compile(r"(?<!\d)(\d{13})(?!\d)"), "unix_ms"),
    (re.compile(r"(?<!\d)(\d{10})(?!\d)"), "unix_s"),
)


def source_name(value: object) -> str:
    name = str(value or "").strip()
    if not SAFE_SOURCE_NAME.fullmatch(name):
        raise ValueError("日志源名称只能包含文字、字母、数字、空格、点、下划线或短横线")
    return name


def safe_file_name(value: object) -> str:
    name = str(value or "").strip()
    if not name or len(name) > 255 or name in {".", ".."} or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("日志文件名必须是设备目录下的单层文件名")
    return name


def sources(settings: dict) -> dict:
    raw = settings.get("device_log_sources", {})
    if not isinstance(raw, dict):
        raise ValueError("device_log_sources 必须是对象")
    result = {}
    for raw_name, value in raw.items():
        name = source_name(raw_name)
        result[name] = normalize_source(value)
    return result


def normalize_source(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("设备日志源配置必须是对象")
    directory = str(value.get("device_directory", "")).strip().rstrip("/") or "/"
    if directory == "/" or not SAFE_DEVICE_PATH.fullmatch(directory) or ".." in PurePosixPath(directory).parts:
        raise ValueError("设备日志目录必须是安全的绝对目录，且不能是根目录")
    pattern = str(value.get("file_pattern", "*")).strip() or "*"
    if "/" in pattern or "\\" in pattern or len(pattern) > 120:
        raise ValueError("文件匹配规则只能匹配当前目录下的文件名")
    archive_type = str(value.get("archive_type", "none")).strip()
    if archive_type not in ARCHIVE_TYPES:
        raise ValueError("当前仅支持 none 或 gzip 归档类型")
    time_rule = normalize_time_rule(value.get("time_rule", {}))
    return {"device_directory": directory, "file_pattern": pattern, "archive_type": archive_type, "time_rule": time_rule}


def normalize_time_rule(value: object) -> dict:
    rule = value if isinstance(value, dict) else {}
    kind = str(rule.get("type", "none")).strip() or "none"
    if kind in LEGACY_FILENAME_TIME_TYPES:
        kind = "filename_auto"
    if kind not in TIME_TYPES:
        raise ValueError("不支持的设备日志时间识别方式")
    meaning = str(rule.get("meaning", "instant")).strip() or "instant"
    if meaning not in TIME_MEANINGS:
        raise ValueError("不支持的日志归档时间含义")
    timezone_name = str(rule.get("timezone", "Asia/Shanghai")).strip() or "Asia/Shanghai"
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        raise ValueError(f"未知时区：{timezone_name}")
    return {
        "type": kind,
        "timezone": timezone_name,
        "meaning": meaning,
        "minimum_year": max(1970, min(9999, int(rule.get("minimum_year", 2020) or 2020))),
    }


def selected_source(settings: dict, name: object) -> tuple[str, dict]:
    clean_name = source_name(name)
    source = sources(settings).get(clean_name)
    if not source:
        raise ValueError("未知设备日志源，请刷新后重新选择")
    return clean_name, source


def _device_files(settings: dict, source: dict) -> list[dict]:
    directory = source["device_directory"]
    # 使用一次 find + stat 批量读取文件信息，避免数百个文件产生同等数量的 ADB 往返。
    stat_format = f"%n{STAT_SEPARATOR}%s{STAT_SEPARATOR}%Y"
    code, output, error = android.device_adb(settings, "shell", "find", directory, "-maxdepth", "1", "-type", "f", "-exec", "toybox", "stat", "-Lc", stat_format, "{}", "+", timeout=60)
    if code:
        raise ValueError(error or output or f"读取设备日志目录失败：{directory}")
    result = []
    for row in output.splitlines():
        columns = row.rsplit(STAT_SEPARATOR, 2)
        if len(columns) != 3 or not columns[1].isdigit() or not columns[2].isdigit():
            continue
        raw_path, size, mtime = columns
        path = PurePosixPath(raw_path)
        if path.parent != PurePosixPath(directory):
            continue
        try:
            name = safe_file_name(path.name)
        except ValueError:
            continue
        if not fnmatch.fnmatchcase(name, source["file_pattern"]):
            continue
        result.append({"name": name, "remote_path": str(path), "size": int(size), "mtime": int(mtime)})
    return sorted(result, key=lambda item: item["name"])


def _parse_stamp(value: str, fmt: str, tz: ZoneInfo) -> datetime:
    parsed = datetime.strptime(value, fmt)
    return parsed.replace(tzinfo=tz) if parsed.tzinfo is None else parsed.astimezone(tz)


def _parse_auto_stamp(value: str, fmt: object, tz: ZoneInfo) -> datetime:
    if fmt == "unix_ms":
        return datetime.fromtimestamp(int(value) / 1000, tz)
    if fmt == "unix_s":
        return datetime.fromtimestamp(int(value), tz)
    if fmt:
        return _parse_stamp(value, fmt, tz)
    compact = re.sub(r"\D", "", value)
    return _parse_stamp(compact, "%Y%m%d%H%M%S", tz)


def _auto_time_candidates(name: str, tz: ZoneInfo) -> list[datetime]:
    """按优先级抽取同一种时间格式，避免把流水号误当成时间。"""
    for pattern, fmt in AUTO_TIME_PATTERNS:
        values = pattern.findall(name)
        parsed = []
        for value in values[:2]:
            try:
                parsed.append(_parse_auto_stamp(value, fmt, tz))
            except (OverflowError, OSError, ValueError):
                continue
        if parsed:
            return parsed
    return []


def _auto_file_time(item: dict, rule: dict, tz: ZoneInfo) -> dict:
    candidates = _auto_time_candidates(item["name"], tz)
    if not candidates:
        return {"time_start": None, "time_end": None, "time_source": "文件名未识别", "time_confidence": "unknown", "time_warning": "未识别到可靠时间，可手动勾选"}
    if len(candidates) == 1:
        return _time_result(candidates[0], candidates[0], "自动识别文件名时间", rule)
    first, second = candidates
    offset = first.utcoffset()
    delta = (first - second).total_seconds()
    offset_seconds = offset.total_seconds() if offset is not None else 0
    if offset_seconds and abs(delta - offset_seconds) <= 1:
        return _time_result(first, first, "自动识别本地时间 + UTC", rule)
    if offset_seconds and abs(delta + offset_seconds) <= 1:
        return _time_result(second, second, "自动识别 UTC + 本地时间", rule)
    if second >= first:
        result = _time_result(first, second, "自动识别文件名起止时间", rule)
        result["time_explicit_range"] = True
        return result
    return {"time_start": None, "time_end": None, "time_source": "文件名存在歧义", "time_confidence": "unknown", "time_warning": "多个时间无法确定含义，可手动勾选"}


def parse_file_time(item: dict, rule: dict) -> dict:
    kind, tz = rule["type"], ZoneInfo(rule["timezone"])
    if kind == "none":
        return {"time_start": None, "time_end": None, "time_source": "未配置", "time_confidence": "unknown", "time_warning": ""}
    if kind == "mtime":
        value = datetime.fromtimestamp(item["mtime"], tz)
        return _time_result(value, value, "设备文件修改时间", rule)
    if kind == "filename_auto":
        return _auto_file_time(item, rule, tz)
    return {"time_start": None, "time_end": None, "time_source": "未配置", "time_confidence": "unknown", "time_warning": ""}


def _time_result(start: datetime, end: datetime, source: str, rule: dict) -> dict:
    warning = ""
    confidence = "high"
    if start.year < rule["minimum_year"] or end.year < rule["minimum_year"]:
        warning, confidence = f"年份早于 {rule['minimum_year']}，车机时间可能无效", "low"
    if end < start:
        warning, confidence = "结束时间早于开始时间", "low"
    return {"time_start": start.isoformat(), "time_end": end.isoformat(), "time_source": source, "time_confidence": confidence, "time_warning": warning}


def _requested_time(value: object, tz: ZoneInfo, label: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        raise ValueError(f"{label}格式无效")
    return parsed.replace(tzinfo=tz) if parsed.tzinfo is None else parsed.astimezone(tz)


def _overlaps(item: dict, start: datetime | None, end: datetime | None) -> bool:
    if not start and not end:
        return False
    if item.get("time_confidence") != "high":
        return False
    if not item["time_start"] or not item["time_end"]:
        return False
    item_start, item_end = datetime.fromisoformat(item["time_start"]), datetime.fromisoformat(item["time_end"])
    return (not start or item_end >= start) and (not end or item_start <= end)


def _infer_archive_ranges(files: list[dict], meaning: str) -> None:
    """用相邻归档点推导覆盖区间；缺少相邻边界时保留单点语义。"""
    known = sorted((item for item in files if item.get("time_start") and item.get("time_confidence") == "high" and not item.get("time_explicit_range")), key=lambda item: item["time_start"])
    if meaning == "archive_end":
        for index, item in enumerate(known):
            if index:
                item["time_start"] = known[index - 1]["time_end"]
    elif meaning == "archive_start":
        for index, item in enumerate(known[:-1]):
            item["time_end"] = known[index + 1]["time_start"]


def scan(settings: dict, body: dict) -> dict:
    name, source = selected_source(settings, body.get("source"))
    tz = ZoneInfo(source["time_rule"]["timezone"])
    start = _requested_time(body.get("start"), tz, "开始时间")
    end = _requested_time(body.get("end"), tz, "结束时间")
    if start and end and end < start:
        raise ValueError("结束时间不能早于开始时间")
    files = [{**item, **parse_file_time(item, source["time_rule"])} for item in _device_files(settings, source)]
    _infer_archive_ranges(files, source["time_rule"]["meaning"])
    for item in files:
        item["suggested"] = _overlaps(item, start, end)
        item.pop("remote_path", None)
        item.pop("time_explicit_range", None)
    recognized = sum(item.get("time_confidence") == "high" for item in files)
    total_count = len(files)
    time_filter_available = source["time_rule"]["type"] != "none" and (source["time_rule"]["type"] != "filename_auto" or recognized > 0)
    if (start or end) and time_filter_available:
        files = [item for item in files if item["suggested"]]
    files.sort(key=lambda item: (item["time_end"] or "", item["mtime"], item["name"]), reverse=True)
    return {
        "source": name, "device_directory": source["device_directory"], "file_pattern": source["file_pattern"],
        "time_filter_applied": bool(start or end), "time_filter_available": time_filter_available,
        "time_recognized": recognized,
        "files": files, "count": len(files), "total_count": total_count,
    }


def _safe_pull_folder() -> Path:
    root = pull_root().resolve()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = root / f"device-logs-{timestamp}"
    suffix = 2
    while folder.exists():
        folder = root / f"device-logs-{timestamp}-{suffix}"
        suffix += 1
    if root not in folder.resolve().parents:
        raise ValueError("本地日志输出目录越界")
    folder.mkdir(parents=True, exist_ok=False)
    return folder


def _extract_gzip(path: Path) -> str:
    destination = path.with_suffix("")
    with gzip.open(path, "rb") as source, destination.open("xb") as target:
        shutil.copyfileobj(source, target)
    return destination.name


def reveal_pull_folder(value: object) -> dict:
    folder_name = str(value or "").strip()
    if not SAFE_PULL_FOLDER.fullmatch(folder_name):
        raise ValueError("Pull 文件夹标识无效")
    root = pull_root().resolve()
    folder = (root / folder_name).resolve()
    if folder.parent != root or not folder.is_dir():
        raise ValueError("Pull 文件夹不存在或不在系统下载目录中")
    return runtime.reveal_directory(folder, "Pull 文件夹")


def pull(settings: dict, body: dict) -> dict:
    name, source = selected_source(settings, body.get("source"))
    requested = body.get("files", [])
    if not isinstance(requested, list) or not requested:
        raise ValueError("请至少选择一个设备日志文件")
    if len(requested) > 500:
        raise ValueError("单次最多 Pull 500 个日志文件")
    requested_names = list(dict.fromkeys(safe_file_name(item) for item in requested))
    fresh = {item["name"]: item for item in _device_files(settings, source)}
    missing = [item for item in requested_names if item not in fresh]
    if missing:
        raise ValueError("所选日志已不存在或不再符合日志源规则：" + "、".join(missing[:5]))
    folder = _safe_pull_folder()
    results, extracted = [], []
    for file_name in requested_names:
        item = fresh[file_name]
        destination = folder / file_name
        code, output, error = android.device_adb(settings, "pull", item["remote_path"], str(destination), timeout=600)
        result = {"name": file_name, "ok": code == 0, "output": output or error}
        results.append(result)
        if code:
            # 已成功 Pull 的文件保留在本次目录中，便于用户直接取用。
            raise ValueError(f"Pull 失败：{file_name}：{error or output}")
        if body.get("extract") and source["archive_type"] == "gzip":
            extracted.append(_extract_gzip(destination))
    return {"ok": True, "folder": str(folder), "folder_id": folder.name, "files": len(results), "results": results, "extracted": extracted}
