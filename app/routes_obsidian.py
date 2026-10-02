"""Obsidian mirror endpoints (see app/obsidian.py)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import obsidian

router = APIRouter()


class _Cfg(BaseModel):
    dir: str | None = None
    enabled: bool = True


@router.get("/obsidian")
def get_status():
    return obsidian.status()


@router.post("/obsidian/configure")
def configure(body: _Cfg):
    try:
        return obsidian.configure(body.dir, body.enabled)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@router.post("/obsidian/sync")
def sync_now():
    if not obsidian.status()["enabled"]:
        raise HTTPException(400, "the Obsidian mirror is off")
    r = obsidian.sync(full=True)
    return {**r, **obsidian.status()}
