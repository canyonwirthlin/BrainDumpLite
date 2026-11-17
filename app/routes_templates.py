"""Dump templates (Capture screen): the user's own templates plus their changes to the built-in ones.

The four built-ins live in code (static/js/templates.js) so an app update can add new ones. Everything a
user changes is ONE free-form settings key, `dump_templates`:

    {"templates": [{"id", "label", "text"}],     # the user's own templates
     "overrides": {"<built-in id>": {"label", "text"}},   # edited built-ins
     "deleted":   ["<built-in id>"],             # built-ins the user removed
     "order":     ["<id>", ...],                 # manager order (ids not listed follow, built-ins first)
     "pinned":    ["<id>", ...] | null}          # shown as buttons on Capture; null = the built-ins

The settings key is a plain `settings` row, so the existing full JSON export/import carries it (import never
overwrites a key the vault already has, like every other setting).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException

from . import db

router = APIRouter()

KEY = "dump_templates"
MAX_LABEL = 30
MAX_TEXT = 5000
MAX_TEMPLATES = 500          # the user's own templates
MAX_OVERRIDES = 100          # edited / deleted built-ins (far above the number of built-ins that will ever exist)
MAX_ORDER = MAX_TEMPLATES + MAX_OVERRIDES
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _bad(msg: str):
    raise HTTPException(422, msg)


def _id(v, what: str) -> str:
    if not isinstance(v, str) or not _ID.match(v):
        _bad(f"{what}: a template id is 1-40 letters, digits, - or _")
    return v


def _fields(o, what: str) -> tuple[str, str]:
    if not isinstance(o, dict):
        _bad(f"{what}: expected an object")
    label, text = o.get("label"), o.get("text")
    if not isinstance(label, str) or not label.strip():
        _bad(f"{what}: give the template a name")
    if len(label.strip()) > MAX_LABEL:
        _bad(f"{what}: the name can be at most {MAX_LABEL} characters")
    if not isinstance(text, str) or not text.strip():
        _bad(f"{what}: the template text can't be empty")
    if len(text) > MAX_TEXT:
        _bad(f"{what}: the text can be at most {MAX_TEXT} characters")
    return label.strip(), text.replace("\r\n", "\n")


def _id_list(v, what: str, limit: int) -> list[str]:
    if not isinstance(v, list):
        _bad(f"{what} must be a list")
    if len(v) > limit:
        _bad(f"{what} has too many entries (max {limit})")
    out: list[str] = []
    for x in v:
        _id(x, what)
        if x not in out:
            out.append(x)
    return out


def normalize(doc) -> dict:
    """Validate a client document and return the canonical stored form (raises HTTPException 422)."""
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        _bad("expected an object")
    raw = doc.get("templates", [])
    if not isinstance(raw, list):
        _bad("templates must be a list")
    if len(raw) > MAX_TEMPLATES:
        _bad(f"that's too many templates (max {MAX_TEMPLATES})")
    templates, seen = [], set()
    for t in raw:
        tid = _id(t.get("id") if isinstance(t, dict) else None, "templates")
        if tid in seen:
            _bad(f"two templates share the id '{tid}'")
        seen.add(tid)
        label, text = _fields(t, f"template '{tid}'")
        templates.append({"id": tid, "label": label, "text": text})

    ov_raw = doc.get("overrides", {})
    if not isinstance(ov_raw, dict):
        _bad("overrides must be an object")
    if len(ov_raw) > MAX_OVERRIDES:
        _bad("too many edited built-in templates")
    overrides = {}
    for k, v in ov_raw.items():
        _id(k, "overrides")
        if k in seen:
            _bad(f"'{k}' is used by both a template and an edited built-in")
        label, text = _fields(v, f"built-in '{k}'")
        overrides[k] = {"label": label, "text": text}

    deleted = _id_list(doc.get("deleted", []), "deleted", MAX_OVERRIDES)
    clash = [d for d in deleted if d in seen or d in overrides]
    if clash:
        _bad(f"'{clash[0]}' can't be both deleted and in use")
    order = _id_list(doc.get("order", []), "order", MAX_ORDER)
    pinned = doc.get("pinned")
    pinned = None if pinned is None else _id_list(pinned, "pinned", MAX_ORDER)
    return {"templates": templates, "overrides": overrides, "deleted": deleted, "order": order, "pinned": pinned}


def load() -> dict:
    """The stored document, normalised; an invalid or missing row reads as 'no changes'."""
    try:
        return normalize(db.get_setting(KEY, None))
    except HTTPException:
        return normalize(None)


@router.get("/templates")
def get_templates():
    return load()


@router.put("/templates")
def put_templates(body: dict):
    doc = normalize(body)
    db.set_setting(KEY, doc)
    return doc
