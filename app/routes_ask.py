"""POST /api/ask: chat over your dumps with citations (see ask.py)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from . import ask

router = APIRouter()


class Turn(BaseModel):
    role: str
    content: str


class AskBody(BaseModel):
    question: str
    history: list[Turn] = []


@router.post("/ask")
def ask_endpoint(body: AskBody):
    return ask.ask(body.question, [t.model_dump() for t in body.history])
