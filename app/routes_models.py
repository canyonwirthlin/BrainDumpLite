"""Model-management endpoints: pause/resume a download, and the "Copy diagnostics" report.
Mounted under /api from main.py."""
from __future__ import annotations

import os
import platform
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import db, engine
from .version import __version__

router = APIRouter()


@router.post("/engine/pause")
def engine_pause():
    return {"paused": engine.pause_setup()}


@router.post("/engine/resume")
def engine_resume():
    ok, msg = engine.resume_setup()
    if not ok:
        raise HTTPException(400, msg)
    return {"message": msg}


# ── Diagnostics ──────────────────────────────────────────────────────────────

_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"),                       # OpenAI / Anthropic style
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),                     # Google
    re.compile(r"(?i)\b(bearer|token|api[_-]?key|authorization)\b\s*[:=]?\s*[\"']?[A-Za-z0-9._\-]{12,}"),
    re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"),                       # any long opaque token
]


def redact(text: str) -> str:
    """Strip secrets and the user's name (home dir / account name inside paths) from free text."""
    if not text:
        return text
    names = {os.environ.get("USERNAME", ""), os.environ.get("USER", ""), Path.home().name}
    for n in sorted((n for n in names if len(n) >= 2), key=len, reverse=True):
        text = re.sub(re.escape(n), "<user>", text, flags=re.IGNORECASE)
    for pat in _SECRET_PATTERNS:
        text = pat.sub("<redacted>", text)
    return text


def _count(sql: str) -> int:
    try:
        row = db.query_one(sql)
        return int(row[0]) if row else 0
    except Exception:
        return 0


def build_diagnostics() -> dict:
    gpu = engine.detect_gpu()
    st = engine.status()
    try:
        db_bytes = db.db_path().stat().st_size
    except OSError:
        db_bytes = 0
    setup = {k: v for k, v in st["setup"].items() if k != "message"}
    setup["message"] = redact(st["setup"].get("message") or "")
    return {
        "app_version": __version__,
        "os": f"{platform.system()} {platform.release()} ({platform.version()}) {platform.machine()}",
        "python": platform.python_version(),
        "gpu": {"name": gpu.get("name"), "vram_mb": gpu.get("vram_mb")},
        "provider": db.get_setting("provider"),
        "active_model": st["active_model"],
        "engine": {
            "supported": st["supported"], "installed": st["engine_installed"],
            "server": st["server"], "embed_downloaded": st["embed_downloaded"],
            "setup": setup,
        },
        "db_size_mb": round(db_bytes / 1048576, 2),
        "counts": {
            "dumps": _count("SELECT COUNT(*) FROM dumps"),
            "dumps_failed": _count("SELECT COUNT(*) FROM dumps WHERE status='failed'"),
            "items": _count("SELECT COUNT(*) FROM items"),
        },
        "engine_log_tail": redact(engine._log_tail("engine-chat.log", 1500)),
    }


def render_text(d: dict) -> str:
    g = d["gpu"]
    lines = [
        f"BrainDump Lite {d['app_version']}",
        f"OS: {d['os']}",
        f"GPU: {g['name'] or 'none detected'} ({g['vram_mb']} MB VRAM)",
        f"AI provider: {d['provider'] or 'unset'}; active model: {d['active_model'] or 'none'}",
        f"Engine: supported={d['engine']['supported']} installed={d['engine']['installed']} "
        f"server={d['engine']['server']} setup={d['engine']['setup'].get('phase')}",
        f"Vault: {d['db_size_mb']} MB; dumps={d['counts']['dumps']} (failed {d['counts']['dumps_failed']}), items={d['counts']['items']}",
        "",
        "Recent engine log:",
        d["engine_log_tail"] or "(empty)",
    ]
    return "\n".join(lines)


@router.get("/diagnostics")
def diagnostics():
    d = build_diagnostics()
    d["text"] = render_text(d)
    return d
