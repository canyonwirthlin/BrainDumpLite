"""Automatic backups of the vault (braindump.db).

Your whole second brain is one SQLite file, so a daily copy is cheap insurance. Copies are made with
SQLite's own backup API (consistent even while the app is writing), named braindump-YYYYmmdd-HHMMSS.db,
and only the newest `keep` are kept. Default folder: <data dir>/backups - deliberately NOT inside the vault
folder, so a vault that was moved to a synced/removable drive still has a local safety copy.

Restore: restore_backup(name) swaps a backup in after saving a braindump-prerestore-*.db copy of the live
vault (never pruned) and keeping the replaced files as .bak.
Private dumps: config `include_private` (default True = a plain whole-db copy). False scrubs the
is_private rows out of the copy, never out of the live vault.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from . import db
from .vault import _check_db

KEY = "backup"                      # settings: {"enabled": bool, "dir": str, "keep": int, "include_private": bool}
STATE_KEY = "backup_state"          # settings: {"last_ok": iso, "last_error": str|None, "last_error_at": iso|None}
DEFAULTS = {"enabled": True, "dir": "", "keep": 7, "include_private": True}
INTERVAL_S = 20 * 3600              # a new automatic backup once the newest is older than this
_NAME = re.compile(r"^braindump-\d{8}-\d{6}\.db$")
_PRE = re.compile(r"^braindump-prerestore-\d{8}-\d{6}\.db$")   # safety copies made before a restore; never pruned
_started = False


def config() -> dict:
    c = db.get_setting(KEY, {})
    out = {**DEFAULTS, **(c if isinstance(c, dict) else {})}
    out["keep"] = max(1, min(60, int(out.get("keep") or 7)))
    out["include_private"] = bool(out.get("include_private", True))
    return out


def set_config(enabled: bool | None = None, dir: str | None = None, keep: int | None = None,
               include_private: bool | None = None) -> dict:
    c = config()
    if enabled is not None:
        c["enabled"] = bool(enabled)
    if keep is not None:
        c["keep"] = max(1, min(60, int(keep)))
    if include_private is not None:
        c["include_private"] = bool(include_private)
    if dir is not None:
        d = dir.strip()
        if d:
            p = Path(d).expanduser()
            p.mkdir(parents=True, exist_ok=True)   # fails loudly (ValueError/OSError) if it can't be used
            if not p.is_dir():
                raise ValueError("That isn't a folder")
            probe = p / ".bdl-write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        c["dir"] = d
    db.set_setting(KEY, c)
    return config()


def backup_dir() -> Path:
    d = config()["dir"]
    p = Path(d).expanduser() if d else db.data_dir() / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _state() -> dict:
    s = db.get_setting(STATE_KEY, {})
    return s if isinstance(s, dict) else {}


def _record(ok: bool, error: str | None = None) -> None:
    s = _state()
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    if ok:
        s.update(last_ok=now, last_error=None, last_error_at=None)
    else:
        s.update(last_error=error, last_error_at=now)
    db.set_setting(STATE_KEY, s)


def list_backups() -> list[dict]:
    out = []
    for f in sorted(backup_dir().iterdir(), reverse=True):   # names embed the timestamp, so name order = age order
        if _NAME.match(f.name):
            st = f.stat()
            out.append({"name": f.name, "size_mb": round(st.st_size / 1048576, 2),
                        "at": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds")})
    return out


def _scrub_private(path: Path) -> None:
    """Drop private dumps (and, by cascade, their items/links) from a backup copy."""
    c = sqlite3.connect(str(path))
    try:
        c.execute("PRAGMA foreign_keys=ON")
        cols = {r[1] for r in c.execute("PRAGMA table_info(dumps)")}
        if "is_private" in cols:
            for (i,) in c.execute("SELECT id FROM dumps WHERE is_private=1").fetchall():
                c.execute("DELETE FROM dumps_fts WHERE id=?", (i,))
                c.execute("DELETE FROM items_fts WHERE dump_id=?", (i,))
            c.execute("DELETE FROM dumps WHERE is_private=1")
            c.commit()
    finally:
        c.close()


def _snapshot(dest: Path, include_private: bool = True) -> None:
    """Consistent copy of the live vault to `dest`, written under a temp name so a failure leaves nothing behind."""
    tmp = dest.with_name(dest.name + ".part")
    try:
        with db.lock():
            db.conn().commit()
            target = sqlite3.connect(str(tmp))
            try:
                db.conn().backup(target)
            finally:
                target.close()
        if not include_private:
            _scrub_private(tmp)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def run_backup() -> dict:
    """Copy the live vault into the backup folder now, then prune old copies. Records success/failure."""
    try:
        d = backup_dir()
        dest = d / f"braindump-{datetime.now():%Y%m%d-%H%M%S}.db"
        _snapshot(dest, config()["include_private"])
        for old in list_backups()[config()["keep"]:]:
            try:
                (d / old["name"]).unlink()
            except OSError:
                pass
        _record(True)
    except Exception as e:
        _record(False, str(e) or e.__class__.__name__)
        raise
    return {"name": dest.name, "size_mb": round(dest.stat().st_size / 1048576, 2)}


def restore_backup(name: str) -> dict:
    """Replace the live vault with one of the folder's backups. The current vault is first copied to
    braindump-prerestore-*.db in the same folder (and the old files are kept as .bak), so nothing is lost."""
    if not _NAME.match(name or ""):
        raise ValueError("not a backup file")
    src = backup_dir() / name
    if not src.is_file():
        raise ValueError("that backup no longer exists")
    _check_db(src)
    pre = backup_dir() / f"braindump-prerestore-{datetime.now():%Y%m%d-%H%M%S}.db"
    _snapshot(pre, True)
    target = db.db_path()
    with db.lock():
        db.close()
        for suffix in ("", "-wal", "-shm"):
            old = Path(str(target) + suffix)
            if old.exists():
                os.replace(old, Path(str(target) + suffix + ".bak"))
        shutil.copy2(src, target)
    db.init_db()
    return {"ok": True, "restored": name, "pre_restore_copy": pre.name,
            "dumps": db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"]}


def status() -> dict:
    pre: list[str] = []
    try:
        items = list_backups()
        folder, folder_error = str(backup_dir()), None
        pre = sorted((f.name for f in Path(folder).iterdir() if _PRE.match(f.name)), reverse=True)[:5]
    except OSError as e:     # e.g. the chosen drive is unplugged
        items, folder, folder_error = [], config()["dir"], str(e)
    return {**config(), **_state(), "folder": folder, "folder_error": folder_error,
            "backups": items[:20], "count": len(items), "pre_restore": pre}


def _due() -> bool:
    c = config()
    if not c["enabled"]:
        return False
    items = list_backups()
    if not items:
        return True
    newest = datetime.fromisoformat(items[0]["at"]).timestamp()
    return time.time() - newest >= INTERVAL_S


def _loop() -> None:
    time.sleep(60)    # let startup finish before the first check
    while True:
        try:
            if _due():
                run_backup()
        except Exception as e:     # never let a backup problem take the app down (run_backup recorded it for Settings)
            print(f"[backup] skipped: {e}", flush=True)
            try:
                _record(False, str(e) or e.__class__.__name__)
            except Exception:
                pass
        time.sleep(3600)


def start() -> None:
    """Called once from create_app(): an hourly check in a daemon thread."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="auto-backup").start()
