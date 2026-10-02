"""0.21 endpoints: backups, embedding rebuild, download cancel, task snooze, habits, the weekly digest and
duplicate hints. Kept apart from routes.py (already very long); mounted under /api from main.py."""
from __future__ import annotations

import json
import re
import uuid
from collections import Counter
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import backup, db, dupes, embeddings, engine, graph

router = APIRouter()
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ── Backups ──────────────────────────────────────────────────────────────────

class BackupCfg(BaseModel):
    enabled: bool | None = None
    dir: str | None = None
    keep: int | None = None
    include_private: bool | None = None


class BackupRestoreIn(BaseModel):
    name: str


@router.get("/autobackup")
def backup_status():
    return backup.status()


@router.put("/autobackup")
def backup_configure(body: BackupCfg):
    try:
        backup.set_config(body.enabled, body.dir, body.keep, body.include_private)
    except (ValueError, OSError) as e:
        raise HTTPException(400, f"Couldn't use that folder: {e}")
    return backup.status()


@router.post("/autobackup/run")
def backup_run():
    try:
        made = backup.run_backup()
    except Exception as e:
        raise HTTPException(500, f"Backup failed: {e}")
    return {**made, **backup.status()}


@router.post("/autobackup/restore")
def backup_restore(body: BackupRestoreIn):
    try:
        return backup.restore_backup(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Restore failed: {e}")


# ── Search index ─────────────────────────────────────────────────────────────

@router.get("/embeddings/status")
def embeddings_status():
    return embeddings.status()


@router.post("/embeddings/rebuild")
def embeddings_rebuild():
    ok, msg = embeddings.start()
    if not ok:
        raise HTTPException(400, msg)
    return {"message": msg, **embeddings.status()}


# ── Model download: cancel ───────────────────────────────────────────────────

@router.post("/engine/cancel")
def engine_cancel():
    return {"cancelled": engine.cancel_setup()}


# ── Duplicate hints ──────────────────────────────────────────────────────────

@router.get("/merge/hints")
def merge_hints():
    """How many likely duplicates each list has (the quick check) - drives the little badge in Search -> Browse."""
    return {"person": len(graph.duplicate_groups("person")), "concept": len(graph.duplicate_groups("concept"))}


@router.post("/merge/dismiss/reset")
def merge_dismiss_reset():
    n = len(dupes._dismissed())
    db.set_setting(dupes.DISMISS_KEY, [])
    return {"cleared": n}


# ── Task snooze / reschedule ─────────────────────────────────────────────────

class SnoozeIn(BaseModel):
    until: str    # YYYY-MM-DD, today or later


def _future_day(s: str) -> str:
    s = (s or "").strip()
    if not _DAY.match(s):
        raise HTTPException(400, "until must be YYYY-MM-DD")
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "That isn't a real date")
    if d < date.today():
        raise HTTPException(400, "Pick today or a later date")
    return s


def _moved_due(due: str | None, until: str) -> str | None:
    """A due date earlier than the snooze date moves to it (an overdue task is thereby rescheduled);
    a later one stays. Any time-of-day is kept."""
    if not due:
        return due
    day, _, tm = due.partition("T")
    return due if day >= until else until + ("T" + tm if tm else "")


@router.post("/items/{item_id}/snooze")
def snooze_item(item_id: str, body: SnoozeIn):
    """'Not today': hide a task until a date and, when it is due earlier (e.g. overdue), push its due date there too."""
    until = _future_day(body.until)
    row = db.query_one("SELECT id, due_date FROM items WHERE id=?", (item_id,))
    if not row:
        raise HTTPException(404, "Item not found")
    db.execute("UPDATE items SET snoozed_until=?, due_date=? WHERE id=?", (until, _moved_due(row["due_date"], until), item_id))
    return dict(db.query_one("SELECT id, due_date, snoozed_until FROM items WHERE id=?", (item_id,)))


@router.post("/items/{item_id}/unsnooze")
def unsnooze_item(item_id: str):
    if not db.query_one("SELECT id FROM items WHERE id=?", (item_id,)):
        raise HTTPException(404, "Item not found")
    db.execute("UPDATE items SET snoozed_until=NULL WHERE id=?", (item_id,))
    return {"id": item_id}


@router.post("/tasks/reschedule-overdue")
def reschedule_overdue(body: SnoozeIn):
    """Move every overdue, unfinished task to one new date in a single click."""
    until = _future_day(body.until)
    today = date.today().isoformat()
    rows = db.query("SELECT id, due_date FROM items WHERE kind='task' AND done=0 AND status!='rejected' "
                    "AND due_date IS NOT NULL AND substr(due_date,1,10) < ?", (today,))
    for r in rows:
        db.execute("UPDATE items SET due_date=?, snoozed_until=? WHERE id=?", (_moved_due(r["due_date"], until), until, r["id"]))
    return {"moved": len(rows), "until": until}


# ── Habits ───────────────────────────────────────────────────────────────────

class HabitIn(BaseModel):
    title: str
    notes: str | None = None
    frequency: str = "daily"      # daily | weekly
    target: int = 1               # weekly: check-ins per week


class HabitPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    frequency: str | None = None
    target: int | None = None


class CheckIn(BaseModel):
    day: str | None = None        # default today
    done: bool = True


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def habit_stats(h, days: set[str], today: date) -> dict:
    """Current/best streak and the last 14 days for one habit. Daily: consecutive days (today still pending
    doesn't break it). Weekly: consecutive Monday-weeks that reached `target` (the running week doesn't break it)."""
    freq, target = h["frequency"], max(1, h["target"])
    ds = sorted(date.fromisoformat(x) for x in days)
    best = cur = 0
    if freq == "daily":
        run, prev = 0, None
        for d in ds:
            run = run + 1 if prev and (d - prev).days == 1 else 1
            best, prev = max(best, run), d
        probe = today if today.isoformat() in days else today - timedelta(days=1)
        while probe.isoformat() in days:
            cur += 1
            probe -= timedelta(days=1)
    else:
        weeks = Counter(_monday(d) for d in ds)
        good = sorted(w for w, n in weeks.items() if n >= target)
        run, prev = 0, None
        for w in good:
            run = run + 1 if prev and (w - prev).days == 7 else 1
            best, prev = max(best, run), w
        probe = _monday(today)
        if weeks.get(probe, 0) < target:
            probe -= timedelta(days=7)
        while weeks.get(probe, 0) >= target:
            cur += 1
            probe -= timedelta(days=7)
    wk = _monday(today)
    week_n = sum(1 for d in ds if d >= wk)
    return {
        "id": h["id"], "title": h["title"], "notes": h["notes"], "frequency": freq, "target": target,
        "streak": cur, "best": max(best, cur), "done_today": today.isoformat() in days, "week_count": week_n,
        "days": [{"day": (today - timedelta(days=i)).isoformat(), "done": (today - timedelta(days=i)).isoformat() in days}
                 for i in range(13, -1, -1)],
        "total": len(days),
    }


def _habits_view() -> list[dict]:
    today = date.today()
    logs: dict[str, set] = {}
    for r in db.query("SELECT habit_id, day FROM habit_log"):
        logs.setdefault(r["habit_id"], set()).add(r["day"])
    rows = db.query("SELECT * FROM habits WHERE archived=0 ORDER BY created_at")
    return [habit_stats(h, logs.get(h["id"], set()), today) for h in rows]


def _habit_row(hid: str):
    row = db.query_one("SELECT * FROM habits WHERE id=? AND archived=0", (hid,))
    if not row:
        raise HTTPException(404, "Habit not found")
    return row


def _clean_habit(freq: str, target: int) -> tuple[str, int]:
    if freq not in ("daily", "weekly"):
        raise HTTPException(400, "frequency must be daily or weekly")
    return freq, (1 if freq == "daily" else max(1, min(7, int(target or 1))))


@router.get("/habits")
def list_habits():
    return _habits_view()


@router.post("/habits")
def create_habit(body: HabitIn):
    title = body.title.strip()[:120]
    if not title:
        raise HTTPException(400, "A habit needs a name")
    freq, target = _clean_habit(body.frequency, body.target)
    hid = uuid.uuid4().hex
    db.execute("INSERT INTO habits (id, title, notes, frequency, target, created_at) VALUES (?,?,?,?,?,?)",
               (hid, title, (body.notes or "").strip()[:300] or None, freq, target, db.now_iso()))
    return next(h for h in _habits_view() if h["id"] == hid)


@router.patch("/habits/{hid}")
def patch_habit(hid: str, body: HabitPatch):
    row = _habit_row(hid)
    title = (body.title if body.title is not None else row["title"]).strip()[:120]
    if not title:
        raise HTTPException(400, "A habit needs a name")
    freq, target = _clean_habit(body.frequency or row["frequency"], body.target if body.target is not None else row["target"])
    notes = row["notes"] if body.notes is None else ((body.notes or "").strip()[:300] or None)
    db.execute("UPDATE habits SET title=?, notes=?, frequency=?, target=? WHERE id=?", (title, notes, freq, target, hid))
    return next(h for h in _habits_view() if h["id"] == hid)


@router.delete("/habits/{hid}")
def delete_habit(hid: str):
    _habit_row(hid)
    db.execute("UPDATE habits SET archived=1 WHERE id=?", (hid,))   # soft: the log is kept
    return {"id": hid}


@router.post("/habits/{hid}/check")
def check_habit(hid: str, body: CheckIn):
    _habit_row(hid)
    day = (body.day or date.today().isoformat()).strip()
    if not _DAY.match(day):
        raise HTTPException(400, "day must be YYYY-MM-DD")
    if date.fromisoformat(day) > date.today():
        raise HTTPException(400, "You can't check in on a future day")
    if body.done:
        db.execute("INSERT OR IGNORE INTO habit_log (habit_id, day) VALUES (?,?)", (hid, day))
    else:
        db.execute("DELETE FROM habit_log WHERE habit_id=? AND day=?", (hid, day))
    return next(h for h in _habits_view() if h["id"] == hid)


# ── Weekly digest ────────────────────────────────────────────────────────────

_TONE_V = {"excited": 2, "hopeful": 1, "calm": 1, "neutral": 0, "reflective": 0, "anxious": -1, "frustrated": -1,
           "overwhelmed": -1, "low": -2}


def _local_day(iso: str) -> date | None:
    try:
        return datetime.fromisoformat(iso).astimezone().date()
    except (ValueError, TypeError):
        return None


@router.get("/digest/weekly")
def weekly_digest(weeks_back: int = 0):
    """A no-AI summary of one Monday-Sunday week: volume, themes, mood, tasks, habits."""
    weeks_back = max(0, min(520, weeks_back))
    today = date.today()
    start = _monday(today) - timedelta(days=7 * weeks_back)
    end = start + timedelta(days=6)
    prev_start = start - timedelta(days=7)
    cmap = graph.canonical_map("concepts")
    dumps = []
    seen_before: set[str] = set()
    for r in db.query("SELECT id, title, created_at, tone, people, concepts, raw_text FROM dumps WHERE status='ready' ORDER BY created_at"):
        d = _local_day(r["created_at"])
        if d is None:
            continue
        rec = {"id": r["id"], "title": r["title"] or "Untitled", "day": d, "tone": r["tone"], "words": len((r["raw_text"] or "").split()),
               "people": {n.lower(): n for n in graph._names(r["people"])},
               "concepts": {graph._group_key(n, cmap): cmap.get(graph._group_key(n, cmap), n) for n in graph._names(r["concepts"])}}
        if d < start:
            seen_before.update(rec["concepts"])
        dumps.append(rec)
    mine = [x for x in dumps if start <= x["day"] <= end]
    prev = [x for x in dumps if prev_start <= x["day"] < start]

    def top(kind: str, rows: list, n: int = 5):
        c, disp = Counter(), {}
        for x in rows:
            for k, name in x[kind].items():
                c[k] += 1
                disp[k] = name
        return [{"name": disp[k], "count": v, "new": kind == "concepts" and k not in seen_before}
                for k, v in sorted(c.items(), key=lambda kv: (-kv[1], disp[kv[0]].lower()))[:n]]

    def mood(rows):
        vals = []
        for x in rows:
            try:
                t = json.loads(x["tone"]) if x["tone"] else None
            except (ValueError, TypeError):
                t = None
            if t and t.get("label") in _TONE_V:
                vals.append((x["day"], t["label"], _TONE_V[t["label"]]))
        return vals

    m, pm = mood(mine), mood(prev)
    avg = round(sum(v for *_, v in m) / len(m), 2) if m else None
    pavg = round(sum(v for *_, v in pm) / len(pm), 2) if pm else None
    days = []
    for i in range(7):
        d = start + timedelta(days=i)
        dv = [v for dd, _, v in m if dd == d]
        days.append({"day": d.isoformat(), "dumps": sum(1 for x in mine if x["day"] == d),
                     "mood": round(sum(dv) / len(dv), 2) if dv else None, "future": d > today})
    label_counts = Counter(lbl for _, lbl, _ in m)
    t_open = db.query_one("SELECT COUNT(*) n FROM items WHERE kind='task' AND done=0 AND status!='rejected'")["n"]
    t_over = db.query_one("SELECT COUNT(*) n FROM items WHERE kind='task' AND done=0 AND status!='rejected' AND due_date IS NOT NULL "
                          "AND substr(due_date,1,10) < ?", (today.isoformat(),))["n"]
    t_added = sum(1 for r in db.query("SELECT created_at FROM items WHERE kind='task' AND status!='rejected'")
                  if (d := _local_day(r["created_at"])) and start <= d <= end)
    t_due = db.query_one("SELECT COUNT(*) n FROM items WHERE kind='task' AND done=0 AND status!='rejected' AND substr(due_date,1,10) BETWEEN ? AND ?",
                         (today.isoformat(), (today + timedelta(days=7)).isoformat()))["n"]
    habits = _habits_view()
    return {
        "start": start.isoformat(), "end": end.isoformat(), "weeks_back": weeks_back, "current": weeks_back == 0,
        "dumps": len(mine), "dumps_prev": len(prev), "words": sum(x["words"] for x in mine),
        "days": days, "active_days": sum(1 for d in days if d["dumps"]),
        "concepts": top("concepts", mine), "people": top("people", mine),
        "mood": {"avg": avg, "prev_avg": pavg, "labels": label_counts.most_common(3)},
        "tasks": {"open": t_open, "overdue": t_over, "added": t_added, "due_next_7_days": t_due},
        "habits": [{"title": h["title"], "streak": h["streak"], "week_count": h["week_count"], "target": h["target"],
                    "frequency": h["frequency"]} for h in habits[:8]],
        "busiest": (max(mine, key=lambda x: x["words"]) and {"id": max(mine, key=lambda x: x["words"])["id"],
                                                              "title": max(mine, key=lambda x: x["words"])["title"]}) if mine else None,
    }
