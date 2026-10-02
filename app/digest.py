"""Weekly digest, finished: gathers one Monday-Sunday week into facts, writes an optional AI narrative (cached in the
`reflections` table under 'weekly:YYYY-Www') and renders everything as Markdown (copy / save as a dump).

The stats half is `routes_extra.weekly_digest` (no AI). Nothing here reads trashed or private dumps."""
from __future__ import annotations

from datetime import date, timedelta

from . import ai, db
from .routes_extra import _local_day, _monday, weekly_digest

# One place to switch the private-dump rule (see CLAUDE.md); `d` is the dumps alias.
PRIVATE_SQL = "AND COALESCE(d.is_private,0)=0"
MARKER = "<!-- digest -->\n"   # tells a digest narrative apart from the old /reflect weekly text sharing the key

SYSTEM = """You write a person's weekly digest from their own brain-dump data. Write in second person, warm and plain, no hype.
Use ONLY the facts given; never invent events, people or numbers. Output Markdown with exactly these sections
(skip a section only if there is truly nothing for it):
## Themes
## Wins
## Still open
## Habits
## Mood
## Suggested focus for next week
Keep the whole thing under 350 words. Bullets are fine inside sections. No preamble."""


def week_start(weeks_back: int) -> date:
    return _monday(date.today()) - timedelta(days=7 * max(0, min(520, weeks_back)))


def period_key(start: date) -> str:
    y, w, _ = start.isocalendar()
    return f"weekly:{y}-W{w:02d}"


def _task_rows(start: date, end: date) -> tuple[list[dict], list[dict]]:
    """(done, unfinished): done = completed tasks from this week's dumps (tasks carry no completion date);
    unfinished = open tasks from this week plus anything overdue."""
    rows = db.query(
        "SELECT i.content, i.done, i.due_date, i.created_at FROM items i JOIN dumps d ON d.id=i.dump_id "
        f"WHERE i.kind='task' AND i.status!='rejected' AND d.deleted_at IS NULL {PRIVATE_SQL} ORDER BY i.created_at")
    today = date.today().isoformat()
    done, open_ = [], []
    for r in rows:
        d = _local_day(r["created_at"])
        in_week = d is not None and start <= d <= end
        overdue = bool(r["due_date"]) and r["due_date"][:10] < today
        t = {"content": r["content"], "due": (r["due_date"] or "")[:10] or None, "overdue": overdue}
        if r["done"] and in_week:
            done.append(t)
        elif not r["done"] and (in_week or overdue):
            open_.append(t)
    open_.sort(key=lambda t: (not t["overdue"], t["due"] or "9999"))
    return done[:15], open_[:15]


def _week_dumps(start: date, end: date) -> list[dict]:
    out = []
    for r in db.query("SELECT d.title, d.summary, d.created_at FROM dumps d WHERE d.status='ready' AND d.deleted_at IS NULL "
                      f"{PRIVATE_SQL} ORDER BY d.created_at"):
        day = _local_day(r["created_at"])
        if day and start <= day <= end:
            out.append({"day": day.isoformat(), "title": r["title"] or "Untitled", "summary": (r["summary"] or "").replace("\n", " ")[:240]})
    return out


def gather(weeks_back: int) -> dict:
    s = weekly_digest(max(0, min(520, weeks_back)))
    start, end = date.fromisoformat(s["start"]), date.fromisoformat(s["end"])
    s["done_tasks"], s["open_tasks"] = _task_rows(start, end)
    s["dump_list"] = _week_dumps(start, end)
    s["key"] = period_key(start)
    return s


def _facts(s: dict) -> str:
    L = [f"Week {s['start']} to {s['end']}: {s['dumps']} dumps (prev week {s['dumps_prev']}), {s['words']} words, "
         f"dumped on {s['active_days']}/7 days."]
    m = s["mood"]
    L.append(f"Mood score avg {m['avg']} (prev week {m['prev_avg']}; scale -2 low to +2 high); labels: "
             + ", ".join(f"{l} x{n}" for l, n in m["labels"]))
    L.append("Themes: " + ", ".join(f"{c['name']} ({c['count']}x{', new' if c['new'] else ''})" for c in s["concepts"]))
    L.append("People: " + ", ".join(f"{c['name']} ({c['count']}x)" for c in s["people"]))
    L.append("Dumps:\n" + "\n".join(f"- {d['day']} {d['title']}: {d['summary']}" for d in s["dump_list"][:40]))
    L.append("Completed tasks: " + ("; ".join(t["content"] for t in s["done_tasks"]) or "none"))
    L.append("Open tasks: " + ("; ".join(t["content"] + (" (OVERDUE)" if t["overdue"] else "") for t in s["open_tasks"]) or "none"))
    if s["current"]:
        L.append("Habits: " + ("; ".join(f"{h['title']} ({h['frequency']}, streak {h['streak']}, {h['week_count']}/{h['target']} this week)"
                                         for h in s["habits"]) or "none"))
    return "\n".join(L)


def cached(key: str) -> dict | None:
    r = db.query_one("SELECT content, created_at FROM reflections WHERE period_key=?", (key,))
    if not r or not (r["content"] or "").startswith(MARKER):
        return None
    return {"content": r["content"][len(MARKER):], "created_at": r["created_at"]}


def generate(s: dict, force: bool = False) -> dict:
    """Returns {content, cached, created_at}. Raises ai.AIError; callers handle no-AI / empty first."""
    if not force and (c := cached(s["key"])):
        return {**c, "cached": True}
    content = ai.chat(SYSTEM, _facts(s), max_tokens=900, temperature=0.5).strip()
    if not content:
        raise ai.AIError("The model returned nothing")
    now = db.now_iso()
    db.execute("INSERT OR REPLACE INTO reflections VALUES (?,?,?)", (s["key"], MARKER + content, now))
    return {"content": content, "cached": False, "created_at": now}


def _fmt(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%b %d").replace(" 0", " ")


def to_markdown(s: dict, narrative: str | None = None) -> str:
    L = [f"# Week of {_fmt(s['start'])} – {_fmt(s['end'])}", ""]
    if narrative:
        L += [narrative.strip(), "", "---", ""]
    L += ["## At a glance", "",
          f"- {s['dumps']} dump{'s' if s['dumps'] != 1 else ''} ({s['words']:,} words), active {s['active_days']}/7 days",
          f"- Tasks: {s['tasks']['added']} added, {s['tasks']['open']} open"
          + (f", {s['tasks']['overdue']} overdue" if s["tasks"]["overdue"] else "")]
    m = s["mood"]
    if m["avg"] is not None:
        L.append(f"- Mood: {m['avg']:+} on a -2..+2 scale" + (f" ({', '.join(l for l, _ in m['labels'])})" if m["labels"] else ""))
    if s["concepts"]:
        L.append("- Themes: " + ", ".join(c["name"] for c in s["concepts"]))
    if s["people"]:
        L.append("- People: " + ", ".join(c["name"] for c in s["people"]))
    if s["done_tasks"]:
        L += ["", "## Completed", ""] + [f"- [x] {t['content']}" for t in s["done_tasks"]]
    if s["open_tasks"]:
        L += ["", "## Still open", ""] + [f"- [ ] {t['content']}" + (f" (due {t['due']})" if t["due"] else "") for t in s["open_tasks"]]
    if s["current"] and s["habits"]:
        L += ["", "## Habits", ""] + [f"- {h['title']}: " + (f"{h['week_count']}/{h['target']} this week" if h["frequency"] == "weekly"
                                                              else f"{h['streak']}-day streak") for h in s["habits"]]
    return "\n".join(L).rstrip() + "\n"
