"""内置主题与用户导入主题的读取、校验和持久化。"""

from __future__ import annotations

import json
import re
import threading

from . import runtime, storage


SCHEMA_VERSION = 1
THEME_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
COLOR_PATTERN = re.compile(
    r"^(?:#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})"
    r"|rgba?\([^;{}]+\)|hsla?\([^;{}]+\))$"
)
MAX_TEXT_LENGTH = 160
DEPRECATED_THEME_TOKENS = {
    "logHighlightViolet",
    "logHighlightCyan",
    "logHighlightGreen",
    "logHighlightYellow",
    "logHighlightOrange",
    "logHighlightRed",
    "textOnHighlight",
}
_LOCK = threading.RLock()


def _built_in_catalog() -> dict:
    path = runtime.resource_path("web/themes.json")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取内置主题配置：{error}") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("内置 themes.json 结构无效")
    if not isinstance(value.get("tokenGuide"), dict) or not isinstance(value.get("themes"), dict):
        raise ValueError("内置 themes.json 缺少颜色令牌或主题")
    return value


def _user_store() -> dict:
    value = storage.read("themes", storage.default("themes"))
    themes = value.get("themes", {})
    if not isinstance(themes, dict):
        raise ValueError("runtime/themes.json 中的 themes 必须是对象")
    return {**value, "themes": themes}


def catalog() -> dict:
    built_in = _built_in_catalog()
    store = _user_store()
    user_themes = {
        theme_id: theme
        for theme_id, theme in store["themes"].items()
        if theme_id not in built_in["themes"]
    }
    merged = dict(built_in["themes"])
    merged.update(user_themes)
    selected_theme = str(store.get("selected_theme", "")).strip()
    if selected_theme not in merged:
        selected_theme = ""
    return {**built_in, "themes": merged, "userThemes": sorted(user_themes), "selectedTheme": selected_theme}


def _short_text(value, field: str, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"主题 {field} 不能为空")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"主题 {field} 不能超过 {MAX_TEXT_LENGTH} 个字符")
    return text


def _import_candidate(document: dict, built_in: dict) -> tuple[str, dict]:
    if not isinstance(document, dict) or document.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("主题文件 schemaVersion 必须为 1")
    imported = document.get("themes")
    if not isinstance(imported, dict) or len(imported) != 1:
        raise ValueError("一次只能导入 themes 中的一套主题")
    theme_id, raw = next(iter(imported.items()))
    if not THEME_ID_PATTERN.fullmatch(str(theme_id)):
        raise ValueError("主题 ID 只能包含字母、数字、下划线和连字符，且最长 64 位")
    if theme_id in built_in["themes"]:
        raise ValueError("不能覆盖内置主题，请修改主题 ID")
    if not isinstance(raw, dict) or not isinstance(raw.get("colors"), dict):
        raise ValueError("主题必须包含 colors 对象")
    known_tokens = set(built_in["tokenGuide"])
    accepted_tokens = known_tokens | DEPRECATED_THEME_TOKENS
    unknown_tokens = sorted(set(raw["colors"]) - accepted_tokens)
    if unknown_tokens:
        raise ValueError("主题包含未知颜色字段：" + "、".join(unknown_tokens))
    colors = {}
    for token, raw_color in raw["colors"].items():
        color = raw_color.get("value") if isinstance(raw_color, dict) else raw_color
        color = str(color or "").strip()
        if not COLOR_PATTERN.fullmatch(color):
            raise ValueError(f"颜色 {token} 格式无效")
        if token in known_tokens:
            colors[token] = color
    if not colors:
        raise ValueError("主题至少需要配置一个颜色")
    preview = raw.get("preview", [])
    if not isinstance(preview, list) or any(item not in accepted_tokens for item in preview):
        raise ValueError("preview 只能引用已知颜色字段")
    preview = [item for item in preview if item in known_tokens]
    mode = raw.get("mode", "dark")
    if mode not in {"dark", "light"}:
        raise ValueError("主题 mode 只能是 dark 或 light")
    return theme_id, {
        "name": _short_text(raw.get("name"), "name", required=True),
        "description": _short_text(raw.get("description"), "description"),
        "mode": mode,
        "preview": preview[:3],
        "colors": colors,
    }


def import_theme(body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("主题导入请求必须是对象")
    with _LOCK:
        built_in = _built_in_catalog()
        theme_id, theme = _import_candidate(body.get("document"), built_in)
        store = _user_store()
        exists = theme_id in store["themes"]
        if exists and not body.get("overwrite"):
            return {"requires_confirmation": True, "id": theme_id, "name": theme["name"]}
        store["themes"] = {**store["themes"], theme_id: theme}
        storage.write("themes", store)
    return {"ok": True, "id": theme_id, "name": theme["name"], "overwritten": exists}


def delete_theme(theme_id: str) -> dict:
    with _LOCK:
        built_in = _built_in_catalog()
        if theme_id in built_in["themes"]:
            raise ValueError("内置主题不能删除")
        store = _user_store()
        if theme_id not in store["themes"]:
            raise ValueError("用户主题不存在")
        del store["themes"][theme_id]
        if store.get("selected_theme") == theme_id:
            store["selected_theme"] = built_in["defaultTheme"]
        storage.write("themes", store)
    return {"ok": True, "id": theme_id}
