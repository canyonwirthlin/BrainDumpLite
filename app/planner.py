"""Daily plan (Phase 8): real calendar events + the task backlog → free gaps →
one model call proposes what to put where. Greedy fallback without AI."""
from __future__ import annotations

from datetime import datetime, timedelta

from . import ai, db, google_cal

DAY_START, DAY_END, MIN_GAP = 9 * 60, 18 * 60, 30   # minutes from midnight

_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"slots": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "properties": {"start": {"type": "string"}, "end": {"type": "string"}, "task_id": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["start", "end", "task_id"]}}},
    "required": ["slots"],
}
_SYSTEM = """You plan one workday. You get free time gaps (HH:MM-HH:MM) and a task backlog with
estimated minutes and urgency (3 = today). Fill the gaps with tasks that fit, most urgent
first, never exceeding a gap, at most one task per slot, leaving breathing room. Return ONLY
JSON: {"slots": [{"start": "HH:MM", "end": "HH:MM", "task_id": "...", "reason": "≤ 12 words"}]}.
Use only task_ids from the list. Empty slots list if nothing fits."""


def _mins(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def backlog(limit: int = 15) -> list[dict]:
    rows = db.query("SELECT id, content, est_minutes, urgency, due_date FROM items WHERE kind IN ('task','goal') "
                    "AND status='approved' AND done=0 ORDER BY COALESCE(urgency,0) DESC, COALESCE(est_minutes, 60) ASC, created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


def gaps(day: str, events: list[dict]) -> list[dict]:
    busy = []
    for e in events:
        if e.get("all_day"):
            continue
        try:
            s = datetime.fromisoformat(e["start"]).astimezone(); en = datetime.fromisoformat(e["end"]).astimezone()
        except (ValueError, TypeError, KeyError):
            continue
        if s.date().isoformat() != day:
            continue
        busy.append((s.hour * 60 + s.minute, en.hour * 60 + en.minute))
    busy.sort()
    out, cur = [], DAY_START
    for s, e in busy:
        if s - cur >= MIN_GAP:
            out.append({"start": _hhmm(cur), "end": _hhmm(min(s, DAY_END))})
        cur = max(cur, e)
    if DAY_END - cur >= MIN_GAP:
        out.append({"start": _hhmm(cur), "end": _hhmm(DAY_END)})
    return out


def _greedy(free: list[dict], tasks: list[dict]) -> list[dict]:
    slots, used = [], set()
    for g in free:
        cur, end = _mins(g["start"]), _mins(g["end"])
        for t in tasks:
            est = t.get("est_minutes") or 30
            if t["id"] in used or cur + est > end:
                continue
            slots.append({"start": _hhmm(cur), "end": _hhmm(cur + est), "task_id": t["id"], "reason": "fits the gap"})
            used.add(t["id"]); cur += est + 10
    return slots


def plan(day: str | None = None) -> dict:
    day = day or datetime.now().date().isoformat()
    events = []
    if google_cal.connected():
        try:
            events = google_cal.events(day)
        except Exception as e:
            events = [{"title": f"(calendar unavailable: {e})", "start": None, "end": None, "all_day": True}]
    free = gaps(day, events)
    tasks = backlog()
    slots, via = [], "none"
    if free and tasks:
        if ai.available():
            try:
                lines = [f"- {t['id']}: {t['content'][:80]} (~{t.get('est_minutes') or '?'} min, urgency {t.get('urgency') or 0})" for t in tasks]
                data = ai.chat_json(_SYSTEM, f"Day: {day}\nFree gaps: " + ", ".join(f"{g['start']}-{g['end']}" for g in free) +
                                    "\nBacklog:\n" + "\n".join(lines), max_tokens=600, schema=_SCHEMA)
                ids = {t["id"] for t in tasks}
                slots = [s for s in data.get("slots", []) if s.get("task_id") in ids]
                via = "ai"
            except ai.AIError:
                slots = []
        if not slots:
            slots, via = _greedy(free, tasks), "greedy"
    by_id = {t["id"]: t for t in tasks}
    for s in slots:
        s["task"] = by_id.get(s["task_id"], {}).get("content")
    return {"day": day, "events": events, "gaps": free, "backlog": tasks, "slots": slots, "via": via,
            "calendar": google_cal.connected()}
