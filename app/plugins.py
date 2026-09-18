"""Plugin loader (Phase 9).

A plugin is a folder under <data>/plugins/<id>/ with a plugin.json and an entry
module exposing `register(api)`. Plugins run in this process with this process's
permissions — the UI says so before anything is enabled, and nothing loads until
the user enables it. A plugin that raises is disabled for the session with its
traceback kept for Settings; the app carries on.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
import traceback
import zipfile
from pathlib import Path

from . import db

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,40}$")
_loaded: dict[str, "Loaded"] = {}


class Loaded:
    def __init__(self, meta: dict, path: Path):
        self.meta, self.path = meta, path
        self.dump_hooks: list = []
        self.actions: dict = {}
        self.error: str | None = None


def plugins_dir() -> Path:
    d = db.data_dir() / "plugins"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _enabled() -> dict:
    return db.get_setting("plugins_enabled", {}) or {}


def log(msg: str) -> None:
    d = db.data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "plugins.log", "a", encoding="utf-8") as f:
        f.write(f"{db.now_iso()}  {msg}\n")


def read_meta(folder: Path) -> dict:
    meta = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
    pid = str(meta.get("id") or folder.name)
    if not ID_RE.match(pid):
        raise ValueError(f"'{pid}' is not a valid plugin id (lowercase letters, digits, - and _)")
    entry = str(meta.get("entry") or "main.py")
    if "/" in entry or "\\" in entry or not entry.endswith(".py"):
        raise ValueError("entry must be a .py file in the plugin folder")
    if not (folder / entry).exists():
        raise ValueError(f"entry file '{entry}' is missing")
    return {"id": pid, "name": str(meta.get("name") or pid), "version": str(meta.get("version") or "0.0.0"),
            "description": str(meta.get("description") or ""), "author": str(meta.get("author") or ""),
            "permissions": [str(p) for p in meta.get("permissions") or []], "entry": entry}


# ── the API handed to a plugin ───────────────────────────────────────────────

class PluginAPI:
    def __init__(self, loaded: Loaded):
        self._l = loaded
        self.id = loaded.meta["id"]
        self.folder = loaded.path

    def on_dump(self, fn):
        self._l.dump_hooks.append(fn)
        return fn

    def action(self, action_id: str, label: str, fn):
        self._l.actions[action_id] = {"label": label, "fn": fn}
        return fn

    def propose(self, kind: str, title: str, payload: dict, item_id: str | None = None, dump_id: str | None = None):
        from . import suggestions
        if kind == "plugin_action":
            payload = {**payload, "plugin": self.id}
        return suggestions.create(kind, title, payload, source=f"plugin:{self.id}", item_id=item_id, dump_id=dump_id)

    def setting(self, key: str, default=None):
        return (db.get_setting(f"plugin:{self.id}", {}) or {}).get(key, default)

    def set_setting(self, key: str, value):
        cur = db.get_setting(f"plugin:{self.id}", {}) or {}
        cur[key] = value
        db.set_setting(f"plugin:{self.id}", cur)

    def db_query(self, sql: str, params: tuple = ()):
        """Read-only access to the vault. One SELECT, nothing else."""
        s = sql.strip().rstrip(";")
        if not s.lower().startswith("select") or ";" in s:
            raise PermissionError("plugins may run a single SELECT only")
        return [dict(r) for r in db.query(s, params)]

    def log(self, msg: str):
        log(f"[{self.id}] {msg}")


# ── loading ──────────────────────────────────────────────────────────────────

def _load_one(folder: Path) -> Loaded:
    meta = read_meta(folder)
    loaded = Loaded(meta, folder)
    spec = importlib.util.spec_from_file_location(f"bdl_plugin_{meta['id']}", folder / meta["entry"])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        if not hasattr(module, "register"):
            raise AttributeError("the entry module has no register(api) function")
        module.register(PluginAPI(loaded))
    except Exception:
        loaded.error = traceback.format_exc(limit=6)[-1200:]
        log(f"[{meta['id']}] failed to load:\n{loaded.error}")
    return loaded


def load_all() -> list[dict]:
    _loaded.clear()
    enabled = _enabled()
    for folder in sorted(p for p in plugins_dir().iterdir() if p.is_dir()):
        if not (folder / "plugin.json").exists():
            continue
        try:
            meta = read_meta(folder)
        except Exception as e:
            log(f"[{folder.name}] invalid plugin.json: {e}")
            continue
        if not enabled.get(meta["id"]):
            continue
        _loaded[meta["id"]] = _load_one(folder)
    return listing()


def listing() -> list[dict]:
    enabled = _enabled()
    out = []
    for folder in sorted(p for p in plugins_dir().iterdir() if p.is_dir()):
        if not (folder / "plugin.json").exists():
            continue
        try:
            meta = read_meta(folder)
        except Exception as e:
            out.append({"id": folder.name, "name": folder.name, "version": "?", "description": "",
                        "permissions": [], "folder": str(folder), "enabled": False, "loaded": False,
                        "error": f"invalid plugin.json: {e}", "actions": []})
            continue
        L = _loaded.get(meta["id"])
        out.append({**meta, "folder": str(folder), "enabled": bool(enabled.get(meta["id"])),
                    "loaded": bool(L and not L.error), "error": L.error if L else None,
                    "actions": [{"id": a, "label": v["label"]} for a, v in (L.actions.items() if L else [])]})
    return out


def set_enabled(pid: str, on: bool) -> list[dict]:
    e = _enabled()
    e[pid] = bool(on)
    db.set_setting("plugins_enabled", e)
    return load_all()


def install(source: str) -> dict:
    """Copy a folder, or unpack a .zip, into the plugins directory."""
    src = Path(source)
    if not src.exists():
        raise ValueError("that path does not exist")
    dest_root = plugins_dir()
    if src.is_file() and src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            names = [n for n in z.namelist() if not n.startswith(("/", "..")) and ".." not in Path(n).parts]
            inner = [n for n in names if n.rstrip("/").endswith("plugin.json")]
            if not inner:
                raise ValueError("no plugin.json inside that zip")
            root = str(Path(inner[0]).parent).replace("\\", "/").strip(".")
            dest = dest_root / (Path(root).name if root not in ("", "/") else src.stem)
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            for n in names:
                rel = Path(n).relative_to(root) if root else Path(n)
                if n.endswith("/"):
                    (dest / rel).mkdir(parents=True, exist_ok=True)
                else:
                    (dest / rel).parent.mkdir(parents=True, exist_ok=True)
                    (dest / rel).write_bytes(z.read(n))
    else:
        if not (src / "plugin.json").exists():
            raise ValueError("that folder has no plugin.json")
        dest = dest_root / src.name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", ".git"))
    meta = read_meta(dest)
    if dest.name != meta["id"]:
        final = dest_root / meta["id"]
        if final.exists():
            shutil.rmtree(final)
        dest.rename(final)
    log(f"installed {meta['id']} from {source}")
    return {**meta, "installed": True}


def uninstall(pid: str) -> None:
    folder = plugins_dir() / pid
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
    e = _enabled()
    e.pop(pid, None)
    db.set_setting("plugins_enabled", e)
    _loaded.pop(pid, None)


# ── hooks + action execution ─────────────────────────────────────────────────

def on_dump(dump_id: str) -> None:
    if not _loaded:
        return
    dump = db.query_one("SELECT * FROM dumps WHERE id=?", (dump_id,))
    if not dump:
        return
    d = dict(dump)
    for pid, L in _loaded.items():
        for fn in L.dump_hooks:
            try:
                fn(d)
            except Exception:
                log(f"[{pid}] on_dump failed:\n{traceback.format_exc(limit=4)}")


def run_action(pid: str, action_id: str, args: dict | None = None) -> dict:
    L = _loaded.get(pid)
    if not L:
        raise ValueError(f"plugin '{pid}' is not loaded")
    act = L.actions.get(action_id)
    if not act:
        raise ValueError(f"plugin '{pid}' has no action '{action_id}'")
    out = act["fn"](args or {})
    return out if isinstance(out, dict) else {"result": str(out)[:2000]}


def execute_suggestion(payload: dict) -> dict:
    return run_action(payload.get("plugin", ""), payload.get("action", ""), payload.get("args") or {})


def all_actions() -> list[dict]:
    return [{"plugin": pid, "id": a, "label": v["label"]} for pid, L in _loaded.items() for a, v in L.actions.items()]
