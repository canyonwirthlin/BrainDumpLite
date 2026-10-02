"""Private dumps: marked private, they never reach Ask, search, exports, duplicate hints, the digest, the
graph, AI prompts or the Obsidian mirror. They are readable only in History / the dump card, and only
while the app is unlocked (the whole API is gated by the PIN in app/lock.py), so a PIN must exist
before anything can be made private.

The single predicate is `db.PRIVATE_SQL` (`COALESCE(is_private,0)=0`); `db.PRIVATE_ITEM_SQL` is the items
form. Exclusion points (grep `PRIVATE_SQL` / `PRIVATE_ITEM_SQL`):
  ask.VISIBLE_SQL, search (keyword, items, semantic, vocab), routes_search.search_tasks, export_md
  (all_ready_ids + dump_markdown), dataio.export_data (include_private=False from the UI), dupes,
  routes_dumps.duplicate_hints, embeddings, obsidian.select_ids, digest, graph (names, briefs, nodes,
  browse, items), prompts, planner, pipeline._known_people, followup.get, routes /tasks, routes get_dump
  related links, routes_extra stats. Backups are a separate decision (backup.py include_private).
"""
from __future__ import annotations

from fastapi import HTTPException

from . import db, lock


def pin_set() -> bool:
    return lock.is_set()


def require_pin() -> None:
    """Private needs a PIN to sit behind; without one, ask the user to set it first."""
    if not lock.is_set():
        raise HTTPException(409, "pin_required: set a PIN in Settings -> Security before making a dump private")


def visible() -> bool:
    """True while private dumps may be shown in the app (no PIN to protect them, or the app is unlocked)."""
    return not lock.locked()


def set_private(dump_id: str, value: bool) -> bool:
    row = db.query_one("SELECT id FROM dumps WHERE id=? AND deleted_at IS NULL", (dump_id,))
    if not row:
        raise HTTPException(404, "Dump not found")
    if value:
        require_pin()
    db.execute("UPDATE dumps SET is_private=? WHERE id=?", (1 if value else 0, dump_id))
    try:  # a mirrored file leaves the vault folder (-> _trash); a dump made public again is written back
        from . import obsidian
        obsidian.sync()
    except Exception:
        pass
    return value
