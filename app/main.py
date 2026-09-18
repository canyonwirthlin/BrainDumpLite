"""App factory: API under /api, static SPA at /. No CORS needed (same origin)."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, engine, item_types, lock, plugins, stats
from .routes import oauth_router, router


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
    item_types.seed()
    stats.sample_daily()
    engine.autostart()  # warm the built-in AI servers (no-op unless configured)
    lock.boot()
    plugins.load_all()  # a set passphrase means the app starts locked
    app = FastAPI(title="BrainDump Lite", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def app_lock_gate(request: Request, call_next):
        if lock.locked() and not lock.allowed(request.url.path):
            return JSONResponse({"detail": "locked"}, status_code=423)
        return await call_next(request)

    app.include_router(router, prefix="/api")
    app.include_router(oauth_router)
    app.mount("/", StaticFiles(directory=static_dir(), html=True), name="static")
    return app
