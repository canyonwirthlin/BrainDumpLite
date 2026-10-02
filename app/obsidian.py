"""Obsidian vault mirror: a ONE-WAY live sync of dumps into a folder as Markdown.

Safety: only files whose front matter carries `braindump_id:` are ever
rewritten, renamed or moved; everything else in the folder is left alone.
Dumps that leave the selection (trashed/deleted/private) have their file moved
to `<folder>/_trash/`. A background reconciler re-renders on a timer and only
writes files whose content actually changed, so no hooks into the mutation
points are needed (`kick()` just wakes it early)."""
from __future__ import annotations

import hashlib
import re
import sys
import threading
from pathlib import Path

from . import db, export_md

KEY = "obsidian_mirror"
MARK = "braindump_id:"
TRASH = "_trash"
_lock = threading.RLock()
_wake = threading.Event()
_watcher: threading.Thread | None = None


def select_ids() -> list[str]:
    """THE single place deciding which dumps are mirrored. Excludes trash;
    add `AND COALESCE(is_private,0)=0` here when private dumps ship."""
    return [r["id"] for r in db.query(
        "SELECT id FROM dumps WHERE status='ready' AND deleted_at IS NULL "
        # PRIVATE: AND COALESCE(is_private,0)=0
        "ORDER BY created_at")]


def _cfg() -> dict:
    return db.get_setting(KEY) or {}


def _save(cfg: dict) -> None:
    db.set_setting(KEY, cfg)


def status() -> dict:
    c = _cfg()
    return {"enabled": bool(c.get("enabled") and c.get("dir")), "dir": c.get("dir"), "last_sync": c.get("last_sync"),
            "last_error": c.get("last_error"), "count": len(c.get("files") or {})}


def render(dump_id: str) -> tuple[str, str]:
    """(filename, text) for one dump; text carries the braindump_id marker."""
    _, text = export_md.dump_markdown(dump_id, True)
    title = db.query_one("SELECT title FROM dumps WHERE id=?", (dump_id,))["title"]
    text = text.replace("---\n", f"---\n{MARK} {dump_id}\n", 1)
    return f"{export_md._safe_title(title or 'Untitled')} {dump_id[:8]}.md", text


def _owner(path: Path) -> str | None:
    """braindump_id of a file we created, else None (also None if unreadable)."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            head = f.read(2000)
    except OSError:
        return None
    if not head.startswith("---"):
        return None
    m = re.search(r"^" + re.escape(MARK) + r"[ \t]*(\S+)[ \t]*$", head.split("\n---", 1)[0], re.M)
    return m.group(1) if m else None


def _hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def _unique(dest: Path) -> Path:
    n, p = 1, dest
    while p.exists():
        p = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
        n += 1
    return p


def sync(full: bool = False) -> dict:
    """Reconcile the folder with the database. Per-file errors are collected, not raised."""
    with _lock:
        cfg = _cfg()
        if not (cfg.get("enabled") and cfg.get("dir")):
            return {"written": 0, "removed": 0}
        folder = Path(cfg["dir"])
        files: dict = dict(cfg.get("files") or {})
        res = {"written": 0, "removed": 0, "skipped": 0}
        errors: list[str] = []
        try:
            folder.mkdir(parents=True, exist_ok=True)
            if full or not files:  # adopt files we made earlier but lost track of
                for p in folder.glob("*.md"):
                    oid = _owner(p)
                    if oid and oid not in files:
                        files[oid] = {"file": p.name, "hash": ""}
            wanted = select_ids()
            for did in wanted:
                try:
                    name, text = render(did)
                    h = _hash(text)
                    cur = files.get(did)
                    target = folder / name
                    if cur and cur["file"] == name and cur.get("hash") == h and target.exists():
                        continue
                    if cur and cur["file"] != name:           # title changed -> rename
                        old = folder / cur["file"]
                        if old.exists() and _owner(old) == did:
                            if target.exists():
                                if _owner(target) != did:
                                    res["skipped"] += 1
                                    errors.append(f"{name}: a file you made already uses that name")
                                    continue
                                old.unlink()
                            else:
                                old.replace(target)
                    if target.exists() and _owner(target) != did:
                        res["skipped"] += 1
                        errors.append(f"{name}: not overwriting a file BrainDump didn't create")
                        continue
                    tmp = folder / (name + ".bdtmp")
                    tmp.write_text(text, encoding="utf-8", newline="\n")
                    tmp.replace(target)
                    files[did] = {"file": name, "hash": h}
                    res["written"] += 1
                except Exception as e:  # one bad dump must not stop the rest
                    errors.append(f"{did[:8]}: {e}")
            keep = set(wanted)
            for did in [d for d in files if d not in keep]:
                p = folder / files[did]["file"]
                if p.exists() and _owner(p) == did:
                    td = folder / TRASH
                    td.mkdir(exist_ok=True)
                    p.replace(_unique(td / p.name))
                    res["removed"] += 1
                del files[did]
        except Exception as e:
            errors.append(str(e))
        cfg = _cfg()
        if not (cfg.get("enabled") and cfg.get("dir") == str(folder)):
            return res  # disabled/changed while we ran
        cfg.update(files=files, last_sync=db.now_iso(), last_error="; ".join(errors[:3]) or None)
        _save(cfg)
        res["errors"] = errors
        return res


def configure(folder: str | None, enabled: bool = True) -> dict:
    with _lock:
        old = _cfg()
        if not folder:
            _save({"enabled": False, "dir": old.get("dir"), "files": old.get("files") or {}})
            return status()
        d = Path(folder).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        files = (old.get("files") or {}) if old.get("dir") == str(d) else {}
        _save({"enabled": enabled, "dir": str(d), "files": files})
    if enabled:
        sync(full=True)
    return status()


def kick() -> None:
    _wake.set()


def _watch() -> None:
    while True:
        _wake.wait(20)
        _wake.clear()
        try:
            if _cfg().get("enabled"):
                sync()
        except Exception as e:  # never let the watcher die
            print(f"[obsidian] watcher error: {e}", flush=True)


def start_watcher() -> None:
    global _watcher
    if "pytest" in sys.modules:
        return
    if _watcher and _watcher.is_alive():
        return
    _watcher = threading.Thread(target=_watch, daemon=True, name="obsidian-mirror")
    _watcher.start()
