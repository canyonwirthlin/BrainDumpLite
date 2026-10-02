"""Private-dump endpoints (see app/private.py)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from . import db, private

router = APIRouter()


class PrivateIn(BaseModel):
    private: bool = True


@router.get("/private/status")
def private_status():
    n = db.query_one("SELECT COUNT(*) AS n FROM dumps WHERE deleted_at IS NULL AND COALESCE(is_private,0)=1")["n"]
    return {"pin_set": private.pin_set(), "count": n}


@router.post("/dumps/{dump_id}/private")
def set_dump_private(dump_id: str, body: PrivateIn):
    return {"id": dump_id, "is_private": private.set_private(dump_id, body.private)}
