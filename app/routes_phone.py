"""Settings endpoints for phone capture. Localhost-only (the main backend binds 127.0.0.1, this is belt and braces)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import phone, qr

_LOCAL = {"127.0.0.1", "::1", "localhost", "testclient"}


def _local_only(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in _LOCAL:
        raise HTTPException(403, "Local only")


router = APIRouter(prefix="/phone", dependencies=[Depends(_local_only)])


class EnableIn(BaseModel):
    enabled: bool


def _full_status() -> dict:
    st = phone.status()
    st["qr_svg"] = qr.svg(st["url"]) if st["url"] and len(st["url"]) <= 130 else None
    return st


@router.get("/status")
def get_status():
    return _full_status()


@router.put("/enable")
def set_enabled(body: EnableIn):
    if body.enabled:
        try:
            phone.start()
        except RuntimeError as e:
            raise HTTPException(500, str(e))
    else:
        phone.stop()
    return _full_status()


@router.post("/rotate")
def rotate():
    phone.rotate_token()
    return _full_status()
