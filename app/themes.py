"""Theme JSON schema, the six built-in themes, and custom-theme storage.

A theme is:
    {"id": "midnight", "name": "Midnight", "scheme": "dark"|"light",
     "colors": {bg, rail, panel, panel2, line, text, dim, accent, accent2,
                accentSoft, green, red, amber}, "radius": 12}
Custom themes live in the settings table (key "custom_themes", JSON list);
the active id is setting "theme". Built-ins are code, so the API is the
single source of truth for the frontend.
"""
from __future__ import annotations

import json
import re

from . import db

COLOR_KEYS = ["bg", "rail", "panel", "panel2", "line", "text", "dim", "accent",
              "accent2", "accentSoft", "green", "red", "amber"]
_ID = re.compile(r"^[a-z0-9-]{2,32}$")
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGBA = re.compile(r"^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$")
DEFAULT_ID = "midnight"


def _t(id, name, scheme, bg, rail, panel, panel2, line, text, dim, accent, accent2, soft,
       green="#4ade80", red="#f87171", amber="#fbbf24", radius=12):
    return {"id": id, "name": name, "scheme": scheme, "radius": radius,
            "colors": {"bg": bg, "rail": rail, "panel": panel, "panel2": panel2, "line": line,
                       "text": text, "dim": dim, "accent": accent, "accent2": accent2,
                       "accentSoft": soft, "green": green, "red": red, "amber": amber}}


BUILTIN = [
    _t("midnight", "Midnight", "dark", "#0d1017", "#0a0d13", "#151b28", "#1b2334", "#263049",
       "#e6e9f2", "#8b93a8", "#8b7cf6", "#5ea2f7", "rgba(139,124,246,.16)"),
    _t("ocean", "Ocean", "dark", "#0a121f", "#070d17", "#101a2b", "#16233a", "#23344f",
       "#e2ecf7", "#85929f", "#38bdf8", "#34d399", "rgba(56,189,248,.15)"),
    _t("forest", "Forest", "dark", "#0c1210", "#080d0b", "#121b17", "#18251f", "#24382e",
       "#e4efe8", "#86988d", "#4ade80", "#a3e635", "rgba(74,222,128,.13)"),
    _t("ember", "Ember", "dark", "#16100e", "#100b09", "#201613", "#2a1c18", "#402c25",
       "#f2e8e3", "#a3908a", "#fb923c", "#f43f5e", "rgba(251,146,60,.15)"),
    _t("paper", "Paper", "light", "#f4f5f9", "#e9ebf3", "#ffffff", "#eceef5", "#d9dded",
       "#1c2130", "#626b81", "#6d5ce6", "#2f7de1", "rgba(109,92,230,.12)",
       green="#15803d", red="#dc2626", amber="#b45309"),
    _t("sakura", "Sakura", "light", "#faf3f5", "#f1e4e8", "#ffffff", "#f5e6eb", "#e9d2db",
       "#2e2027", "#826a75", "#d6488f", "#9b5de5", "rgba(214,72,143,.12)",
       green="#15803d", red="#dc2626", amber="#b45309"),
]
_BUILTIN_IDS = {t["id"] for t in BUILTIN}


def validate(raw) -> dict:
    """Return a normalised copy or raise ValueError with a human-readable reason."""
    if not isinstance(raw, dict):
        raise ValueError("theme must be a JSON object")
    tid = str(raw.get("id", ""))
    if not _ID.match(tid):
        raise ValueError("id must be 2-32 chars of a-z, 0-9 or '-'")
    name = str(raw.get("name", "")).strip()
    if not 1 <= len(name) <= 40:
        raise ValueError("name must be 1-40 characters")
    scheme = raw.get("scheme")
    if scheme not in ("dark", "light"):
        raise ValueError("scheme must be 'dark' or 'light'")
    colors = raw.get("colors")
    if not isinstance(colors, dict):
        raise ValueError("colors must be an object")
    out_colors = {}
    for k in COLOR_KEYS:
        v = colors.get(k)
        if not isinstance(v, str) or not (_HEX.match(v.strip()) or _RGBA.match(v.strip())):
            raise ValueError(f"colors.{k} must be a #hex or rgba() color")
        out_colors[k] = v.strip()
    radius = raw.get("radius", 12)
    if not isinstance(radius, int) or not 6 <= radius <= 20:
        raise ValueError("radius must be an integer from 6 to 20")
    return {"id": tid, "name": name, "scheme": scheme, "colors": out_colors, "radius": radius}


def custom() -> list[dict]:
    try:
        data = json.loads(db.get_setting("custom_themes", "[]") or "[]")
        return [t for t in data if isinstance(t, dict)]
    except (ValueError, TypeError):
        return []


def _save_custom(items: list[dict]) -> None:
    db.set_setting("custom_themes", json.dumps(items))


def all_themes() -> list[dict]:
    return BUILTIN + custom()


def get(theme_id: str) -> dict | None:
    return next((t for t in all_themes() if t["id"] == theme_id), None)


def active_id() -> str:
    tid = db.get_setting("theme", DEFAULT_ID) or DEFAULT_ID
    return tid if get(tid) else DEFAULT_ID


def set_active(theme_id: str) -> None:
    if not get(theme_id):
        raise ValueError(f"unknown theme '{theme_id}'")
    db.set_setting("theme", theme_id)


def import_theme(raw) -> dict:
    t = validate(raw)
    if t["id"] in _BUILTIN_IDS:
        raise ValueError(f"id '{t['id']}' is reserved for a built-in theme")
    items = [c for c in custom() if c.get("id") != t["id"]] + [t]
    _save_custom(items)
    return t


def delete(theme_id: str) -> None:
    if theme_id in _BUILTIN_IDS:
        raise ValueError("built-in themes can't be deleted")
    items = custom()
    if theme_id not in [c.get("id") for c in items]:
        raise ValueError(f"unknown theme '{theme_id}'")
    _save_custom([c for c in items if c.get("id") != theme_id])
    if db.get_setting("theme", DEFAULT_ID) == theme_id:
        db.set_setting("theme", DEFAULT_ID)
