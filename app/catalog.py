"""Curated model catalog (Phase 7). A JSON file: bundled copy as the fallback,
refreshed from the repo's master branch at most once a day, cached in settings.
Only the metadata travels — a model downloads when the user presses Get."""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

from . import db

REMOTE_URL = "https://raw.githubusercontent.com/canyonwirthlin/BrainDumpLite/master/catalog/models.json"
CACHE_KEY = "catalog_cache"
MAX_AGE = 24 * 3600
REQUIRED = ("id", "label", "repo", "file", "sha256", "size", "vram_gb")


def bundled_path() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "catalog" / "models.json"


def _bundled() -> dict:
    try:
        return json.loads(bundled_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 0, "chat_models": [], "prices_per_million_tokens": {}}


def _valid(data) -> bool:
    if not isinstance(data, dict) or not isinstance(data.get("chat_models"), list) or not data["chat_models"]:
        return False
    return all(isinstance(m, dict) and all(k in m for k in REQUIRED) for m in data["chat_models"])


def fetch_remote(timeout: float = 10.0) -> dict | None:
    try:
        with urllib.request.urlopen(REMOTE_URL, timeout=timeout) as r:
            data = json.load(r)
        return data if _valid(data) else None
    except Exception:
        return None


def load(refresh: bool = False) -> dict:
    """Newest valid catalog: fresh cache → (remote if stale or refresh) → cache → bundled."""
    cache = db.get_setting(CACHE_KEY) or {}
    fresh = cache.get("data") if cache.get("fetched_at", 0) + MAX_AGE > time.time() else None
    if fresh and not refresh and _valid(fresh):
        return fresh
    remote = fetch_remote()
    if remote and _valid(remote):
        db.set_setting(CACHE_KEY, {"fetched_at": time.time(), "data": remote})
        return remote
    if cache.get("data") and _valid(cache["data"]):
        return cache["data"]
    return _bundled()


def chat_models() -> list[dict]:
    seen, out = set(), []
    for m in load().get("chat_models", []):
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        out.append({**m, "tags": list(m.get("tags") or [])})
    return out or _bundled().get("chat_models", [])


def prices() -> dict:
    return load().get("prices_per_million_tokens", {}) or _bundled().get("prices_per_million_tokens", {})


def price_for(provider: str, model: str) -> dict | None:
    return prices().get(f"{provider}/{model}")
