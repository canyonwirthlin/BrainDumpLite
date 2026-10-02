"""Focus helpers for the Tasks tab: "I have N minutes" fit filter, home/PC/errand tags, a start/stop timer and
the time-blindness correction (how long things really take compared with your own guesses).

Timers live in the settings table (key `focus_timers`: {item_id: start ISO}) so they survive a reload.
The correction factor is a geometric mean of actual/estimate over finished tasks that have both numbers."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db

router = APIRouter()
TAGS = ("home", "pc", "errand")
MIN_SAMPLES = 3          # below this we don't trust the factor enough to adjust anything
RECENT = 50              # only the most recent finished tasks count: you improve over time
RATIO_LO, RATIO_HI = 0.2, 6.0   # one wild outlier (forgot the timer) can't swing the factor much


def correction_factor(pairs: list[tuple[int, int]]) -> dict:
    """pairs = [(estimate_min, actual_min), ...] oldest first. Returns {factor, samples, applied}.
    `factor` is the geometric mean of actual/estimate (each ratio clamped), `applied` only once there
    are MIN_SAMPLES usable pairs; otherwise factor is 1.0."""
    ratios = [min(RATIO_HI, max(RATIO_LO, a / e)) for e, a in pairs if e and e > 0 and a and a > 0][-RECENT:]
    if len(ratios) < MIN_SAMPLES:
        return {"factor": 1.0, "samples": len(ratios), "applied": False}
    f = math.exp(sum(math.log(r) for r in ratios) / len(ratios))
    return {"factor": round(f, 2), "samples": len(ratios), "applied": True}


def adjusted(est: int | None, factor: dict) -> int | None:
    """What an estimate probably means for you. Unchanged until the factor is trusted."""
    if not est:
        return None
    return max(1, round(est * factor["factor"])) if factor["applied"] else est


def _factor() -> dict:
    rows = db.query("SELECT est_minutes, actual_minutes FROM items WHERE done=1 AND est_minutes>0 AND actual_minutes>0 "
                    "ORDER BY created_at")
    return correction_factor([(r["est_minutes"], r["actual_minutes"]) for r in rows])


def clean_tags(tags) -> list[str]:
    out = []
    for t in tags or []:
        t = str(t).strip().lower()
        if t not in TAGS:
            raise HTTPException(400, f"tags must be from: {', '.join(TAGS)}")
        if t not in out:
            out.append(t)
    return out


def item_tags(row) -> list[str]:
    try:
        v = json.loads(row["tags"]) if row["tags"] else []
    except (ValueError, TypeError):
        return []
    return [t for t in v if t in TAGS] if isinstance(v, list) else []


def _task(item_id: str):
    row = db.query_one("SELECT * FROM items WHERE id=? AND kind='task'", (item_id,))
    if not row:
        raise HTTPException(404, "Task not found")
    return row


class TagsIn(BaseModel):
    tags: list[str] = []


@router.put("/items/{item_id}/tags")
def set_tags(item_id: str, body: TagsIn):
    _task(item_id)
    tags = clean_tags(body.tags)
    db.execute("UPDATE items SET tags=? WHERE id=?", (json.dumps(tags) if tags else None, item_id))
    return {"id": item_id, "tags": tags}


@router.get("/focus/factor")
def get_factor():
    return _factor()


@router.get("/focus/fit")
def fit(minutes: int, tag: str | None = None):
    """Open tasks that fit in `minutes` (using your corrected estimate), plus those with no estimate."""
    if minutes < 1 or minutes > 24 * 60:
        raise HTTPException(400, "minutes must be between 1 and 1440")
    if tag and tag not in TAGS:
        raise HTTPException(400, f"tag must be one of: {', '.join(TAGS)}")
    today = datetime.now().date().isoformat()
    rows = db.query(
        "SELECT i.*, d.title AS dump_title FROM items i JOIN dumps d ON d.id=i.dump_id "
        "WHERE i.kind='task' AND i.done=0 AND i.status != 'rejected' AND d.status IN ('ready','manual') "
        "AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?) "
        "ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date, COALESCE(i.priority,0) DESC", (today,))
    f = _factor()
    fits, unknown, long = [], [], []
    for r in rows:
        tags = item_tags(r)
        if tag and tag not in tags:
            continue
        adj = adjusted(r["est_minutes"], f)
        o = {**dict(r), "tags": tags, "adjusted_minutes": adj}
        (unknown if not r["est_minutes"] else fits if adj <= minutes else long).append(o)
    fits.sort(key=lambda o: -o["adjusted_minutes"])   # best use of the time first: biggest that fits
    return {"minutes": minutes, "tag": tag, "factor": f, "fits": fits, "unknown": unknown, "too_long": len(long)}


def _timers() -> dict:
    t = db.get_setting("focus_timers", {})
    return t if isinstance(t, dict) else {}


@router.get("/focus/timers")
def timers():
    return _timers()


@router.post("/items/{item_id}/timer/start")
def timer_start(item_id: str):
    _task(item_id)
    t = _timers()
    t.setdefault(item_id, datetime.now(timezone.utc).isoformat())
    db.set_setting("focus_timers", t)
    return {"id": item_id, "started": t[item_id]}


@router.post("/items/{item_id}/timer/cancel")
def timer_cancel(item_id: str):
    t = _timers()
    t.pop(item_id, None)
    db.set_setting("focus_timers", t)
    return {"id": item_id}


class ActualIn(BaseModel):
    minutes: int | None = None     # omit to use the running timer
    done: bool = True


@router.post("/items/{item_id}/actual")
def record_actual(item_id: str, body: ActualIn):
    """Record how long a task really took (typed, or from the running timer) and, by default, finish it.
    Returns a "you guessed X, it took Y" summary and the updated correction factor."""
    row = _task(item_id)
    t = _timers()
    started = t.pop(item_id, None)
    minutes = body.minutes
    if minutes is None:
        if not started:
            raise HTTPException(400, "Enter the minutes, or start the timer first")
        try:
            secs = (datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()
        except ValueError:
            raise HTTPException(400, "Timer is corrupt; enter the minutes instead")
        minutes = max(1, math.ceil(secs / 60))
    if minutes < 1 or minutes > 24 * 60:
        raise HTTPException(400, "minutes must be between 1 and 1440")
    db.execute("UPDATE items SET actual_minutes=? WHERE id=?", (minutes, item_id))
    db.set_setting("focus_timers", t)
    if body.done:
        db.execute("UPDATE items SET done=1, status='approved' WHERE id=?", (item_id,))
        from . import routes_tasks
        routes_tasks.spawn_next(item_id)
    est = row["est_minutes"]
    return {"id": item_id, "actual_minutes": minutes, "est_minutes": est,
            "ratio": round(minutes / est, 2) if est else None, "factor": _factor()}
