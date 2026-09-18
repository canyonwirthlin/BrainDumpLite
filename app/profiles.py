"""Multiple vaults (Phase 6). profiles.json in the default data dir lists named
vault folders; the active one is the vault-location pointer from Phase 3."""
from __future__ import annotations

import json
from pathlib import Path

from . import db, item_types

DEFAULT = "Default"


def _file() -> Path:
    return db.data_dir() / "profiles.json"


def _load() -> list[dict]:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
        return [p for p in data if isinstance(p, dict) and p.get("name") and p.get("dir")]
    except (OSError, ValueError):
        return []


def _save(items: list[dict]) -> None:
    _file().write_text(json.dumps(items, indent=2), encoding="utf-8")


def active() -> str:
    cur = db.vault_dir().resolve()
    for p in _load():
        if Path(p["dir"]).resolve() == cur:
            return p["name"]
    return DEFAULT


def list_profiles() -> list[dict]:
    act = active()
    out = [{"name": DEFAULT, "dir": str(db.data_dir()), "active": act == DEFAULT, "default": True}]
    for p in _load():
        out.append({"name": p["name"], "dir": p["dir"], "active": act == p["name"], "default": False,
                    "exists": (Path(p["dir"]) / "braindump.db").exists()})
    return out


def _check_name(name: str) -> str:
    name = (name or "").strip()
    if not 1 <= len(name) <= 40 or name.lower() == DEFAULT.lower():
        raise ValueError("pick a name (1-40 characters, not 'Default')")
    if any(p["name"].lower() == name.lower() for p in _load()):
        raise ValueError("a vault with that name already exists")
    return name


def add(name: str, folder: str) -> dict:
    """Register an existing vault folder (it must contain braindump.db)."""
    name = _check_name(name)
    d = Path(folder).expanduser()
    if not (d / "braindump.db").exists():
        raise ValueError("that folder has no braindump.db — use Create for a new vault")
    _save(_load() + [{"name": name, "dir": str(d)}])
    return {"name": name, "dir": str(d)}


def create(name: str, folder: str) -> dict:
    """Register an empty folder as a new vault (the DB is created on first switch)."""
    name = _check_name(name)
    d = Path(folder).expanduser()
    d.mkdir(parents=True, exist_ok=True)
    if (d / "braindump.db").exists():
        raise ValueError("that folder already has a vault — use Add instead")
    _save(_load() + [{"name": name, "dir": str(d)}])
    return {"name": name, "dir": str(d)}


def switch(name: str) -> dict:
    target = None if name == DEFAULT else next((Path(p["dir"]) for p in _load() if p["name"] == name), None)
    if name != DEFAULT and target is None:
        raise ValueError("unknown vault")
    with db.lock():
        db.close()
        db.set_vault_pointer(target)
    db.init_db()
    item_types.seed()
    return {"active": active(), "dir": str(db.vault_dir())}


def remove(name: str) -> None:
    if name == DEFAULT:
        raise ValueError("the default vault can't be removed")
    if active() == name:
        raise ValueError("switch to another vault first")
    items = _load()
    if name not in [p["name"] for p in items]:
        raise ValueError("unknown vault")
    _save([p for p in items if p["name"] != name])   # files are left untouched
