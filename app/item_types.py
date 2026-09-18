"""Extractable item types as data (Phase 3).

The classify prompt and its strict JSON schema are generated from the enabled
rows, so a user-defined type ("question", "gratitude", …) becomes something the
pipeline actively looks for. The six original kinds are built-in: renamable and
recolorable, never deletable, so old items always keep a valid type.
"""
from __future__ import annotations

import re

from . import db

COLORS = ["accent", "green", "amber", "red", "blue", "dim"]  # token names; #hex also allowed
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

BUILTIN_SEED = [
    ("task", "Task", "✅", "accent", "clear action verb (do, call, write, fix, send, build, schedule, buy, complete)"),
    ("goal", "Goal", "🎯", "green", "desired outcome, aspiration, or self-improvement aim — even without action verbs"),
    ("idea", "Idea", "💡", "amber", "creative or speculative thought, hypothetical plan, new concept to explore"),
    ("concern", "Concern", "⚠️", "red", "worry, fear, anxiety, stress, or something weighing on the person"),
    ("event", "Event", "📅", "blue", "has explicit or implied date/time scheduling intent"),
    ("note", "Note", "📝", "dim", "purely factual reference info or context that is NOT aspirational"),
]


def _row(r) -> dict:
    return {"id": r["id"], "label": r["label"], "icon": r["icon"], "color": r["color"],
            "hint": r["hint"], "builtin": bool(r["builtin"]), "enabled": bool(r["enabled"]), "sort": r["sort"]}


def seed() -> None:
    """Insert the built-ins if missing (idempotent; never overwrites user edits)."""
    for i, (tid, label, icon, color, hint) in enumerate(BUILTIN_SEED):
        db.execute(
            "INSERT OR IGNORE INTO item_types (id, label, icon, color, hint, builtin, enabled, sort) "
            "VALUES (?,?,?,?,?,1,1,?)", (tid, label, icon, color, hint, i))


def all() -> list[dict]:
    return [_row(r) for r in db.query("SELECT * FROM item_types ORDER BY sort, label")]


def enabled() -> list[dict]:
    return [t for t in all() if t["enabled"]]


def get(type_id: str) -> dict | None:
    r = db.query_one("SELECT * FROM item_types WHERE id=?", (type_id,))
    return _row(r) if r else None


def enum() -> list[str]:
    return [t["id"] for t in enabled()] or ["note"]


def prompt_rules() -> str:
    """The 'Item type rules' block for the classify prompt."""
    return "\n".join(f"- {t['id']}: {t['hint'] or t['label']}" for t in enabled())


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-")
    return s[:24]


def _check_color(color: str) -> str:
    color = (color or "accent").strip()
    if color in COLORS or _HEX.match(color):
        return color
    raise ValueError("color must be one of accent/green/amber/red/blue/dim or #rrggbb")


def create(label: str, icon: str = "", color: str = "accent", hint: str = "") -> dict:
    label = (label or "").strip()
    if not 1 <= len(label) <= 30:
        raise ValueError("label must be 1-30 characters")
    tid = _slug(label)
    if len(tid) < 2:
        raise ValueError("label needs at least two letters or digits")
    if get(tid):
        raise ValueError(f"a type with id '{tid}' already exists")
    color = _check_color(color)
    sort = 1 + max((t["sort"] for t in all()), default=0)
    db.execute("INSERT INTO item_types (id, label, icon, color, hint, builtin, enabled, sort) VALUES (?,?,?,?,?,0,1,?)",
               (tid, label, (icon or "")[:4], color, (hint or "").strip()[:200], sort))
    return get(tid)


def update(type_id: str, **fields) -> dict:
    t = get(type_id)
    if not t:
        raise ValueError(f"unknown type '{type_id}'")
    sets, vals = [], []
    for k, v in fields.items():
        if v is None:
            continue
        if k == "label":
            v = str(v).strip()
            if not 1 <= len(v) <= 30:
                raise ValueError("label must be 1-30 characters")
        elif k == "icon":
            v = str(v)[:4]
        elif k == "color":
            v = _check_color(str(v))
        elif k == "hint":
            v = str(v).strip()[:200]
        elif k == "enabled":
            if t["builtin"] and not v:
                raise ValueError("built-in types can't be disabled")
            v = 1 if v else 0
        elif k == "sort":
            v = int(v)
        else:
            continue
        sets.append(f"{k}=?"); vals.append(v)
    if sets:
        db.execute(f"UPDATE item_types SET {', '.join(sets)} WHERE id=?", (*vals, type_id))
    return get(type_id)


def delete(type_id: str) -> None:
    t = get(type_id)
    if not t:
        raise ValueError(f"unknown type '{type_id}'")
    if t["builtin"]:
        raise ValueError("built-in types can't be deleted")
    db.execute("UPDATE items SET kind='note' WHERE kind=?", (type_id,))
    db.execute("DELETE FROM item_types WHERE id=?", (type_id,))
