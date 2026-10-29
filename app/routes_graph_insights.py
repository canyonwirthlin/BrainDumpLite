"""Brain map insight endpoints (see app/graph_insights.py). Read-only over dumps; the only writes are the user's
accepted / dismissed concept links, kept in settings."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import graph_insights as gi

router = APIRouter()


class PairIn(BaseModel):
    a: str
    b: str


def _guard(fn, *args):
    try:
        return fn(*args)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/graph/insights/lonely")
def lonely():
    return gi.lonely()


@router.get("/graph/insights/loops")
def loops():
    return gi.loops()


@router.get("/graph/insights/suggested-links")
def suggested_links():
    return gi.suggested_links()


@router.get("/graph/insights/links")
def links():
    return {"links": gi.manual_links()}


@router.post("/graph/insights/links")
def accept(body: PairIn):
    return _guard(gi.accept_link, body.a, body.b)


@router.delete("/graph/insights/links")
def unlink(a: str, b: str):
    return gi.remove_link(a, b)


@router.post("/graph/insights/dismiss")
def dismiss(body: PairIn):
    return _guard(gi.dismiss_link, body.a, body.b)


@router.delete("/graph/insights/dismissed")
def reset_dismissed():
    return gi.reset_dismissed()
