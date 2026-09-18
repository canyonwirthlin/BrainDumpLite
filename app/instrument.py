"""Per-model-call instrumentation (Phase 3). One `runs` row per pipeline stage
that talks to a model: wall time, provider/model, token usage when the provider
reports it, and success/failure. Phase 7's Stats tab reads this table; nothing
in the pipeline depends on it, so recording must never raise.
"""
from __future__ import annotations

import time
from contextlib import contextmanager

from . import ai, db


def record(dump_id: str | None, stage: str, provider: str, model: str, ms: int,
           usage: dict | None, ok: bool, error: str | None = None) -> None:
    try:
        db.execute(
            "INSERT INTO runs (id, dump_id, stage, provider, model, started_at, ms, prompt_tokens, completion_tokens, ok, error) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (db.new_id(), dump_id, stage, provider, model, db.now_iso(), int(ms),
             (usage or {}).get("prompt_tokens"), (usage or {}).get("completion_tokens"),
             1 if ok else 0, (error or None) and str(error)[:300]))
    except Exception as e:  # instrumentation is best-effort
        print(f"[instrument] could not record run: {e}", flush=True)


@contextmanager
def timed(dump_id: str | None, stage: str):
    """Wrap one model call. Re-raises the call's exception after recording it."""
    cfg = ai.config()
    ai.reset_usage()
    t0 = time.perf_counter()
    try:
        yield
    except Exception as e:
        record(dump_id, stage, cfg["provider"], cfg["model"], (time.perf_counter() - t0) * 1000,
               ai.last_usage(), ok=False, error=f"{type(e).__name__}: {e}")
        raise
    else:
        record(dump_id, stage, cfg["provider"], cfg["model"], (time.perf_counter() - t0) * 1000,
               ai.last_usage(), ok=True)


def recent(limit: int = 200) -> list[dict]:
    return [dict(r) for r in db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (int(limit),))]
