"""Secrets at rest (Phase 8): OAuth tokens and API tokens are stored in the
settings table, but encrypted with Windows DPAPI (tied to the Windows user)
via ctypes — no extra dependency. Other platforms fall back to a marked
plaintext value so the UI can warn."""
from __future__ import annotations

import base64
import ctypes
import os

from . import db

PREFIX = "secret:"


def storage_kind() -> str:
    return "dpapi" if os.name == "nt" else "plain"


if os.name == "nt":
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    def _dpapi(data: bytes, encrypt: bool) -> bytes:
        crypt32 = ctypes.windll.crypt32
        inp = _BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
        out = _BLOB()
        fn = crypt32.CryptProtectData if encrypt else crypt32.CryptUnprotectData
        ok = fn(ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out))
        if not ok:
            raise OSError("DPAPI call failed")
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out.pbData)
else:
    def _dpapi(data: bytes, encrypt: bool) -> bytes:  # pragma: no cover
        return data


def protect(value: str) -> str:
    raw = value.encode("utf-8")
    if storage_kind() == "dpapi":
        return "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode("ascii")
    return "plain:" + base64.b64encode(raw).decode("ascii")


def unprotect(stored: str) -> str:
    kind, _, b64 = stored.partition(":")
    raw = base64.b64decode(b64)
    if kind == "dpapi":
        return _dpapi(raw, False).decode("utf-8")
    return raw.decode("utf-8")


def set_secret(key: str, value: str | None) -> None:
    if value is None:
        db.execute("DELETE FROM settings WHERE key=?", (PREFIX + key,))
    else:
        db.set_setting(PREFIX + key, protect(value))


def get_secret(key: str) -> str | None:
    stored = db.get_setting(PREFIX + key)
    if not stored:
        return None
    try:
        return unprotect(stored)
    except Exception:
        return None
