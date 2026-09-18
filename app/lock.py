"""Optional local app lock (Phase 4): a passphrase gates the API while locked.

Only a PBKDF2-SHA256 hash + salt is stored (settings key "app_lock"). Lock
state is process memory: the app starts locked when a passphrase is set.
There is deliberately no recovery path — forgetting the passphrase means
deleting the "app_lock" settings row with any SQLite tool.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import threading

from . import db

_state = {"locked": False}
_lock = threading.Lock()
ALLOW_WHILE_LOCKED = {"/api/status", "/api/unlock", "/api/changelog", "/api/lock"}
MIN_LEN = 4


def _hash(passphrase: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), bytes.fromhex(salt), 200_000).hex()


def is_set() -> bool:
    return bool(db.get_setting("app_lock"))


def verify(passphrase: str) -> bool:
    rec = db.get_setting("app_lock")
    if not rec:
        return False
    return hmac.compare_digest(_hash(passphrase or "", rec["salt"]), rec["hash"])


def set_passphrase(passphrase: str, current: str | None = None) -> None:
    if is_set() and not verify(current or ""):
        raise ValueError("current passphrase is wrong")
    if len(passphrase or "") < MIN_LEN:
        raise ValueError(f"passphrase must be at least {MIN_LEN} characters")
    salt = os.urandom(16).hex()
    db.set_setting("app_lock", {"salt": salt, "hash": _hash(passphrase, salt)})


def clear(passphrase: str) -> None:
    if not verify(passphrase):
        raise ValueError("passphrase is wrong")
    db.execute("DELETE FROM settings WHERE key='app_lock'")
    with _lock:
        _state["locked"] = False


def locked() -> bool:
    return _state["locked"] and is_set()


def lock() -> None:
    with _lock:
        _state["locked"] = is_set()


def unlock(passphrase: str) -> bool:
    if not verify(passphrase):
        return False
    with _lock:
        _state["locked"] = False
    return True


def boot() -> None:
    """Called once at app start: a set passphrase means we start locked."""
    with _lock:
        _state["locked"] = is_set()


def allowed(path: str) -> bool:
    return not path.startswith("/api/") or path in ALLOW_WHILE_LOCKED
