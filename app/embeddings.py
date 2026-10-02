"""Rebuild missing search embeddings (Settings -> Data -> "Rebuild search index").

A dump gets its embedding at capture time. Dumps made while no AI was on, imported from another app, or
captured before an embedding model was set up have none, so semantic search can't find them. This fills
the gaps in a background thread, one dump at a time, and reports progress for the UI to poll.
"""
from __future__ import annotations

import json
import threading

from . import ai, db

_state = {"running": False, "done": 0, "total": 0, "failed": 0, "error": ""}
_lock = threading.Lock()


def _missing(everything: bool = False) -> list:
    """Dumps to (re)embed. everything=True re-embeds all of them, e.g. after switching to an embedding model with
    a different vector size (old and new vectors can't be compared)."""
    where = "" if everything else " AND (embedding IS NULL OR embedding='')"
    return db.query("SELECT id, title, summary, clean_text, raw_text FROM dumps "
                    f"WHERE status='ready' AND deleted_at IS NULL{where}")


def status() -> dict:
    with _lock:
        s = dict(_state)
    s["missing"] = len(_missing()) if not s["running"] else max(0, s["total"] - s["done"] - s["failed"])
    s["total_dumps"] = db.query_one("SELECT COUNT(*) AS n FROM dumps WHERE status='ready' AND deleted_at IS NULL")["n"]
    s["available"] = ai.available()
    return s


def start(everything: bool = False) -> tuple[bool, str]:
    if not ai.available():
        return False, "No AI model is on - set one up in Settings -> AI first."
    with _lock:
        if _state["running"]:
            return False, "Already running"
        rows = _missing(everything)
        _state.update(running=True, done=0, total=len(rows), failed=0, error="")
    if not rows:
        with _lock:
            _state["running"] = False
        return True, "Nothing to do"
    threading.Thread(target=_run, args=(rows,), daemon=True, name="rebuild-embeddings").start()
    return True, "started"


def _run(rows) -> None:
    try:
        for r in rows:
            text = f"{r['title'] or ''}\n{r['summary'] or ''}\n{r['clean_text'] or r['raw_text']}"
            try:
                emb = ai.embed(text)
            except Exception as e:
                emb = None
                with _lock:
                    _state["error"] = str(e)[:200]
            if emb:
                db.execute("UPDATE dumps SET embedding=? WHERE id=?", (json.dumps(emb), r["id"]))
                with _lock:
                    _state["done"] += 1
            else:
                with _lock:
                    _state["failed"] += 1
                    # the provider can't embed at all (e.g. Claude, or no embed model): stop instead of grinding through
                    if _state["done"] == 0 and _state["failed"] >= 3:
                        _state["error"] = _state["error"] or "This AI provider can't create embeddings - pick one that can (Gemini, OpenAI, built-in or a local embed model)."
                        break
    finally:
        with _lock:
            _state["running"] = False
