"""Brain map export: write a file the user just built in the map (PNG, SVG, Obsidian canvas, WebM time-lapse)
to the place the native Save dialog pointed. The map is drawn in the browser, so the bytes come from there; this
process only writes them (the Tauri shell has no fs plugin, same approach as /export/markdown/save).
Nothing here reads the vault, so private and trashed dumps are not in play.

Because the client names an absolute path, the target is checked hard: whitelisted extension, content that really
looks like that type, no UNC/network paths, nothing inside the app's own data or code folders or any dot-directory,
no symlinks, no overwriting anything that is not a plain file, and the write is atomic (temp file + replace)."""
from __future__ import annotations

import base64
import binascii
import json
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import db

router = APIRouter()

ALLOWED_EXT = {".png", ".svg", ".canvas", ".webm"}
MAX_BYTES = 256 * 1024 * 1024
MAX_BODY = MAX_BYTES * 4 // 3 + 4096          # base64 inflates by 4/3, plus the JSON envelope
CODE_DIR = Path(__file__).resolve().parent.parent


class GraphSaveIn(BaseModel):
    path: str    # absolute path chosen in the native Save dialog
    data: str    # file content, base64


def _looks_like(ext: str, data: bytes) -> bool:
    head = data[:512].lstrip(b"\xef\xbb\xbf \t\r\n")
    if ext == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".webm":
        return data.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".svg":
        return head.startswith((b"<svg", b"<?xml", b"<!--", b"<!DOCTYPE svg")) and b"<svg" in data[:4096]
    if ext == ".canvas":
        try:
            obj = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            return False
        return isinstance(obj, dict)
    return False


def _inside(p: Path, root: Path) -> bool:
    try:
        p.relative_to(root)
        return True
    except ValueError:
        return False


def _checked_target(path: str, data: bytes) -> Path:
    raw = (path or "").strip()
    if not raw or "\x00" in raw or len(raw) > 1024:
        raise HTTPException(400, "Choose a full file path")
    p = Path(raw)
    if not p.is_absolute():
        raise HTTPException(400, "Choose a full file path")
    if raw.startswith(("\\\\", "//")):
        raise HTTPException(400, "Network paths can't be used here; save to a local folder")
    ext = p.suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "Only .png, .svg, .canvas and .webm files can be saved from the map")
    if not p.name[: -len(p.suffix)].strip(" ."):
        raise HTTPException(400, "Give the file a name")
    if not _looks_like(ext, data):
        raise HTTPException(400, f"That doesn't look like a valid {ext} file")
    if not p.parent.is_dir():
        raise HTTPException(400, "That folder doesn't exist")
    try:
        parent = p.parent.resolve()
    except OSError:
        raise HTTPException(400, "That folder can't be used")
    if any(part.startswith(".") for part in parent.parts[1:]) or p.name.startswith("."):
        raise HTTPException(400, "Hidden folders can't be used; choose a normal folder")
    for root in (db.data_dir().resolve(), CODE_DIR):
        if _inside(parent, root):
            raise HTTPException(400, "That folder belongs to the app itself; choose another one")
    target = parent / p.name
    if target.is_symlink():
        raise HTTPException(400, "That file is a shortcut; choose a normal file")
    if target.exists() and not target.is_file():
        raise HTTPException(400, "That name is already taken by a folder")
    return target


def save_bytes(path: str, data: bytes) -> str:
    """Validate the target and write `data` atomically; returns the final path."""
    target = _checked_target(path, data)
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".bdl-", suffix=".part", dir=str(target.parent))
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, target)
        tmp = None
    except OSError as e:
        raise HTTPException(400, f"Couldn't write the file: {e.strerror or 'unknown error'}")
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return str(target)


@router.post("/graph/export/save")
async def save_graph_export(request: Request):
    try:
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            raise HTTPException(413, "That file is too large to save from here")
    except ValueError:
        raise HTTPException(400, "Bad request")
    raw_body = await request.body()
    if len(raw_body) > MAX_BODY:
        raise HTTPException(413, "That file is too large to save from here")
    try:
        body = GraphSaveIn.model_validate_json(raw_body)
    except ValueError:
        raise HTTPException(400, "Bad request")
    try:
        raw = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "The file data was damaged on the way here; try again")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "That file is too large to save from here")
    return {"path": save_bytes(body.path, raw), "bytes": len(raw)}
