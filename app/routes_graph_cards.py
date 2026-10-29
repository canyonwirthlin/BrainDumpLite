"""GET /api/graph/card/{node_id}: the hover-card summary for one Brain map node (see graph_cards.py)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import graph_cards

router = APIRouter()


@router.get("/graph/card/{node_id:path}")
def graph_card(node_id: str):
    try:
        return graph_cards.card(node_id)
    except graph_cards.NotFound:
        raise HTTPException(404, "That node isn't on the map any more.")
