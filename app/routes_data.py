"""Data portability endpoints: lossless JSON export/import and the Markdown zip. Mounted under /api from main.py."""
from __future__ import annotations

import json
from datetime import date

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from . import dataio, export_md

router = APIRouter()


@router.get("/data/export.json")
def export_json(include_private: int = 1, include_deleted: int = 1):
    data = dataio.export_data(bool(include_private), bool(include_deleted))
    body = json.dumps(data, ensure_ascii=False, indent=1)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="braindump-export-{date.today().isoformat()}.json"'})


@router.get("/data/export.md")
def export_markdown(wikilinks: int = 1):
    return Response(export_md.vault_markdown_zip(bool(wikilinks)), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="braindump-markdown.zip"'})


@router.post("/data/import")
async def import_json(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "That file isn't a BrainDump Lite JSON export")
    try:
        return dataio.import_data(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
