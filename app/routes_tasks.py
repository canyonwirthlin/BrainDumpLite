"""0.22 task endpoints: folders (separate lists) and recurring tasks.

Recurrence is a JSON column on items: {"every": N, "unit": "day|week|month", "from": "due|done"}.
When a recurring task is completed, `spawn_next` (called from PATCH /items/{id}) creates the next
occurrence as a fresh open task and clears the recurrence on the finished one, so reopening and
re-completing it can never spawn a second copy."""
from __future__ import annotations

import calendar
import json
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db

router = APIRouter()
UNITS = ("day", "week", "month")


# ── Date math ────────────────────────────────────────────────────────────────

def add_months(d: date, n: int) -> date:
    """d + n months, clamping to the end of the target month (Jan 31 + 1 month = Feb 28/29)."""
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def add_interval(d: date, every: int, unit: str) -> date:
    if unit == "day":
        return d + timedelta(days=every)
    if unit == "week":
        return d + timedelta(weeks=every)
    if unit == "month":
        return add_months(d, every)
    raise ValueError(unit)


def clean_recurrence(rec) -> dict | None:
    """Validate/normalise a recurrence dict; None clears it. Raises ValueError on bad input."""
    if rec is None:
        return None
    if not isinstance(rec, dict):
        raise ValueError("recurrence must be an object")
    try:
        every = int(rec.get("every"))
    except (TypeError, ValueError):
        raise ValueError("every must be a whole number")
    if not 1 <= every <= 365:
        raise ValueError("every must be between 1 and 365")
    unit = rec.get("unit")
    if unit not in UNITS:
        raise ValueError("unit must be day, week or month")
    frm = rec.get("from", "due")
    if frm not in ("due", "done"):
        raise ValueError("from must be due or done")
    return {"every": every, "unit": unit, "from": frm}


def next_due(rec: dict, due: str | None, today: date | None = None) -> str:
    """The next due date (keeping any time-of-day). 'due' repeats on the original schedule, skipping
    dates that are already past so a long-neglected task doesn't respawn overdue; 'done' counts the
    interval from today (the completion date)."""
    today = today or date.today()
    day, _, tm = (due or "").partition("T")
    every, unit = rec["every"], rec["unit"]
    if rec.get("from") == "done" or not day:
        nxt = add_interval(today, every, unit)
    else:
        base = date.fromisoformat(day)
        nxt = add_interval(base, every, unit)
        k = 1
        while nxt <= today:   # derive from the anchor each time so month-end clamping doesn't drift
            k += 1
            nxt = add_interval(base, every * k, unit)
    return nxt.isoformat() + ("T" + tm if tm else "")


def spawn_next(item_id: str, today: date | None = None) -> str | None:
    """Call after an item is marked done. Returns the new item's id, or None if it doesn't recur."""
    it = db.query_one("SELECT * FROM items WHERE id=?", (item_id,))
    if not it or it["kind"] != "task" or not it["done"] or not it["recurrence"]:
        return None
    try:
        rec = clean_recurrence(json.loads(it["recurrence"]))
    except (ValueError, TypeError):
        return None
    if not rec:
        return None
    nid = db.new_id()
    db.execute("INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at, "
               "est_minutes, folder_id, recurrence, tags, pinned) VALUES (?,?,?,?,?,?,?, 'approved', 0, ?,?,?,?,?,?)",
               (nid, it["dump_id"], "task", it["content"], it["detail"], it["priority"], next_due(rec, it["due_date"], today),
                db.now_iso(), it["est_minutes"], it["folder_id"], json.dumps(rec), it["tags"], it["pinned"]))
    db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)",
               (nid, it["dump_id"], f"{it['content']} {it['detail'] or ''}"))
    db.execute("UPDATE items SET recurrence=NULL WHERE id=?", (item_id,))
    return nid


class RecurrenceIn(BaseModel):
    recurrence: dict | None = None


@router.put("/items/{item_id}/recurrence")
def set_recurrence(item_id: str, body: RecurrenceIn):
    it = db.query_one("SELECT id, kind FROM items WHERE id=?", (item_id,))
    if not it:
        raise HTTPException(404, "Item not found")
    if it["kind"] != "task":
        raise HTTPException(400, "Only tasks can repeat")
    try:
        rec = clean_recurrence(body.recurrence)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.execute("UPDATE items SET recurrence=? WHERE id=?", (json.dumps(rec) if rec else None, item_id))
    return dict(db.query_one("SELECT * FROM items WHERE id=?", (item_id,)))


# ── Folders ──────────────────────────────────────────────────────────────────

class FolderIn(BaseModel):
    name: str


class MoveIn(BaseModel):
    folder_id: str | None = None


def _name(s: str) -> str:
    s = (s or "").strip()[:60]
    if not s:
        raise HTTPException(400, "A folder needs a name")
    return s


@router.get("/task-folders")
def list_folders():
    return [dict(r) for r in db.query(
        "SELECT f.*, (SELECT COUNT(*) FROM items i WHERE i.folder_id = f.id AND i.done = 0 AND i.kind = 'task' "
        "AND i.status != 'rejected' AND i.dump_id NOT IN (SELECT id FROM dumps WHERE deleted_at IS NOT NULL)) AS open_count FROM task_folders f ORDER BY f.sort, f.created_at")]


@router.post("/task-folders")
def create_folder(body: FolderIn):
    fid = db.new_id()
    nxt = db.query_one("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM task_folders")["n"]
    db.execute("INSERT INTO task_folders (id, name, sort, created_at) VALUES (?,?,?,?)", (fid, _name(body.name), nxt, db.now_iso()))
    return dict(db.query_one("SELECT * FROM task_folders WHERE id=?", (fid,)))


@router.patch("/task-folders/{fid}")
def rename_folder(fid: str, body: FolderIn):
    if not db.query_one("SELECT id FROM task_folders WHERE id=?", (fid,)):
        raise HTTPException(404, "Folder not found")
    db.execute("UPDATE task_folders SET name=? WHERE id=?", (_name(body.name), fid))
    return dict(db.query_one("SELECT * FROM task_folders WHERE id=?", (fid,)))


@router.delete("/task-folders/{fid}")
def delete_folder(fid: str):
    """Tasks in the folder are kept - they just fall back to 'no folder'."""
    if not db.query_one("SELECT id FROM task_folders WHERE id=?", (fid,)):
        raise HTTPException(404, "Folder not found")
    db.execute("UPDATE items SET folder_id=NULL WHERE folder_id=?", (fid,))
    db.execute("DELETE FROM task_folders WHERE id=?", (fid,))
    return {"ok": True}


@router.put("/items/{item_id}/folder")
def move_to_folder(item_id: str, body: MoveIn):
    if not db.query_one("SELECT id FROM items WHERE id=?", (item_id,)):
        raise HTTPException(404, "Item not found")
    if body.folder_id and not db.query_one("SELECT id FROM task_folders WHERE id=?", (body.folder_id,)):
        raise HTTPException(404, "Folder not found")
    db.execute("UPDATE items SET folder_id=? WHERE id=?", (body.folder_id or None, item_id))
    return {"id": item_id, "folder_id": body.folder_id or None}
