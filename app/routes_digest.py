"""Weekly digest endpoints beyond the stats-only GET /digest/weekly: AI narrative (cached), Markdown, save-as-dump."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from . import ai, db, digest, pipeline

router = APIRouter()


class WeekIn(BaseModel):
    weeks_back: int = 0
    force: bool = False


def _empty(s: dict) -> bool:
    return not s["dumps"] and not s["done_tasks"]


@router.get("/digest/weekly/narrative")
def get_narrative(weeks_back: int = 0):
    """Read the cached narrative without generating anything."""
    s = digest.gather(weeks_back)
    c = digest.cached(s["key"])
    return {"key": s["key"], "ai_available": ai.available(), "empty": _empty(s),
            "content": c["content"] if c else None, "created_at": c["created_at"] if c else None, "cached": bool(c)}


@router.post("/digest/weekly/narrative")
def make_narrative(body: WeekIn):
    """Write (or re-write with force) the week's AI narrative. No AI / nothing to write about => content null, 200,
    so the UI just stays on the stats view."""
    s = digest.gather(body.weeks_back)
    base = {"key": s["key"], "ai_available": ai.available(), "empty": _empty(s)}
    if _empty(s):
        return {**base, "content": None, "cached": False}
    if not body.force and (c := digest.cached(s["key"])):
        return {**base, **c, "cached": True}
    if not base["ai_available"]:
        return {**base, "content": None, "cached": False}
    try:
        return {**base, **digest.generate(s, force=True)}
    except ai.AIError as e:
        raise HTTPException(502, f"Digest failed: {e}")


@router.get("/digest/weekly/markdown")
def weekly_markdown(weeks_back: int = 0):
    """Stats (+ the cached narrative when there is one) as Markdown, ready to copy."""
    s = digest.gather(weeks_back)
    c = digest.cached(s["key"])
    return {"markdown": digest.to_markdown(s, c["content"] if c else None), "key": s["key"], "has_narrative": bool(c)}


@router.post("/digest/weekly/save")
def save_as_dump(body: WeekIn, bg: BackgroundTasks):
    """Save the week's digest as a new dump (goes through the normal pipeline, so it is searchable)."""
    s = digest.gather(body.weeks_back)
    if _empty(s):
        raise HTTPException(400, "Nothing to save for that week")
    c = digest.cached(s["key"])
    text = digest.to_markdown(s, c["content"] if c else None)
    from . import reprocess
    queued = reprocess.should_queue()
    dump_id = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES (?,?,?,?,?)",
               (dump_id, db.now_iso(), "freeform", text, "queued" if queued else "pending"))
    if queued:
        reprocess.kick()
    else:
        bg.add_task(pipeline.run_pipeline, dump_id)
    return {"id": dump_id}
