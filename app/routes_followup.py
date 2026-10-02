"""Endpoints for the AI follow-up question (see followup.py)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import ai, db, followup

router = APIRouter()


class AnswerIn(BaseModel):
    text: str
    extract: bool = False  # also pull new items out of the answer


class FollowupSettingsIn(BaseModel):
    enabled: bool


@router.get("/followup/settings")
def get_settings():
    return {"enabled": bool(db.get_setting("followup_enabled", True)), "ai_available": ai.available()}


@router.put("/followup/settings")
def put_settings(body: FollowupSettingsIn):
    db.set_setting("followup_enabled", bool(body.enabled))
    return get_settings()


@router.get("/dumps/{dump_id}/followup")
def get_followup(dump_id: str):
    return followup.get(dump_id)


@router.post("/dumps/{dump_id}/followup/answer")
def answer_followup(dump_id: str, body: AnswerIn):
    if not body.text.strip():
        raise HTTPException(400, "Write an answer first")
    r = followup.answer(dump_id, body.text[:5000], body.extract)
    if r is None:
        raise HTTPException(404, "Dump not found")
    return r


@router.post("/dumps/{dump_id}/followup/dismiss")
def dismiss_followup(dump_id: str):
    if not followup.dismiss(dump_id):
        raise HTTPException(404, "Dump not found")
    return {"ok": True}
