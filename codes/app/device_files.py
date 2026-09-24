"""Device Explorer：受控浏览、新建、有限预览、Pull、Push 和删除设备文件。"""
from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path, PurePosixPath

from . import android
from . import storage

DOWNLOAD_ROOT = storage.data_dir("device_files", "downloads")
SAFE_FILE_NAME = re.compile(r"[^/\\\x00\r\n]{1,255}")
SAFE_DOWNLOAD_ID = re.compile(r"[A-Za-z0-9._/-]+")
MAX_ENTRIES = 300
MAX_BATCH_ENTRIES = 300
MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024
MAX_TEXT_FILE_SIZE = 1024 * 1024
PREVIEW_BYTES = 256 * 1024
STAT_SEPARATOR = "\x1f"


def device_path(value: object, *, allow_root: bool = True) -> str:
    raw = str(value or "").strip()
    if not raw.startswith("/") or "\x00" in raw or "\r" in raw or "\n" in raw:
        raise ValueError("设备路径必须是安全的绝对路径")
    # PurePosixPath 会自动折叠 .，必须先验证原始分段，不能让 /a/./b 绕过限制。
    if any(part in {".", ".."} for part in raw.split("/")):
        raise ValueError("设备路径不能包含 . 或 ..")
    path = PurePosixPath(raw)
    normalized = str(path)
    if normalized == "." or (normalized == "/" and not allow_root):
        raise ValueError("设备路径无效")
    return normalized


def file_name(value: object) -> str:
    name = str(value or "").strip()
    if name in {".", ".."} or not SAFE_FILE_NAME.fullmatch(name):
        raise ValueError("文件名包含不安全字符")
    return name


def upload_relative_path(value: object, fallback_name: str) -> PurePosixPath:
    """校验浏览器目录选择提供的相对路径，禁止逃逸当前设备目录。"""
    raw = str(value or "").strip()
    if not raw:
        return PurePosixPath(file_name(fallback_name))
    if raw.startswith("/") or "\\" in raw or "\x00" in raw or "\r" in raw or "\n" in raw:
        raise ValueError("上传相对路径包含不安全字符")
    parts = raw.split("/")
    if not parts or any(not part or part in {".", ".."} for part in parts):
        raise ValueError("上传相对路径不能包含空目录、. 或 ..")
    return PurePosixPath(*(file_name(part) for part in parts))


def _stat_rows(settings: dict, directory: str) -> list[tuple[str, dict]]:
    # 每项单独 stat 会造成大量 ADB 往返。find + -exec 批量输出元数据，仅一次设备调用。
    pattern = f"%n{STAT_SEPARATOR}%F{STAT_SEPARATOR}%s{STAT_SEPARATOR}%Y{STAT_SEPARATOR}%a"
    # 只处理可解析的普通文件/目录，根目录偶尔有失效软链接，不能让其阻塞整个列表。
    code, output, error = android.device_adb(settings, "shell", "find", "-L", directory, "-maxdepth", "1", "\(", "-type", "d", "-o", "-type", "f", "\)", "-exec", "toybox", "stat", "-Lc", pattern, "{}", "+", timeout=30)
    if code:
        raise ValueError(error or output or f"无法读取设备目录：{directory}")
    result = []
    for line in output.splitlines():
        columns = line.rsplit(STAT_SEPARATOR, 4)
        if len(columns) != 5 or not columns[2].isdigit() or not columns[3].isdigit():
            continue
        path, file_type, size, modified, permissions = columns
        result.append((path, {
            "type": "directory" if file_type == "directory" else "file",
            "size": int(size), "modified": int(modified), "permissions": permissions,
        }))
    return result


def _children(settings: dict, directory: str) -> list[dict]:
    result = []
    for raw, stat in _stat_rows(settings, directory):
        path = device_path(raw)
        if path == directory:
            continue
        if PurePosixPath(path).parent != PurePosixPath(directory):
            continue
        try:
            name = file_name(PurePosixPath(path).name)
        except ValueError:
            continue
        result.append({"name": name, "path": path, **stat})
        if len(result) >= MAX_ENTRIES:
            break
    return sorted(result, key=lambda item: (item["type"] != "directory", item["name"].lower(), item["name"]))


def list_directory(settings: dict, value: object) -> dict:
    directory = device_path(value)
    rows = _stat_rows(settings, directory)
    current = next((stat for path, stat in rows if device_path(path) == directory), None)
    if not current:
        raise ValueError(f"设备路径不存在或无读取权限：{directory}")
    if current["type"] != "directory":
        raise ValueError("当前设备路径不是目录")
    entries = []
    for path, stat in rows:
        path = device_path(path)
        if path == directory or PurePosixPath(path).parent != PurePosixPath(directory):
            continue
        try:
            entries.append({"name": file_name(PurePosixPath(path).name), "path": path, **stat})
        except ValueError:
            continue
        if len(entries) >= MAX_ENTRIES:
            break
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower(), item["name"]))
    parent = str(PurePosixPath(directory).parent) if directory != "/" else ""
    return {"path": directory, "parent": parent, "entries": entries, "limited": len(entries) >= MAX_ENTRIES, "limit": MAX_ENTRIES}


def _fresh_entry(settings: dict, value: object) -> tuple[str, dict]:
    """重扫父目录，确认条目仍存在，返回文件或目录条目。"""
    path = device_path(value, allow_root=False)
    parent = str(PurePosixPath(path).parent)
    name = file_name(PurePosixPath(path).name)
    item = next((entry for entry in _children(settings, parent) if entry["name"] == name), None)
    if not item:
        raise ValueError("设备条目不存在或已变化，请刷新目录后重试")
    return path, item


def _fresh_entries(settings: dict, values: object) -> list[tuple[str, dict]]:
    """一次重扫同一父目录并校验批量条目，避免逐项产生 ADB 往返。"""
    if not isinstance(values, list) or not values:
        raise ValueError("请至少选择一个设备条目")
    if len(values) > MAX_BATCH_ENTRIES:
        raise ValueError(f"单次最多操作 {MAX_BATCH_ENTRIES} 个设备条目")
    paths = [device_path(value, allow_root=False) for value in values]
    if len(paths) != len(set(paths)):
        raise ValueError("批量操作包含重复设备路径")
    parents = {str(PurePosixPath(path).parent) for path in paths}
    if len(parents) != 1:
        raise ValueError("批量操作只能选择同一设备目录下的条目")
    entries = {item["path"]: item for item in _children(settings, parents.pop())}
    missing = [path for path in paths if path not in entries]
    if missing:
        raise ValueError(f"设备条目不存在或已变化，请刷新目录后重试：{missing[0]}")
    return [(path, entries[path]) for path in paths]


def _fresh_file(settings: dict, value: object) -> tuple[str, dict]:
    path, item = _fresh_entry(settings, value)
    if item["type"] != "file":
        raise ValueError("设备文件不存在、已变化或不是普通文件，请刷新目录后重试")
    return path, item


def _safe_slug(value: str, fallback: str = "folder") -> str:
    """把设备条目名转成仅含下载白名单字符的本地名，避免下载 ID 校验失败。"""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_.")
    return slug or fallback


def _download_folder(serial: str) -> Path:
    serial_part = re.sub(r"[^A-Za-z0-9._-]+", "_", serial).strip("_.") or "device"
    folder = DOWNLOAD_ROOT / serial_part / datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    folder.mkdir(parents=True, exist_ok=False)
    return folder


def _download_response(output: Path, name: str) -> dict:
    identifier = output.relative_to(DOWNLOAD_ROOT).as_posix()
    return {"ok": True, "name": name, "size": output.stat().st_size, "id": identifier, "url": "/api/device-files/download?id=" + identifier}


def _pull_file(settings: dict, path: str, item: dict) -> dict:
    folder = _download_folder(str(settings.get("_selected_adb_serial", "")))
    output = folder / item["name"]
    code, stdout, error = android.device_adb(settings, "pull", path, str(output), timeout=600)
    if code or not output.is_file():
        shutil.rmtree(folder, ignore_errors=True)
        raise ValueError(error or stdout or "设备文件 Pull 失败")
    return _download_response(output, output.name)


def _pull_directory(settings: dict, path: str, item: dict) -> dict:
    # 目录先 pull 到临时子目录，再打包成 zip；浏览器只能下载单个文件。
    folder = _download_folder(str(settings.get("_selected_adb_serial", "")))
    staging = folder / "pull"
    staging.mkdir(parents=True, exist_ok=True)
    code, stdout, error = android.device_adb(settings, "pull", path, str(staging), timeout=1800)
    pulled = staging / item["name"]
    if code or not pulled.is_dir():
        shutil.rmtree(folder, ignore_errors=True)
        raise ValueError(error or stdout or "设备文件夹 Pull 失败")
    slug = _safe_slug(item["name"])
    archive_base = folder / slug
    try:
        archive = Path(shutil.make_archive(str(archive_base), "zip", root_dir=str(staging), base_dir=item["name"]))
    except OSError as exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise ValueError("设备文件夹打包失败：" + str(exception))
    # 仅保留 zip，删除已展开的原始目录，避免下载目录冗余占用。
    shutil.rmtree(staging, ignore_errors=True)
    return _download_response(archive, archive.name)


def pull(settings: dict, value: object) -> dict:
    path, item = _fresh_entry(settings, value)
    if item["type"] == "directory":
        return _pull_directory(settings, path, item)
    return _pull_file(settings, path, item)


def pull_batch(settings: dict, values: object) -> dict:
    """Pull 同一目录中的多个条目，并生成一个 zip 供浏览器下载。"""
    entries = _fresh_entries(settings, values)
    folder = _download_folder(str(settings.get("_selected_adb_serial", "")))
    staging = folder / "pull"
    staging.mkdir(parents=True, exist_ok=True)
    try:
        for path, item in entries:
            code, stdout, error = android.device_adb(settings, "pull", path, str(staging), timeout=1800 if item["type"] == "directory" else 600)
            if code or not (staging / item["name"]).exists():
                raise ValueError(error or stdout or f"设备条目 Pull 失败：{path}")
        archive_name = "device-files-" + datetime.now().strftime("%Y%m%d-%H%M%S")
        archive = Path(shutil.make_archive(str(folder / archive_name), "zip", root_dir=str(staging)))
    except (OSError, ValueError) as error:
        shutil.rmtree(folder, ignore_errors=True)
        if isinstance(error, ValueError):
            raise
        raise ValueError("批量 Pull 打包失败：" + str(error))
    shutil.rmtree(staging, ignore_errors=True)
    result = _download_response(archive, archive.name)
    return {**result, "count": len(entries)}


def resolve_download(value: object) -> Path:
    identifier = str(value or "").strip()
    if not SAFE_DOWNLOAD_ID.fullmatch(identifier):
        raise ValueError("无效的下载文件 ID")
    path = (DOWNLOAD_ROOT / Path(identifier)).resolve()
    root = DOWNLOAD_ROOT.resolve()
    if root not in path.parents or not path.is_file() or path.is_symlink():
        raise ValueError("下载文件不存在")
    return path


def upload(settings: dict, directory_value: object, filename_value: object, content: bytes, overwrite: bool, relative_path_value: object = "") -> dict:
    directory = device_path(directory_value)
    filename = file_name(filename_value)
    if len(content) > MAX_UPLOAD_SIZE:
        raise ValueError("单次上传文件不能超过 2 GiB")
    relative_path = upload_relative_path(relative_path_value, filename)
    remote = str(PurePosixPath(directory) / relative_path)
    if not relative_path_value:
        listing = list_directory(settings, directory)
        exists = any(item["name"] == filename for item in listing["entries"])
        if exists and not overwrite:
            return {"requires_confirmation": True, "remote_path": remote}
    else:
        # 文件夹上传会逐文件请求；父目录只能由校验后的相对路径派生。
        code, stdout, error = android.device_adb(settings, "shell", "mkdir", "-p", str(PurePosixPath(remote).parent), timeout=30)
        if code:
            raise ValueError(error or stdout or "创建设备目录失败")
    temporary = DOWNLOAD_ROOT / "uploads" / (datetime.now().strftime("%Y%m%d_%H%M%S_%f") + "_" + filename)
    temporary.parent.mkdir(parents=True, exist_ok=True)
    try:
        temporary.write_bytes(content)
        code, stdout, error = android.device_adb(settings, "push", str(temporary), remote, timeout=600)
        if code:
            raise ValueError(error or stdout or "设备文件 Push 失败")
    finally:
        temporary.unlink(missing_ok=True)
    return {"ok": True, "requires_confirmation": False, "name": filename, "remote_path": remote}


def _entry_with_name(settings: dict, directory: str, name: str) -> dict | None:
    target = str(PurePosixPath(directory) / name)
    for raw, stat in _stat_rows(settings, directory):
        path = device_path(raw)
        if path == target and PurePosixPath(path).parent == PurePosixPath(directory):
            return {"name": name, "path": path, **stat}
    return None


def create_directory(settings: dict, directory_value: object, name_value: object) -> dict:
    directory = device_path(directory_value)
    name = file_name(name_value)
    if _entry_with_name(settings, directory, name):
        raise ValueError("同名设备文件或文件夹已存在")
    remote = str(PurePosixPath(directory) / name)
    code, output, error = android.device_adb(settings, "shell", "mkdir", remote, timeout=30)
    if code:
        raise ValueError(error or output or "创建设备文件夹失败")
    return {"ok": True, "name": name, "path": remote, "type": "directory"}


def create_text_file(settings: dict, directory_value: object, name_value: object, content_value: object, overwrite: object) -> dict:
    directory = device_path(directory_value)
    name = file_name(name_value)
    if not isinstance(content_value, str):
        raise ValueError("新建文件内容必须是 UTF-8 文本")
    content = content_value.encode("utf-8")
    if len(content) > MAX_TEXT_FILE_SIZE:
        raise ValueError("新建文本文件不能超过 1 MiB")
    existing = _entry_with_name(settings, directory, name)
    remote = str(PurePosixPath(directory) / name)
    if existing and existing["type"] == "directory":
        raise ValueError("同名设备文件夹已存在，不能创建文件")
    if existing and not overwrite:
        return {"requires_confirmation": True, "remote_path": remote}
    return upload(settings, directory, name, content, bool(overwrite))


def _binary_type(content: bytes) -> str:
    signatures = (
        (b"\x89PNG\r\n\x1a\n", "PNG 图片"), (b"\xff\xd8\xff", "JPEG 图片"),
        (b"GIF87a", "GIF 图片"), (b"GIF89a", "GIF 图片"), (b"RIFF", "RIFF 媒体文件"),
        (b"PK\x03\x04", "ZIP/APK/JAR 归档"), (b"\x1f\x8b", "GZIP 压缩文件"),
        (b"%PDF-", "PDF 文档"), (b"\x7fELF", "ELF 可执行文件"),
    )
    return next((label for signature, label in signatures if content.startswith(signature)), "二进制文件")


def _decode_preview_text(content: bytes, truncated: bool) -> str | None:
    """严格识别 UTF-8 文本；截断时允许丢弃末尾不完整的一个字符。"""
    attempts = range(0, 4) if truncated else range(1)
    for trim in attempts:
        candidate = content[:-trim] if trim else content
        try:
            text = candidate.decode("utf-8")
        except UnicodeDecodeError:
            continue
        control_count = sum(character < " " and character not in "\n\r\t" for character in text)
        return None if b"\x00" in candidate or control_count > max(2, len(text) // 100) else text
    return None


def preview(settings: dict, value: object) -> dict:
    path, item = _fresh_file(settings, value)
    read_size = PREVIEW_BYTES + 1
    code, content, error = android.device_adb_bytes(settings, "exec-out", "head", "-c", str(read_size), path, timeout=30)
    if code:
        raise ValueError(error or "读取设备文件预览失败")
    truncated = len(content) > PREVIEW_BYTES or item.get("size", 0) > PREVIEW_BYTES
    content = content[:PREVIEW_BYTES]
    text = _decode_preview_text(content, truncated)
    if text is None:
        return {"previewable": False, "kind": "binary", "detected_type": _binary_type(content), "name": item["name"], "path": path, "size": item.get("size", 0)}
    return {"previewable": True, "kind": "text", "encoding": "utf-8", "content": text, "name": item["name"], "path": path, "size": item.get("size", 0), "truncated": truncated, "preview_bytes": len(content)}


def delete(settings: dict, value: object, confirmed: object) -> dict:
    if not confirmed:
        return {"requires_confirmation": True}
    path, item = _fresh_entry(settings, value)
    # 目录递归删除属于破坏性操作，rm -rf 仍通过参数数组调用，绝不经宿主机 Shell。
    if item["type"] == "directory":
        code, output, error = android.device_adb(settings, "shell", "rm", "-rf", path, timeout=120)
    else:
        code, output, error = android.device_adb(settings, "shell", "rm", "-f", path, timeout=30)
    if code:
        raise ValueError(error or output or "删除设备条目失败")
    return {"ok": True, "name": item["name"], "path": path, "type": item["type"]}


def delete_batch(settings: dict, values: object, confirmed: object) -> dict:
    """重新校验同目录选择后逐项删除，返回成功项和明确的失败原因。"""
    if not confirmed:
        return {"requires_confirmation": True}
    entries = _fresh_entries(settings, values)
    deleted, failures = [], []
    for path, item in entries:
        args = ("shell", "rm", "-rf" if item["type"] == "directory" else "-f", path)
        code, output, error = android.device_adb(settings, *args, timeout=120 if item["type"] == "directory" else 30)
        if code:
            failures.append({"path": path, "message": error or output or "删除失败"})
        else:
            deleted.append({"path": path, "name": item["name"], "type": item["type"]})
    return {"ok": not failures, "deleted": deleted, "failures": failures, "deleted_count": len(deleted), "failed_count": len(failures)}
