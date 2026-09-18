"""App factory: API under /api, static SPA at /. No CORS needed (same origin)."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import db
from .routes import router


def static_dir() -> Path:
    # PyInstaller sets _MEIPASS (onefile temp dir / onedir _internal);
    # in dev it's the repo root next to app/.
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "static"


def create_app() -> FastAPI:
    db.init_db()
    app = FastAPI(title="BrainDump Lite", docs_url=None, redoc_url=None)
    app.include_router(router, prefix="/api")
    app.mount("/", StaticFiles(directory=static_dir(), html=True), name="static")
    return app
