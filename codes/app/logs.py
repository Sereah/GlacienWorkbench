"""本地离线日志来源与原生 rg 查询。

浏览器只提交配置中已保存的来源名称，后端重新从当前 settings 解析目录，
避免信任前端传入的任意本地路径；匹配由原生 ripgrep 完成以应对多 GiB 日志。
"""
from __future__ import annotations

import json
import gzip
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import proc, storage

MAX_FILTERS = 30
MAX_TERMS = 100
QUERY_TIMEOUT_SECONDS = 300
VALID_MODES = {"include_any", "include_all", "exclude_any"}
LOG_PRIORITY_RANK = {priority: rank for rank, priority in enumerate(("V", "D", "I", "W", "E", "F"))}
LOG_PRIORITY_CHARS = {"V": "VDIWEFA", "D": "DIWEFA", "I": "IWEFA", "W": "WEFA", "E": "EFA", "F": "FA"}
THREADTIME_PRIORITY = re.compile(r"^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEFA])\s+")
ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar", ".zip", ".gz")
MAX_ARCHIVE_FILES = 100_000
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 500
_ARCHIVE_LOCK = threading.Lock()


def _managed_sources_root() -> Path:
    return storage.data_dir("offline_logs", "sources")


def _source_id() -> str:
    return "src_" + uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _safe_display_name(value: object) -> str:
    name = str(value or "").strip()
    if not name:
        raise ValueError("请填写日志来源名称")
    if any(ord(char) in (0, 10, 13) for char in name):
        raise ValueError("日志来源名称不能包含换行或控制字符")
    if len(name) > 80:
        raise ValueError("日志来源名称不能超过 80 个字符")
    return name


def _is_windows_absolute(value: str) -> bool:
    return len(value) >= 3 and re.match(r"^[A-Za-z]:", value[:2]) and value[2] in {"/", "\\"}


def _input_path(value: object) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("请选择日志文件或文件夹")
    if not raw.startswith("/") and not _is_windows_absolute(raw):
        raise ValueError("日志来源必须是绝对路径")
    return Path(raw).expanduser().resolve()


def _scan_tree(root: Path) -> dict:
    if root.is_file():
        stat = root.stat()
        return {"bytes": stat.st_size, "file_count": 1}
    total, count = 0, 0
    for item in root.rglob("*"):
        if not item.is_file() or item.is_symlink():
            continue
        try:
            total += item.stat().st_size
            count += 1
        except OSError:
            continue
    return {"bytes": total, "file_count": count}


def _relative_to_root(path: Path) -> str:
    return path.resolve().relative_to(_managed_sources_root().resolve()).as_posix()


def _managed_path(relative: object) -> Path:
    root = _managed_sources_root().resolve()
    target = (root / str(relative or "")).resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError("日志来源路径越界") from error
    return target


def _source_record(settings: dict, name: object) -> tuple[str, dict]:
    clean_name = str(name or "").strip()
    raw = settings.get("offline_log_sources", {}).get(clean_name)
    if not clean_name or raw is None:
        raise ValueError("请选择当前配置中已保存的日志来源")
    if isinstance(raw, dict):
        return clean_name, raw
    return clean_name, {"id": "legacy", "path": str(raw), "managed": False, "legacy": True, "original_path": str(raw)}


def _record_path(record: dict) -> Path:
    if record.get("managed"):
        return _managed_path(record.get("path", ""))
    return Path(str(record.get("path") or record.get("original_path") or "")).expanduser().resolve()

def _rg_candidates() -> list[Path]:
    """返回 PATH 之外的常见 rg 安装位置；桌面应用通常不继承终端 PATH。"""
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return [Path("/opt/homebrew/bin/rg"), Path("/usr/local/bin/rg"), home / ".cargo/bin/rg", home / ".local/bin/rg"]
    if system == "Windows":
        candidates = [home / ".cargo/bin/rg.exe", home / "scoop/shims/rg.exe"]
        for variable, relative in (("PROGRAMDATA", "chocolatey/bin/rg.exe"), ("LOCALAPPDATA", "Microsoft/WinGet/Links/rg.exe")):
            if root := os.environ.get(variable):
                candidates.append(Path(root) / relative)
        return candidates
    return [Path("/usr/bin/rg"), Path("/usr/local/bin/rg"), Path("/snap/bin/rg"), home / ".cargo/bin/rg", home / ".local/bin/rg"]

def rg_executable() -> Optional[str]:
    """定位原生 rg，兼容桌面宿主缺少 Homebrew/Cargo PATH 的场景。"""
    if found := shutil.which("rg"):
        return found
    for candidate in _rg_candidates():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None

def capability() -> dict:
    """返回当前进程能否调用原生 rg，供界面在选择扫描方式前提示。"""
    executable = rg_executable()
    return {"available": bool(executable), "path": executable or ""}

def _source_status(path: Path) -> tuple[bool, str, str]:
    if path.is_dir():
        return True, "directory", ""
    if path.is_file() and _archive_kind(path):
        return False, "archive", "压缩日志请配置其所在文件夹，以便安全解压"
    if path.is_file():
        return True, "file", ""
    return False, "missing", "文件或文件夹不可用"


def _source_summary(path: Path) -> dict:
    available, kind, error = _source_status(path)
    stats = _scan_tree(path) if available else {"bytes": 0, "file_count": 0}
    archives = _archives(path) if path.is_dir() else []
    return {
        "path": str(path),
        "available": available,
        "kind": kind,
        "error": error,
        "bytes": stats["bytes"],
        "file_count": stats["file_count"],
        "archive_count": len(archives),
        "archives": [{"path": str(item.relative_to(path)), "bytes": item.stat().st_size} for item in archives[:50]],
    }


def sources(settings: dict) -> list[dict]:
    """列出已保存的日志文件或目录来源，不接受浏览器路径参数。"""
    result = []
    for name, raw in settings.get("offline_log_sources", {}).items():
        record = raw if isinstance(raw, dict) else {"path": str(raw), "managed": False, "legacy": True}
        path = _record_path(record)
        available, kind, error = _source_status(path)
        stats = _scan_tree(path) if available else {"bytes": 0, "file_count": 0}
        ignored = record.get("ignored_archives") if isinstance(record.get("ignored_archives"), list) else []
        result.append({
            "name": str(name),
            "path": str(path),
            "available": available,
            "kind": kind,
            "error": error,
            "managed": bool(record.get("managed")),
            "legacy": bool(record.get("legacy")),
            "bytes": stats["bytes"],
            "file_count": stats["file_count"],
            "ignored_archives": ignored,
            "ignored_count": len(ignored),
            "imported_at": str(record.get("imported_at", "")),
            "original_path": str(record.get("original_path", "")),
        })
    return sorted(result, key=lambda item: item["name"])

def source_path(settings: dict, name: object) -> tuple[str, Path]:
    """按来源名称重建当前 settings 白名单中的文件或目录，拒绝未保存路径。"""
    clean_name, record = _source_record(settings, name)
    path = _record_path(record)
    available, kind, error = _source_status(path)
    if not available:
        detail = error or "文件或文件夹不可用"
        raise ValueError(f"日志来源不可用：{path}（{detail}）")
    if kind not in {"file", "directory"}:
        raise ValueError(f"日志来源类型不受支持：{path}")
    return clean_name, path

def _archive_kind(path: Path) -> Optional[str]:
    lower = path.name.lower()
    if lower.endswith((".tar.gz", ".tgz")):
        return "tar.gz"
    if lower.endswith(".tar"):
        return "tar"
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(".gz"):
        return "gzip"
    return None

def _safe_destination(root: Path, member_name: str) -> Path:
    """解析归档成员路径，拒绝绝对路径和跳出工作区的路径。"""
    normalized = member_name.replace("\\", "/")
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
        raise ValueError(f"压缩包包含不安全路径：{member_name}")
    destination = (root / normalized).resolve()
    try:
        destination.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"压缩包包含越界路径：{member_name}") from error
    return destination

def _validate_archive_size(file_count: int, expanded_bytes: int, compressed_bytes: int) -> None:
    if file_count > MAX_ARCHIVE_FILES:
        raise ValueError(f"压缩包文件数超过限制：{file_count}")
    if expanded_bytes > MAX_ARCHIVE_BYTES:
        raise ValueError(f"压缩包展开大小超过限制：{expanded_bytes} bytes")
    if compressed_bytes > 0 and expanded_bytes > compressed_bytes * MAX_COMPRESSION_RATIO:
        raise ValueError("压缩包展开倍率异常，已停止解压")

def _extract_zip(archive: Path, destination: Path) -> int:
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        files = [member for member in members if not member.is_dir()]
        _validate_archive_size(len(files), sum(member.file_size for member in files), archive.stat().st_size)
        targets = []
        for member in members:
            mode = member.external_attr >> 16
            file_type = mode & 0o170000
            if file_type not in {0, 0o040000, 0o100000}:
                raise ValueError(f"压缩包包含链接或特殊文件：{member.filename}")
            target = _safe_destination(destination, member.filename)
            if not member.is_dir():
                targets.append(target)
        existing = next((target for target in targets if target.exists()), None)
        if existing is not None:
            raise FileExistsError(17, "目标文件已存在", str(existing))
        for member in members:
            target = _safe_destination(destination, member.filename)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
        return len(files)

def _extract_tar(archive: Path, destination: Path) -> int:
    with tarfile.open(archive, "r:*") as bundle:
        members = bundle.getmembers()
        files = [member for member in members if member.isfile()]
        if any(not member.isfile() and not member.isdir() for member in members):
            raise ValueError("压缩包包含链接或特殊文件，已拒绝解压")
        _validate_archive_size(len(files), sum(member.size for member in files), archive.stat().st_size)
        targets = [_safe_destination(destination, member.name) for member in files]
        existing = next((target for target in targets if target.exists()), None)
        if existing is not None:
            raise FileExistsError(17, "目标文件已存在", str(existing))
        for member in members:
            target = _safe_destination(destination, member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise ValueError(f"无法读取压缩成员：{member.name}")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
        return len(files)

def _extract_gzip(archive: Path, destination: Path) -> int:
    output_name = archive.name[:-3] or archive.stem or "log"
    target = _safe_destination(destination, output_name)
    if target.exists():
        raise FileExistsError(17, "目标文件已存在", str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with gzip.open(archive, "rb") as source, target.open("xb") as output:
        while chunk := source.read(1024 * 1024):
            written += len(chunk)
            _validate_archive_size(1, written, archive.stat().st_size)
            output.write(chunk)
    return 1

def _archives(source: Path) -> list[Path]:
    if not source.is_dir():
        return []
    return sorted(path for path in source.rglob("*") if path.is_file() and not path.is_symlink() and _archive_kind(path))

def archive_status(settings: dict, source: object) -> dict:
    source_name, folder = source_path(settings, source)
    archives = _archives(folder)
    return {
        "source": source_name,
        "path": str(folder),
        "archives": [{"path": str(path.relative_to(folder)), "bytes": path.stat().st_size} for path in archives],
    }

def _extract_archive_here(archive: Path) -> int:
    # 先在压缩包当前目录的隐藏临时区完整展开并校验，成功后再移入当前目录。
    # 这样异常归档不会留下半截文件，同时不会产生需要长期清理的应用缓存。
    staging = Path(tempfile.mkdtemp(prefix=".glacien-extract-", dir=archive.parent))
    try:
        kind = _archive_kind(archive)
        if kind == "zip":
            files = _extract_zip(archive, staging)
        elif kind in {"tar", "tar.gz"}:
            files = _extract_tar(archive, staging)
        elif kind == "gzip":
            files = _extract_gzip(archive, staging)
        else:
            raise ValueError(f"不支持的压缩格式：{archive.name}")
        staged_files = sorted(path for path in staging.rglob("*") if path.is_file())
        targets = [(path, _safe_destination(archive.parent, str(path.relative_to(staging)))) for path in staged_files]
        existing = next((target for _, target in targets if target.exists()), None)
        if existing is not None:
            raise FileExistsError(17, "目标文件已存在", str(existing))
        created_directories = []
        moved_files = []
        try:
            for source, target in targets:
                missing = []
                parent = target.parent
                while parent != archive.parent and not parent.exists():
                    missing.append(parent)
                    parent = parent.parent
                target.parent.mkdir(parents=True, exist_ok=True)
                created_directories.extend(reversed(missing))
                source.replace(target)
                moved_files.append(target)
            # 全部展开内容就位后才删除原包；删除失败会回滚展开内容并保留原包。
            archive.unlink()
        except Exception:
            for target in reversed(moved_files):
                target.unlink(missing_ok=True)
            for directory in reversed(created_directories):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            raise
        return files
    finally:
        shutil.rmtree(staging, ignore_errors=True)

def extract_archives(settings: dict, body: dict) -> dict:
    """经用户明确确认后，以展开内容替换各压缩包。"""
    if body.get("confirmed") is not True:
        raise ValueError("解压前必须由用户确认")
    source_name, folder = source_path(settings, body.get("source"))
    archives = _archives(folder)
    extracted, files, skipped = 0, 0, []
    with _ARCHIVE_LOCK:
        for archive in archives:
            try:
                files += _extract_archive_here(archive)
                extracted += 1
            except FileExistsError as error:
                skipped.append(f"{archive.relative_to(folder)}：目标已存在 {Path(error.filename or '').name}")
            except (OSError, ValueError, zipfile.BadZipFile, tarfile.TarError) as error:
                skipped.append(f"{archive.relative_to(folder)}：{error}")
    return {"source": source_name, "path": str(folder), "archives": len(archives), "extracted": extracted, "files": files, "skipped": skipped}


def _unique_destination(name: str, source_id: str, source: Path) -> Path:
    base = _managed_sources_root() / source_id
    base.mkdir(parents=True, exist_ok=False)
    return base / source.name


def _move_into_managed(source: Path, source_id: str) -> Path:
    if not source.exists():
        raise ValueError(f"日志来源不存在：{source}")
    if source.is_symlink():
        raise ValueError("日志来源不能是符号链接")
    try:
        source.relative_to(_managed_sources_root().resolve())
        raise ValueError("日志来源已经在用户数据目录中，请直接选择已导入来源")
    except ValueError as error:
        if "用户数据目录" in str(error):
            raise
    if _archive_kind(source):
        raise ValueError("单独的压缩日志请改选其所在文件夹")
    destination = _unique_destination(source.name, source_id, source)
    try:
        shutil.move(str(source), str(destination))
    except Exception:
        shutil.rmtree(destination.parent, ignore_errors=True)
        raise
    return destination


def _extract_archives_in_folder(folder: Path, ignore_failed: bool) -> dict:
    archives = _archives(folder)
    extracted, files, skipped = 0, 0, []
    for archive in archives:
        relative = str(archive.relative_to(folder))
        try:
            files += _extract_archive_here(archive)
            extracted += 1
        except FileExistsError as error:
            skipped.append({"path": relative, "error": f"目标已存在 {Path(error.filename or '').name}", "ignored": True})
        except (OSError, ValueError, zipfile.BadZipFile, tarfile.TarError, EOFError) as error:
            if not ignore_failed:
                skipped.append({"path": relative, "error": str(error), "ignored": False})
            else:
                skipped.append({"path": relative, "error": str(error), "ignored": True})
    blocking = [item for item in skipped if not item["ignored"]]
    return {
        "archives": len(archives),
        "extracted": extracted,
        "files": files,
        "skipped": skipped,
        "blocking": blocking,
        "ignored_archives": [item for item in skipped if item["ignored"]],
    }


def preview_import(body: dict) -> dict:
    """预览一次来源导入，展示移动前大小和压缩包清单。"""
    name = _safe_display_name(body.get("name"))
    source = _input_path(body.get("path"))
    available, kind, error = _source_status(source)
    if not available:
        raise ValueError(error or f"日志来源不可用：{source}")
    if kind == "archive":
        raise ValueError("单独的压缩日志请改选其所在文件夹")
    summary = _source_summary(source)
    return {"name": name, "source_path": str(source), **summary}


def import_source(settings: dict, body: dict) -> dict:
    """将用户选择的日志来源移动进用户数据目录，并在受管目录内处理压缩包。"""
    if body.get("confirmed") is not True:
        raise ValueError("导入日志来源前必须由用户确认")
    name = _safe_display_name(body.get("name"))
    source = _input_path(body.get("path"))
    sources_map = dict(settings.get("offline_log_sources", {}))
    if name in sources_map and not body.get("replace"):
        raise ValueError(f"日志来源名称已存在：{name}")
    source_id = _source_id()
    with _ARCHIVE_LOCK:
        managed = _move_into_managed(source, source_id)
        try:
            extract_result = _extract_archives_in_folder(managed if managed.is_dir() else managed.parent, bool(body.get("ignore_failed_archives")))
            if extract_result["blocking"]:
                first = extract_result["blocking"][0]
                raise ValueError(f"压缩包解压失败：{first['path']}：{first['error']}。可选择忽略失败项后继续保存。")
            stats = _scan_tree(managed)
            record = {
                "id": source_id,
                "path": _relative_to_root(managed),
                "managed": True,
                "kind": "directory" if managed.is_dir() else "file",
                "original_path": str(source),
                "imported_at": _now_iso(),
                "bytes": stats["bytes"],
                "file_count": stats["file_count"],
                "ignored_archives": extract_result["ignored_archives"],
            }
            if name in sources_map:
                _delete_source_files(sources_map[name])
            sources_map[name] = record
            offline_config = storage.update("offline_logs", {"offline_log_sources": sources_map})
            return {
                "source": name,
                "record": record,
                "offline_config": offline_config,
                "summary": _source_summary(managed),
                "archives": extract_result,
            }
        except Exception:
            # 导入已经把用户选择的原始日志移动进工作区；失败时尽量搬回原处，
            # 避免坏压缩包导致用户在 Downloads 中的日志被静默吞掉。
            if managed.exists() and not source.exists() and source.parent.exists():
                try:
                    shutil.move(str(managed), str(source))
                except Exception:
                    pass
            shutil.rmtree((_managed_sources_root() / source_id), ignore_errors=True)
            raise


def _delete_source_files(raw: object) -> int:
    if not isinstance(raw, dict) or not raw.get("managed"):
        return 0
    path = _record_path(raw)
    source_id = str(raw.get("id", ""))
    if not re.fullmatch(r"src_[A-Fa-f0-9]{32}", source_id):
        raise ValueError("受管日志来源 ID 无效，已拒绝删除文件")
    root = (_managed_sources_root() / source_id).resolve()
    root.relative_to(_managed_sources_root().resolve())
    bytes_before = _scan_tree(root if root.exists() else path)["bytes"] if root.exists() or path.exists() else 0
    if root.exists():
        shutil.rmtree(root)
    elif path.exists():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    return bytes_before


def delete_source(settings: dict, body: dict) -> dict:
    """删除受管日志来源，并同步移除其用户数据目录文件。"""
    if body.get("confirmed") is not True:
        raise ValueError("删除日志来源前必须由用户确认")
    name, record = _source_record(settings, body.get("source"))
    sources_map = dict(settings.get("offline_log_sources", {}))
    released = _delete_source_files(record)
    sources_map.pop(name, None)
    offline_config = storage.update("offline_logs", {"offline_log_sources": sources_map})
    return {"source": name, "released_bytes": released, "offline_config": offline_config}

def normalize_filters(value: object) -> list[dict]:
    if not isinstance(value, list) or not value:
        raise ValueError("请至少填写一条筛选条件")
    if len(value) > MAX_FILTERS:
        raise ValueError(f"筛选条件不能超过 {MAX_FILTERS} 条")
    filters, terms_count = [], 0
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("筛选条件格式无效")
        mode = item.get("mode")
        if mode not in VALID_MODES:
            raise ValueError("筛选条件模式无效")
        terms = [str(term).strip() for term in item.get("terms", []) if str(term).strip()]
        terms_count += len(terms)
        if not terms:
            continue
        filters.append({"mode": mode, "terms": terms})
    if not filters or terms_count > MAX_TERMS:
        raise ValueError(f"筛选关键词数量必须为 1-{MAX_TERMS}")
    return filters

def normalize_priority_constraints(value: object, filters: list[dict]) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("关键词级别限制必须是数组")
    included_terms = {term for item in filters if item["mode"] in {"include_any", "include_all"} for term in item["terms"]}
    constraints, seen = [], set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("关键词级别限制格式无效")
        term = str(item.get("term", "")).strip()
        minimum_priority = str(item.get("minimum_priority", "")).strip().upper()
        if not term or term not in included_terms:
            raise ValueError(f"级别限制关键词不在包含条件中：{term or '空关键词'}")
        if minimum_priority not in LOG_PRIORITY_RANK:
            raise ValueError(f"不支持的日志级别：{minimum_priority or '空级别'}")
        if term in seen:
            raise ValueError(f"关键词存在重复级别限制：{term}")
        seen.add(term)
        constraints.append({"term": term, "minimum_priority": minimum_priority})
    return constraints

def escape_wildcard_term(term: str) -> str:
    """将关键词转义为 PCRE，* 转为 .*，其余正则元字符转义。"""
    parts = re.split(r"\*+", term)
    return ".*".join(re.escape(p) for p in parts)

def _priority_lookahead(minimum_priority: str) -> str:
    priorities = LOG_PRIORITY_CHARS[minimum_priority]
    return rf"(?=\d{{2}}-\d{{2}}\s+\d{{2}}:\d{{2}}:\d{{2}}\.\d+\s+\d+\s+\d+\s+[{priorities}]\s+)"

def _term_lookahead(term: str, constraints: dict[str, str]) -> str:
    priority = _priority_lookahead(constraints[term]) if term in constraints else ""
    return priority + f"(?=.*{escape_wildcard_term(term)})"

def pcre_pattern(filters: list[dict], priority_constraints: list[dict] | None = None) -> str:
    """将连续 AND 条件编码为安全的 PCRE2 lookahead，支持 * 通配符。"""
    constraints = {item["term"]: item["minimum_priority"] for item in priority_constraints or []}
    clauses = []
    for filter_data in filters:
        terms = filter_data["terms"]
        if filter_data["mode"] == "include_any":
            alternatives = "|".join(f"(?:{_term_lookahead(term, constraints)})" for term in terms)
            clauses.append(f"(?=(?:{alternatives}))")
        elif filter_data["mode"] == "include_all":
            clauses.extend(_term_lookahead(term, constraints) for term in terms)
        else:
            escaped = [escape_wildcard_term(term) for term in terms]
            clauses.append(f"(?!.*(?:{'|'.join(escaped)}))")
    return "(?i)^" + "".join(clauses) + ".*$"

def _term_matches(term: str, target: str) -> bool:
    pattern = escape_wildcard_term(term)
    return re.search(pattern, target, re.IGNORECASE) is not None

def _line_priority(line: str) -> Optional[str]:
    match = THREADTIME_PRIORITY.match(line)
    if not match:
        return None
    return "F" if match.group(1) == "A" else match.group(1)

def line_matches(line: str, filters: list[dict], priority_constraints: list[dict] | None = None) -> bool:
    constraints = {item["term"]: item["minimum_priority"] for item in priority_constraints or []}
    priority = _line_priority(line) if constraints else None
    def term_matches(term: str) -> bool:
        if not _term_matches(term, line):
            return False
        minimum = constraints.get(term)
        return not minimum or priority in LOG_PRIORITY_RANK and LOG_PRIORITY_RANK[priority] >= LOG_PRIORITY_RANK[minimum]
    for filter_data in filters:
        terms = filter_data["terms"]
        if filter_data["mode"] == "include_any" and not any(term_matches(term) for term in terms):
            return False
        if filter_data["mode"] == "include_all" and not all(term_matches(term) for term in terms):
            return False
        if filter_data["mode"] == "exclude_any" and any(_term_matches(term, line) for term in terms):
            return False
    return True


def _natural_path_key(value: object) -> tuple:
    """按路径中的数字段自然排序，避免 log.10 排在 log.9 前面。"""
    parts = re.split(r"(\d+)", str(value or "").replace("\\", "/").casefold())
    return tuple((1, int(part)) if part.isdigit() else (0, part) for part in parts)

def query(settings: dict, body: dict) -> dict:
    """用 rg --json 查询受配置白名单约束的文件或目录，返回匹配行及来源行号。"""
    source_name, source = source_path(settings, body.get("source"))
    filters = normalize_filters(body.get("filters"))
    priority_constraints = normalize_priority_constraints(body.get("priority_constraints"), filters)
    executable = rg_executable()
    if not executable:
        raise ValueError("未找到 rg（ripgrep），无法使用高速离线扫描")
    command = [executable, "--json", "--pcre2", "--color", "never", "--hidden", "--no-ignore", "--glob", "!.git", "--glob", "!*.zip", "--glob", "!*.gz", "--glob", "!*.tgz", "--glob", "!*.tar", "--", pcre_pattern(filters, priority_constraints), str(source)]
    started = time.monotonic()
    try:
        process = proc.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=QUERY_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired:
        raise ValueError(f"离线日志扫描超时（>{QUERY_TIMEOUT_SECONDS} 秒）")
    if process.returncode not in {0, 1}:
        raise ValueError(process.stderr.strip() or "rg 扫描失败")
    results = []
    for raw_line in process.stdout.splitlines():
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "match":
            continue
        data = event["data"]
        path_data = data.get("path", {})
        line_data = data.get("lines", {})
        file_path = path_data.get("text") or path_data.get("bytes", "")
        text = (line_data.get("text") or "").rstrip("\r\n")
        if not line_matches(text, filters, priority_constraints):
            continue
        if source.is_file():
            relative = source.name
        else:
            try:
                relative = str(Path(file_path).resolve().relative_to(source))
            except ValueError:
                relative = str(file_path)
        results.append({"file": relative, "line": data.get("line_number", 0), "text": text})
    # rg 扫描目录时可能并行处理文件，输出顺序不是稳定的文件顺序。
    # 不猜测正文时间格式，只恢复“自然文件名 + 文件内行号”的原始证据顺序。
    results.sort(key=lambda item: (_natural_path_key(item["file"]), int(item["line"] or 0)))
    return {"source": source_name, "path": str(source), "results": results, "elapsed_seconds": round(time.monotonic() - started, 3)}
