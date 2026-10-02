"""AI pipeline queue + opt-in re-processing.

* Queue: a dump captured while the chosen AI provider can't run yet (built-in model not set up, API key missing...)
  is saved with status 'queued' and picked up by a background watcher as soon as AI becomes available.
* Re-process: after switching model/provider the user may re-run the pipeline over existing dumps. Never automatic.
  Items the user already acted on (approved, done, rejected...) survive a re-run.
"""
from __future__ import annotations

import sys
import threading

from . import ai, db, pipeline

_work = threading.Lock()   # one pipeline run at a time, so local models are never overloaded
_wake = threading.Event()
_watcher: threading.Thread | None = None
_state = {"running": False, "done": 0, "total": 0, "failed": 0, "current": None, "cancel": False, "error": ""}
_slock = threading.Lock()


# ── queue ────────────────────────────────────────────────────────────────────

def should_queue() -> bool:
    """Queue a new dump when an AI provider is chosen but not usable yet. Provider 'off' is a deliberate choice:
    those dumps run the raw (no-AI) pipeline immediately, and can be re-processed later from Settings."""
    return ai.config()["provider"] != "off" and not ai.available()


def queued_ids() -> list[str]:
    return [r["id"] for r in db.query(
        "SELECT id FROM dumps WHERE status='queued' AND deleted_at IS NULL ORDER BY created_at")]


def process_queued() -> int:
    """Run the pipeline over queued dumps while AI stays available. Returns how many were processed."""
    n = 0
    for did in queued_ids():
        if not ai.available():
            break
        with _work:
            row = db.query_one("SELECT status FROM dumps WHERE id=?", (did,))
            if not row or row["status"] != "queued":
                continue
            pipeline.run_pipeline(did)
        n += 1
    return n


def kick() -> None:
    _wake.set()


def _watch() -> None:
    while True:
        _wake.wait(10)
        _wake.clear()
        try:
            if queued_ids() and ai.available():
                process_queued()
        except Exception as e:  # never let the watcher die
            print(f"[queue] watcher error: {e}", flush=True)


def start_watcher() -> None:
    global _watcher
    if "pytest" in sys.modules:   # tests drive process_queued() directly
        return
    if _watcher and _watcher.is_alive():
        return
    _watcher = threading.Thread(target=_watch, daemon=True, name="ai-queue")
    _watcher.start()


# ── re-process ───────────────────────────────────────────────────────────────

_BASE = "status='ready' AND deleted_at IS NULL"


def candidates(scope: str, ids: list[str] | None = None) -> list[str]:
    if scope == "ids":
        ids = ids or []
        if not ids:
            return []
        q = ",".join("?" * len(ids))
        sql, params = f"SELECT id FROM dumps WHERE {_BASE} AND id IN ({q})", tuple(ids)
    elif scope == "raw":        # made without any AI
        sql, params = f"SELECT id FROM dumps WHERE {_BASE} AND (provider IS NULL OR provider='off')", ()
    elif scope == "other":      # made by a different provider than the current one
        sql = f"SELECT id FROM dumps WHERE {_BASE} AND provider IS NOT NULL AND provider!='off' AND provider!=?"
        params = (ai.config()["provider"],)
    elif scope == "all":
        sql, params = f"SELECT id FROM dumps WHERE {_BASE}", ()
    else:
        raise ValueError("bad scope")
    return [r["id"] for r in db.query(sql + " ORDER BY created_at DESC", params)]


def preview() -> dict:
    return {"raw": len(candidates("raw")), "other": len(candidates("other")), "all": len(candidates("all")),
            "provider": ai.config()["provider"], "available": ai.available()}


def status() -> dict:
    with _slock:
        s = dict(_state)
    s["queued"] = len(queued_ids())
    return {**s, **preview()}


def start(scope: str, ids: list[str] | None = None) -> tuple[bool, str]:
    if not ai.available():
        return False, "No AI model is on - set one up in Settings -> AI first."
    try:
        rows = candidates(scope, ids)
    except ValueError:
        return False, "Unknown scope"
    with _slock:
        if _state["running"]:
            return False, "Already running"
        if not rows:
            return True, "Nothing to do"
        _state.update(running=True, done=0, total=len(rows), failed=0, current=None, cancel=False, error="")
    threading.Thread(target=_run, args=(rows,), daemon=True, name="reprocess").start()
    return True, "started"


def cancel() -> bool:
    with _slock:
        was = _state["running"]
        _state["cancel"] = True
    return was


def _run(rows: list[str]) -> None:
    try:
        for did in rows:
            with _slock:
                if _state["cancel"]:
                    break
                _state["current"] = did
            if not ai.available():
                with _slock:
                    _state["error"] = "AI went away - stopped."
                break
            ok = reprocess_one(did)
            with _slock:
                _state["done" if ok else "failed"] += 1
    finally:
        with _slock:
            _state.update(running=False, current=None)


def reprocess_one(dump_id: str) -> bool:
    """Re-run the pipeline for one ready dump, keeping every item the user has acted on."""
    with _work:
        if not db.query_one("SELECT 1 FROM dumps WHERE id=?", (dump_id,)):
            return False
        kept = [dict(r) for r in db.query(
            "SELECT * FROM items WHERE dump_id=? AND (status!='suggested' OR done=1)", (dump_id,))]
        d = db.query_one("SELECT title, raw_text, clean_text FROM dumps WHERE id=?", (dump_id,))
        auto = {" ".join((t or "").split()[:6])[:60] for t in (d["raw_text"], d["clean_text"])}
        if d["title"] in auto:   # a placeholder title (first words) is regenerated; a title the user wrote or imported is kept
            db.execute("UPDATE dumps SET title=NULL WHERE id=?", (dump_id,))
        try:
            pipeline.run_pipeline(dump_id)
        finally:
            _restore_items(dump_id, kept)
        after = db.query_one("SELECT status FROM dumps WHERE id=?", (dump_id,))
        if after and after["status"] == "failed":
            # don't leave a once-good dump in a failed state; the error text stays on the row
            db.execute("UPDATE dumps SET status='ready', stage=NULL WHERE id=?", (dump_id,))
            return False
        return True


def _restore_items(dump_id: str, kept: list[dict]) -> None:
    if not kept:
        return
    kept_ids = {k["id"] for k in kept}
    names = {(k["content"] or "").strip().lower() for k in kept}
    for r in db.query("SELECT id, content FROM items WHERE dump_id=?", (dump_id,)):
        if r["id"] not in kept_ids and (r["content"] or "").strip().lower() in names:
            db.execute("DELETE FROM items WHERE id=?", (r["id"],))
            db.execute("DELETE FROM items_fts WHERE item_id=?", (r["id"],))
    for k in kept:
        cols = list(k)
        db.execute(f"INSERT OR REPLACE INTO items ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                   tuple(k[c] for c in cols))
        db.execute("DELETE FROM items_fts WHERE item_id=?", (k["id"],))
        db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)",
                   (k["id"], dump_id, f"{k['content']} {k.get('detail') or ''}"))
