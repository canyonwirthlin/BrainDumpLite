"""Example plugin: a once-a-day digest proposal.

Copy this folder to <data>/plugins/ (or use Settings → Plugins → Install from
folder), enable it, and the next dump you process will put a digest suggestion
in your Inbox — at most one per day.
"""
from datetime import date

API = None


def register(api):
    """Called once when the plugin loads. `api` is the only surface you get."""
    global API
    API = api
    api.on_dump(maybe_propose)
    api.action("digest_now", "Build today's digest", lambda args: {"digest": build(args.get("day"))})
    api.log("daily-digest ready")


def build(day=None):
    day = day or date.today().isoformat()
    rows = API.db_query(
        "SELECT title, summary FROM dumps WHERE substr(COALESCE(captured_local, created_at), 1, 10) = ? ORDER BY created_at",
        (day,))
    if not rows:
        return f"Nothing captured on {day}."
    lines = [f"- **{r['title'] or 'Untitled'}** — {(r['summary'] or '').strip()[:160]}" for r in rows]
    return f"### {day}\n\n" + "\n".join(lines)


def maybe_propose(dump):
    today = date.today().isoformat()
    if API.setting("last_day") == today:
        return
    text = build(today)
    if text.startswith("Nothing"):
        return
    API.set_setting("last_day", today)
    API.propose("plugin_action", f"Build today's digest ({today})",
                {"action": "digest_now", "args": {"day": today}}, dump_id=dump.get("id"))
