"""Markdown importer (Phase 6): each .md/.txt file becomes a dump, processed
one at a time by a background queue so local models are never overloaded."""
from __future__ import annotations

import queue
import re
import threading
from datetime import datetime, timezone

from . import db, pipeline

_FM = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)^---[ \t]*\r?\n", re.S | re.M)
_H1 = re.compile(r"^#\s+(.+?)\s*$", re.M)
_q: "queue.Queue[str]" = queue.Queue()
_state = {"running": None, "done": 0, "worker": None}


def _fm_value(fm: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.+?)\s*$", fm, re.M)
    return m.group(1).strip().strip('"\'') if m else None


def _parse_date(s: str | None, mtime: float | None) -> str:
    for cand in (s or "",):
        try:
            dt = datetime.fromisoformat(cand.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except ValueError:
            pass
    if mtime:
        return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    return db.now_iso()


def parse_file(name: str, text: str, mtime: float | None = None) -> dict:
    fm = ""
    m = _FM.match(text)
    if m:
        fm, text = m.group(1), text[m.end():]
    h = _H1.search(text)
    # Only a heading the author wrote is a title. A plain transcript has none, and a preset title (the
    # file name, say) stops the pipeline from asking the AI for a real one, so leave it empty.
    title = ((h.group(1) if h else _fm_value(fm, "title")) or "").strip()[:80] or None
    if h:
        text = text[:h.start()] + text[h.end():]
    return {"id": _fm_value(fm, "id"), "title": title,
            "created_at": _parse_date(_fm_value(fm, "created") or _fm_value(fm, "date"), mtime),
            "text": text.strip(), "own_export": _fm_value(fm, "source") == "braindump-lite"}


def import_files(files: list[tuple[str, str, float | None]], mode: str = "freeform") -> dict:
    imported, skipped = [], 0
    for name, text, mtime in files:
        p = parse_file(name, text, mtime)
        if not p["text"]:
            skipped += 1
            continue
        if p["id"] and db.query_one("SELECT 1 FROM dumps WHERE id=?", (p["id"],)):
            skipped += 1
            continue
        did = p["id"] if p["id"] and p["own_export"] else db.new_id()
        # captured_local is what streaks count; run_pipeline stamps "now" when it is empty, which
        # would move an imported dump's streak day to the day it was processed.
        captured = datetime.fromisoformat(p["created_at"]).astimezone().isoformat(timespec="seconds")
        db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, captured_local) VALUES (?,?,?,?,?,'pending',?)",
                   (did, p["created_at"], mode, p["text"], p["title"], captured))
        imported.append(did)
        enqueue(did)
    return {"imported": len(imported), "skipped": skipped, "ids": imported}


def enqueue(dump_id: str) -> None:
    _q.put(dump_id)
    if not _state["worker"] or not _state["worker"].is_alive():
        _state["worker"] = threading.Thread(target=_worker, daemon=True, name="import-queue")
        _state["worker"].start()


def _worker() -> None:
    while True:
        try:
            did = _q.get(timeout=2)
        except queue.Empty:
            return
        _state["running"] = did
        try:
            pipeline.run_pipeline(did)
        finally:
            _state["running"] = None
            _state["done"] += 1
            _q.task_done()


def status() -> dict:
    return {"pending": _q.qsize(), "running": _state["running"], "done": _state["done"]}


def drain_sync() -> None:
    """Tests: process everything queued on this thread."""
    while not _q.empty():
        pipeline.run_pipeline(_q.get())
        _q.task_done()
