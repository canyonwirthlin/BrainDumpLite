"""Automatic backups of the vault (braindump.db).

Your whole second brain is one SQLite file, so a daily copy is cheap insurance. Copies are made with
SQLite's own backup API (consistent even while the app is writing), named braindump-YYYYmmdd-HHMMSS.db,
and only the newest `keep` are kept. Default folder: <data dir>/backups - deliberately NOT inside the vault
folder, so a vault that was moved to a synced/removable drive still has a local safety copy.
Restoring is a file copy: quit the app and replace braindump.db with a backup (see the README).
"""
from __future__ import annotations

import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from . import db

KEY = "backup"                      # settings: {"enabled": bool, "dir": str, "keep": int}
DEFAULTS = {"enabled": True, "dir": "", "keep": 7}
INTERVAL_S = 20 * 3600              # a new automatic backup once the newest is older than this
_NAME = re.compile(r"^braindump-\d{8}-\d{6}\.db$")
_started = False


def config() -> dict:
    c = db.get_setting(KEY, {})
    out = {**DEFAULTS, **(c if isinstance(c, dict) else {})}
    out["keep"] = max(1, min(60, int(out.get("keep") or 7)))
    return out


def set_config(enabled: bool | None = None, dir: str | None = None, keep: int | None = None) -> dict:
    c = config()
    if enabled is not None:
        c["enabled"] = bool(enabled)
    if keep is not None:
        c["keep"] = max(1, min(60, int(keep)))
    if dir is not None:
        d = dir.strip()
        if d:
            p = Path(d).expanduser()
            p.mkdir(parents=True, exist_ok=True)   # fails loudly (ValueError/OSError) if it can't be used
            if not p.is_dir():
                raise ValueError("That isn't a folder")
        c["dir"] = d
    db.set_setting(KEY, c)
    return config()


def backup_dir() -> Path:
    d = config()["dir"]
    p = Path(d).expanduser() if d else db.data_dir() / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


def list_backups() -> list[dict]:
    out = []
    for f in sorted(backup_dir().iterdir(), reverse=True):
        if _NAME.match(f.name):
            st = f.stat()
            out.append({"name": f.name, "size_mb": round(st.st_size / 1048576, 2),
                        "at": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds")})
    return out


def run_backup() -> dict:
    """Copy the live vault into the backup folder now, then prune old copies."""
    dest = backup_dir() / f"braindump-{datetime.now():%Y%m%d-%H%M%S}.db"
    with db.lock():
        db.conn().commit()
        target = sqlite3.connect(str(dest))
        try:
            db.conn().backup(target)
        finally:
            target.close()
    for old in list_backups()[config()["keep"]:]:
        try:
            (backup_dir() / old["name"]).unlink()
        except OSError:
            pass
    return {"name": dest.name, "size_mb": round(dest.stat().st_size / 1048576, 2)}


def status() -> dict:
    items = list_backups()
    return {**config(), "folder": str(backup_dir()), "backups": items[:20], "count": len(items)}


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
        except Exception as e:     # never let a backup problem take the app down
            print(f"[backup] skipped: {e}", flush=True)
        time.sleep(3600)


def start() -> None:
    """Called once from create_app(): an hourly check in a daemon thread."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="auto-backup").start()
