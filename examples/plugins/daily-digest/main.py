"""Example plugin: build a digest of today's dumps.

Copy this folder to <data>/plugins/ (or use Settings → Plugins → Install from
folder), enable it, then press "Build today's digest" on its card in Settings →
Plugins & MCP.
"""
from datetime import date

API = None


def register(api):
    """Called once when the plugin loads. `api` is the only surface you get."""
    global API
    API = api
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
