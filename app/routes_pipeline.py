"""AI pipeline endpoints: the 'waiting for AI' queue and opt-in re-processing after a model switch."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import ai, embeddings, reprocess

router = APIRouter()


class ReprocessIn(BaseModel):
    scope: str = "raw"            # raw | other | all | ids
    ids: list[str] | None = None
    confirm: bool = False         # the UI must send true after the user agrees; never reprocess silently


@router.get("/pipeline/queue")
def queue_status():
    ids = reprocess.queued_ids()
    return {"queued": len(ids), "ids": ids, "available": ai.available()}


@router.post("/pipeline/queue/process")
def queue_process():
    if not ai.available():
        raise HTTPException(400, "No AI model is on - set one up in Settings -> AI first.")
    reprocess.kick()
    return {"queued": len(reprocess.queued_ids())}


@router.post("/pipeline/embeddings/rebuild-all")
def embeddings_rebuild_all():
    """Re-embed every dump (after switching to an embedding model with a different vector size)."""
    ok, msg = embeddings.start(everything=True)
    if not ok:
        raise HTTPException(400, msg)
    return {"message": msg, **embeddings.status()}


@router.get("/pipeline/reprocess")
def reprocess_status():
    return reprocess.status()


@router.post("/pipeline/reprocess")
def reprocess_start(body: ReprocessIn):
    if not body.confirm:
        raise HTTPException(400, "Re-processing needs confirmation")
    ok, msg = reprocess.start(body.scope, body.ids)
    if not ok:
        raise HTTPException(400, msg)
    return {"message": msg, **reprocess.status()}


@router.post("/pipeline/reprocess/cancel")
def reprocess_cancel():
    return {"cancelled": reprocess.cancel()}
