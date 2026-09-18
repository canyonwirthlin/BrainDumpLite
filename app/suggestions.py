"""The AI Suggestions inbox (Phase 8). Every proposed action — calendar push,
Todoist push, later node types and plugin actions — is a row here until the
user accepts, edits or dismisses it. Nothing executes without an accept."""
from __future__ import annotations

import json
import traceback

from . import db

MAX_PER_DUMP = 10


def _row(r) -> dict:
    out = dict(r)
    for k in ("payload", "result"):
        try:
            out[k] = json.loads(out[k]) if out[k] else None
        except (ValueError, TypeError):
            out[k] = None
    return out


def create(kind: str, title: str, payload: dict, source: str = "pipeline", item_id: str | None = None,
           dump_id: str | None = None) -> dict:
    sid = db.new_id()
    db.execute("INSERT INTO suggestions (id, kind, title, payload, source, item_id, dump_id, status, created_at) "
               "VALUES (?,?,?,?,?,?,?,'pending',?)", (sid, kind, title[:200], json.dumps(payload), source, item_id, dump_id, db.now_iso()))
    return get(sid)


def get(sid: str) -> dict | None:
    r = db.query_one("SELECT * FROM suggestions WHERE id=?", (sid,))
    return _row(r) if r else None


def pending() -> list[dict]:
    return [_row(r) for r in db.query("SELECT * FROM suggestions WHERE status='pending' ORDER BY created_at DESC")]


def count_pending() -> int:
    return db.query_one("SELECT COUNT(*) AS n FROM suggestions WHERE status='pending'")["n"]


def recent(limit: int = 50) -> list[dict]:
    return [_row(r) for r in db.query("SELECT * FROM suggestions WHERE status != 'pending' ORDER BY resolved_at DESC LIMIT ?", (limit,))]


def _executor(kind: str):
    from . import google_cal, todoist   # lazy: avoids import cycles
    return {"calendar_push": google_cal.execute_push, "todoist_push": todoist.execute_push}.get(kind)


def accept(sid: str, edits: dict | None = None) -> dict:
    s = get(sid)
    if not s or s["status"] != "pending":
        raise ValueError("suggestion is not pending")
    payload = {**(s["payload"] or {}), **{k: v for k, v in (edits or {}).items() if k in ("title", "due", "start", "end", "description")}}
    fn = _executor(s["kind"])
    if not fn:
        raise ValueError(f"no executor for '{s['kind']}'")
    try:
        result = fn(payload)
        db.execute("UPDATE suggestions SET status='accepted', payload=?, result=?, resolved_at=? WHERE id=?",
                   (json.dumps(payload), json.dumps(result), db.now_iso(), sid))
    except Exception as e:
        traceback.print_exc()
        db.execute("UPDATE suggestions SET status='failed', payload=?, result=?, resolved_at=? WHERE id=?",
                   (json.dumps(payload), json.dumps({"error": str(e)[:300]}), db.now_iso(), sid))
    return get(sid)


def dismiss(sid: str) -> dict:
    db.execute("UPDATE suggestions SET status='dismissed', resolved_at=? WHERE id=? AND status='pending'", (db.now_iso(), sid))
    return get(sid)


def dismiss_kind(kind: str) -> int:
    n = count_pending()
    db.execute("UPDATE suggestions SET status='dismissed', resolved_at=? WHERE kind=? AND status='pending'", (db.now_iso(), kind))
    return n - count_pending()


def from_dump(dump_id: str) -> int:
    """Propose pushes for a freshly processed dump — only for connected targets."""
    from . import google_cal, todoist
    cal, todo = google_cal.connected(), todoist.connected()
    if not (cal or todo):
        return 0
    items = db.query("SELECT * FROM items WHERE dump_id=? AND status != 'rejected' AND done=0 ORDER BY created_at", (dump_id,))
    made = 0
    for it in items:
        if made >= MAX_PER_DUMP:
            break
        if cal and it["kind"] in ("task", "event") and it["due_date"]:
            create("calendar_push", f"Add to Google Calendar: {it['content'][:80]}",
                   {"title": it["content"], "due": it["due_date"], "description": it["detail"] or ""}, "pipeline", it["id"], dump_id)
            made += 1
        if todo and it["kind"] == "task":
            create("todoist_push", f"Send to Todoist: {it['content'][:80]}",
                   {"title": it["content"], "due": it["due_date"], "description": it["detail"] or ""}, "pipeline", it["id"], dump_id)
            made += 1
    return made
