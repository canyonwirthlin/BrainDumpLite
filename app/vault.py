"""The vault = the SQLite file. Backup, restore, and relocation (Phase 3).

- backup: a consistent copy via SQLite's online backup API, zipped in memory.
- restore: validate the uploaded zip (contains braindump.db, integrity_check ok),
  swap the file in, reopen the connection. The old file is kept as .bak.
- move: checkpoint the WAL, copy the DB to the new folder, write the pointer
  file that db.vault_dir() reads, reopen. The old file is never deleted.
Engine binaries and models live in the default data dir and are never part
of the vault.
"""
from __future__ import annotations

import io
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import date
from pathlib import Path

from . import db

DB_NAME = "braindump.db"


def info() -> dict:
    p = db.db_path()
    return {"dir": str(p.parent), "db_path": str(p), "size_bytes": p.stat().st_size if p.exists() else 0,
            "default_dir": str(db.data_dir()), "custom": p.parent != db.data_dir()}


def backup_zip() -> tuple[str, bytes]:
    """Returns (filename, zip bytes)."""
    tmp = Path(tempfile.mkdtemp(prefix="bdl-backup-")) / DB_NAME
    try:
        with db.lock():
            dest = sqlite3.connect(str(tmp))
            db.conn().backup(dest)
            dest.close()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmp, DB_NAME)
        return f"braindump-backup-{date.today().isoformat()}.zip", buf.getvalue()
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)


def _check_db(path: Path) -> None:
    c = sqlite3.connect(str(path))
    try:
        row = c.execute("PRAGMA integrity_check").fetchone()
        if not row or row[0] != "ok":
            raise ValueError("the database in this backup is corrupted")
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "dumps" not in tables:
            raise ValueError("this file is not a BrainDump Lite vault")
    finally:
        c.close()


def restore_zip(data: bytes) -> dict:
    tmpdir = Path(tempfile.mkdtemp(prefix="bdl-restore-"))
    try:
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise ValueError("that file is not a zip backup")
        if DB_NAME not in z.namelist():
            raise ValueError(f"the zip has no {DB_NAME} inside")
        z.extract(DB_NAME, tmpdir)
        candidate = tmpdir / DB_NAME
        _check_db(candidate)
        target = db.db_path()
        with db.lock():
            db.close()
            for suffix in ("", "-wal", "-shm"):
                old = Path(str(target) + suffix)
                if old.exists():
                    os.replace(old, Path(str(target) + suffix + ".bak"))
            shutil.copy2(candidate, target)
        db.init_db()
        return {"ok": True, "dumps": db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"]}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def move(new_dir: str) -> dict:
    new_dir = Path(new_dir).expanduser()
    if not str(new_dir).strip():
        raise ValueError("choose a folder")
    try:
        new_dir.mkdir(parents=True, exist_ok=True)
        probe = new_dir / ".bdl-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as e:
        raise ValueError(f"can't write to that folder: {e}")
    src = db.db_path()
    dest = new_dir / DB_NAME
    if dest.resolve() == src.resolve():
        raise ValueError("the vault is already in that folder")
    if dest.exists():
        raise ValueError(f"that folder already has a {DB_NAME}; pick an empty folder or restore it instead")
    with db.lock():
        db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()
        shutil.copy2(src, dest)
        db.set_vault_pointer(new_dir)
    db.init_db()
    return info()


def reset_location() -> dict:
    """Point back at the default data dir (the file there is left as it was)."""
    with db.lock():
        db.close()
        db.set_vault_pointer(None)
    db.init_db()
    return info()
