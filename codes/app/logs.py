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
import zipfile
from pathlib import Path
from typing import Optional

from . import proc

MAX_FILTERS = 30
MAX_TERMS = 100
QUERY_TIMEOUT_SECONDS = 300
VALID_MODES = {"include_any", "include_all", "exclude_any"}
ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar", ".zip", ".gz")
MAX_ARCHIVE_FILES = 100_000
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 500
_ARCHIVE_LOCK = threading.Lock()

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


def sources(settings: dict) -> list[dict]:
    """列出已保存的日志文件或目录来源，不接受浏览器路径参数。"""
    result = []
    for name, raw_path in settings.get("offline_log_sources", {}).items():
        path = Path(str(raw_path)).expanduser()
        available, kind, error = _source_status(path)
        result.append({"name": str(name), "path": str(path), "available": available, "kind": kind, "error": error})
    return sorted(result, key=lambda item: item["name"])

def source_path(settings: dict, name: object) -> tuple[str, Path]:
    """按来源名称重建当前 settings 白名单中的文件或目录，拒绝未保存路径。"""
    clean_name = str(name or "").strip()
    raw_path = settings.get("offline_log_sources", {}).get(clean_name)
    if not clean_name or not raw_path:
        raise ValueError("请选择当前配置中已保存的日志来源")
    path = Path(str(raw_path)).expanduser().resolve()
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
    return {"source": source_name, "path": str(folder), "archives": [str(path.relative_to(folder)) for path in archives]}

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

def escape_wildcard_term(term: str) -> str:
    """将关键词转义为 PCRE，* 转为 .*，其余正则元字符转义。"""
    parts = re.split(r"\*+", term)
    return ".*".join(re.escape(p) for p in parts)

def pcre_pattern(filters: list[dict]) -> str:
    """将连续 AND 条件编码为安全的 PCRE2 lookahead，支持 * 通配符。"""
    clauses = []
    for filter_data in filters:
        escaped = [escape_wildcard_term(term) for term in filter_data["terms"]]
        if filter_data["mode"] == "include_any":
            clauses.append(f"(?=.*(?:{'|'.join(escaped)}))")
        elif filter_data["mode"] == "include_all":
            clauses.extend(f"(?=.*{term})" for term in escaped)
        else:
            clauses.append(f"(?!.*(?:{'|'.join(escaped)}))")
    return "(?i)^" + "".join(clauses) + ".*$"

def query(settings: dict, body: dict) -> dict:
    """用 rg --json 查询受配置白名单约束的文件或目录，返回匹配行及来源行号。"""
    source_name, source = source_path(settings, body.get("source"))
    filters = normalize_filters(body.get("filters"))
    executable = rg_executable()
    if not executable:
        raise ValueError("未找到 rg（ripgrep），无法使用高速离线扫描")
    command = [executable, "--json", "--pcre2", "--color", "never", "--hidden", "--no-ignore", "--glob", "!.git", "--glob", "!*.zip", "--glob", "!*.gz", "--glob", "!*.tgz", "--glob", "!*.tar", "--", pcre_pattern(filters), str(source)]
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
        if source.is_file():
            relative = source.name
        else:
            try:
                relative = str(Path(file_path).resolve().relative_to(source))
            except ValueError:
                relative = str(file_path)
        results.append({"file": relative, "line": data.get("line_number", 0), "text": text})
    return {"source": source_name, "path": str(source), "results": results, "elapsed_seconds": round(time.monotonic() - started, 3)}
