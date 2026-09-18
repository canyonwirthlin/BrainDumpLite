"""App factory: API under /api, static SPA at /. No CORS needed (same origin)."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import db, engine
from .routes import router


def static_dir() -> Path:
    # Prefer the static/ that ships NEXT TO this app package. When running from
    # a downloaded update bundle (<data>/code/<version>/app/), that's the
    # UPDATED frontend — without this, live updates ship new JS/HTML that never
    # gets served, because the exe keeps serving its baked-in _MEIPASS/static.
    # Resolves correctly in all cases: dev (repo root), frozen seed (app/ lives
    # under _MEIPASS), and update bundle (the versioned code folder).
    sibling = Path(__file__).resolve().parent.parent / "static"
    if (sibling / "index.html").exists():
        return sibling
    # Fallback: the PyInstaller bundle dir (onefile temp / onedir _internal).
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "static"


def create_app() -> FastAPI:
    db.init_db()
    engine.autostart()  # warm the built-in AI servers (no-op unless configured)
    app = FastAPI(title="BrainDump Lite", docs_url=None, redoc_url=None)
    app.include_router(router, prefix="/api")
    app.mount("/", StaticFiles(directory=static_dir(), html=True), name="static")
    return app
