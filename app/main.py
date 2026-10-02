"""App factory: API under /api, static SPA at /. No CORS needed (same origin)."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import backup, db, engine, item_types, lock, plugins, reprocess, stats
from .routes import oauth_router, router
from .routes_data import router as data_router
from .routes_extra import router as extra_router
from .routes_models import router as models_router
from .routes_tasks import router as tasks_router
from .routes_pipeline import router as pipeline_router


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


class _Static(StaticFiles):
    """Static files that the webview must revalidate on every load (ETag makes that a cheap 304).
    Without this the embedded browser keeps serving an old copy of the UI's JS after an update,
    because its module imports aren't versioned and Last-Modified alone lets it cache for hours."""

    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


def create_app() -> FastAPI:
    db.init_db()
    item_types.seed()
    stats.sample_daily()
    engine.autostart()  # warm the built-in AI servers (no-op unless configured)
    lock.boot()
    backup.start()      # hourly check; makes a daily copy of the vault (Settings -> Data)
    plugins.load_all()  # a set passphrase means the app starts locked
    app = FastAPI(title="BrainDump Lite", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def app_lock_gate(request: Request, call_next):
        if lock.locked() and not lock.allowed(request.url.path):
            return JSONResponse({"detail": "locked"}, status_code=423)
        return await call_next(request)

    app.include_router(router, prefix="/api")
    app.include_router(extra_router, prefix="/api")
    app.include_router(models_router, prefix="/api")
    app.include_router(tasks_router, prefix="/api")
    app.include_router(pipeline_router, prefix="/api")
    reprocess.start_watcher()  # processes dumps queued while no AI was on
    app.include_router(data_router, prefix="/api")
    app.include_router(oauth_router)
    app.mount("/", _Static(directory=static_dir(), html=True), name="static")
    return app
