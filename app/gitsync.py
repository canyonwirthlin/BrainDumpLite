"""Git mirror (Phase 6): export the vault as markdown (+ a backup zip) into a
git repository the user owns and commit/push it. Uses the system `git`; every
step's output is returned so the user can see what happened."""
from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from . import db, export_md, vault

KEY = "git_mirror"


def git_available() -> bool:
    return shutil.which("git") is not None


def status() -> dict:
    cfg = db.get_setting(KEY) or {}
    return {"configured": bool(cfg.get("dir")), "dir": cfg.get("dir"), "last_sync": cfg.get("last_sync"),
            "git_available": git_available(), "last_log": cfg.get("last_log", "")}


def configure(folder: str | None) -> dict:
    if not folder:
        db.execute("DELETE FROM settings WHERE key=?", (KEY,))
        return status()
    d = Path(folder).expanduser()
    if not (d / ".git").exists():
        raise ValueError("that folder is not a git repository (run `git init` or clone one there first)")
    db.set_setting(KEY, {"dir": str(d), "last_sync": None, "last_log": ""})
    return status()


def _git(repo: Path, *args: str) -> tuple[int, str]:
    try:
        p = subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True, timeout=120,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def sync_now(message: str | None = None, push: bool = True) -> dict:
    cfg = db.get_setting(KEY) or {}
    if not cfg.get("dir"):
        raise ValueError("no git mirror folder configured")
    if not git_available():
        raise ValueError("git is not installed or not on PATH")
    repo = Path(cfg["dir"])
    log: list[str] = []
    n = export_md.write_all(repo / "dumps", wikilinks=True)
    log.append(f"exported {n} dump{'s' if n != 1 else ''} to dumps/")
    _, data = vault.backup_zip()
    (repo / "braindump-backup.zip").write_bytes(data)
    log.append("wrote braindump-backup.zip")
    code, out = _git(repo, "add", "-A")
    log.append(f"$ git add -A → {code}" + (f"\n{out}" if out else ""))
    msg = message or f"BrainDump Lite sync {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    code, out = _git(repo, "commit", "-m", msg)
    log.append(f"$ git commit → {code}\n{out}")
    pushed = None
    if push and code == 0:
        code, out = _git(repo, "push")
        pushed = code == 0
        log.append(f"$ git push → {code}\n{out}")
    text = "\n".join(log)
    db.set_setting(KEY, {**cfg, "last_sync": db.now_iso(), "last_log": text[-4000:]})
    return {"ok": True, "pushed": pushed, "log": text}
