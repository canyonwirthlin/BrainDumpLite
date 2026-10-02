"""Dump card extras: pin, split, merge (+ undo), 30-day trash, and a local "looks like a duplicate" hint.

Soft delete lives in routes.delete_dump (sets dumps.deleted_at); every dump listing / search / graph /
stats / export query filters `deleted_at IS NULL`. A dump folded into another by a merge is also
soft-deleted (merged_into set) so Undo can bring it back; it is hidden from the Trash list.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import ai, db

router = APIRouter()

TRASH_DAYS = 30


# ── helpers ──────────────────────────────────────────────────────────────────

def _body(d) -> str:
    return "\n".join([d["title"] or "", d["summary"] or "", d["clean_text"] or d["raw_text"] or ""])


def _index_dump(dump_id: str) -> None:
    d = db.query_one("SELECT title, summary, clean_text, raw_text, status, deleted_at FROM dumps WHERE id=?", (dump_id,))
    db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
    if d and d["status"] == "ready" and not d["deleted_at"]:
        db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (dump_id, _body(d)))


def _reindex_items(dump_id: str) -> None:
    db.execute("DELETE FROM items_fts WHERE dump_id=?", (dump_id,))
    for it in db.query("SELECT id, content, detail FROM items WHERE dump_id=?", (dump_id,)):
        db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)",
                   (it["id"], dump_id, f"{it['content']} {it['detail'] or ''}"))


def _live(dump_id: str):
    d = db.query_one("SELECT * FROM dumps WHERE id=? AND deleted_at IS NULL", (dump_id,))
    if not d:
        raise HTTPException(404, "Dump not found")
    return d


def _names(raw) -> list[str]:
    try:
        v = json.loads(raw) if raw else []
        return [str(x) for x in v] if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


def _union(*lists: list[str]) -> list[str]:
    out, seen = [], set()
    for lst in lists:
        for n in lst:
            if n.lower() not in seen:
                seen.add(n.lower()); out.append(n)
    return out[:24]


# ── pin ──────────────────────────────────────────────────────────────────────

class PinIn(BaseModel):
    pinned: bool = True


@router.post("/dumps/{dump_id}/pin")
def pin_dump(dump_id: str, body: PinIn):
    _live(dump_id)
    db.execute("UPDATE dumps SET pinned=? WHERE id=?", (1 if body.pinned else 0, dump_id))
    return {"id": dump_id, "pinned": body.pinned}


@router.post("/items/{item_id}/pin")
def pin_item(item_id: str, body: PinIn):
    if not db.query_one("SELECT 1 FROM items WHERE id=?", (item_id,)):
        raise HTTPException(404, "Item not found")
    db.execute("UPDATE items SET pinned=? WHERE id=?", (1 if body.pinned else 0, item_id))
    return {"id": item_id, "pinned": body.pinned}


@router.get("/dumps-meta")
def dumps_meta():
    """{id: {pinned, dup}} for the History list: which dumps are pinned and which look like duplicates."""
    pinned = [r["id"] for r in db.query("SELECT id FROM dumps WHERE pinned=1 AND deleted_at IS NULL")]
    return {"pinned": pinned, "duplicates": duplicate_hints()}


# ── duplicate hint (local only: word-set similarity, plus embeddings when present) ───────────────

_WORD = re.compile(r"[a-z0-9']+")


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if len(w) > 2}


def duplicate_hints(limit: int = 400, text_threshold: float = 0.6, emb_threshold: float = 0.93) -> dict:
    """{dump_id: {"of": other_id, "title": other_title, "score": s}} - each dump points at the OLDER
    near-copy, so only the later one gets the badge."""
    rows = db.query("SELECT id, title, created_at, raw_text, clean_text, embedding FROM dumps "
                    "WHERE status='ready' AND deleted_at IS NULL ORDER BY created_at ASC")[-limit:]
    toks = [_tokens(r["raw_text"] or r["clean_text"]) for r in rows]
    embs: list = []
    for r in rows:
        try:
            embs.append(json.loads(r["embedding"]) if r["embedding"] else None)
        except (ValueError, TypeError):
            embs.append(None)
    out: dict = {}
    for j in range(len(rows)):
        best = (0.0, None)
        for i in range(j):
            a, b = toks[i], toks[j]
            s = 0.0
            if len(a) >= 5 and len(b) >= 5:
                s = len(a & b) / len(a | b)
                if s < text_threshold:
                    s = 0.0
            if not s and embs[i] and embs[j] and len(embs[i]) == len(embs[j]):
                c = ai.cosine(embs[i], embs[j])
                if c >= emb_threshold:
                    s = c
            if s > best[0]:
                best = (s, i)
        if best[1] is not None:
            o = rows[best[1]]
            out[rows[j]["id"]] = {"of": o["id"], "title": o["title"], "score": round(best[0], 2)}
    return out


# ── split ────────────────────────────────────────────────────────────────────

class SplitIn(BaseModel):
    at: int          # character offset into the dump's text (clean text if it has one, else raw)


def _snap(text: str, pos: int) -> int:
    """Nudge a cut to the nearest whitespace so words aren't sliced."""
    pos = max(0, min(len(text), pos))
    for k in range(0, 60):
        for p in (pos - k, pos + k):
            if 0 < p < len(text) and text[p].isspace():
                return p
    return pos


def _overlap(content: str, text: str) -> int:
    return len(_tokens(content) & _tokens(text))


@router.post("/dumps/{dump_id}/split")
def split_dump(dump_id: str, body: SplitIn):
    d = _live(dump_id)
    if d["status"] != "ready":
        raise HTTPException(400, "Only finished dumps can be split")
    shown = d["clean_text"] or d["raw_text"] or ""
    if not 0 < body.at < len(shown):
        raise HTTPException(400, "Pick a split point inside the text")
    cut = _snap(shown, body.at)
    a_txt, b_txt = shown[:cut].strip(), shown[cut:].strip()
    if not a_txt or not b_txt:
        raise HTTPException(400, "Pick a split point with text on both sides")
    raw = d["raw_text"] or ""
    if d["clean_text"] and raw and d["clean_text"] != raw:
        rcut = _snap(raw, round(len(raw) * cut / max(1, len(shown))))
        a_raw, b_raw = raw[:rcut].strip(), raw[rcut:].strip() or b_txt
        a_clean, b_clean = a_txt, b_txt
    else:
        a_raw, b_raw, a_clean, b_clean = a_txt, b_txt, (a_txt if d["clean_text"] else None), (b_txt if d["clean_text"] else None)
    new_id = db.new_id()
    title2 = f"{(d['title'] or 'Untitled')[:70]} (part 2)"
    keep = lambda names, txt: [n for n in names if n.lower() in txt.lower()]
    concepts, people = _names(d["concepts"]), _names(d["people"])
    with db.lock():
        db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, status, provider, tone, concepts, people, captured_local) "
                   "VALUES (?,?,?,?,?,?,'ready',?,?,?,?,?)",
                   (new_id, d["created_at"], d["mode"], b_raw, b_clean, title2, d["provider"], d["tone"],
                    json.dumps(keep(concepts, b_txt)), json.dumps(keep(people, b_txt)), d["captured_local"]))
        db.execute("UPDATE dumps SET raw_text=?, clean_text=?, summary=?, embedding=NULL, concepts=?, people=? WHERE id=?",
                   (a_raw, a_clean, d["summary"], json.dumps(keep(concepts, a_txt) or concepts), json.dumps(keep(people, a_txt) or people), dump_id))
        moved = []
        for it in db.query("SELECT id, content, detail FROM items WHERE dump_id=?", (dump_id,)):
            text = f"{it['content']} {it['detail'] or ''}"
            if _overlap(text, b_txt) > _overlap(text, a_txt):   # ties stay with the first half
                db.execute("UPDATE items SET dump_id=? WHERE id=?", (new_id, it["id"]))
                moved.append(it["id"])
        _index_dump(dump_id); _index_dump(new_id)
        _reindex_items(dump_id); _reindex_items(new_id)
    return {"first": dump_id, "second": new_id, "moved_items": moved}


# ── merge / undo ─────────────────────────────────────────────────────────────

class MergeIn(BaseModel):
    ids: list[str]


@router.post("/dumps/merge")
def merge_dumps(body: MergeIn):
    ids = list(dict.fromkeys(body.ids))
    if len(ids) < 2:
        raise HTTPException(400, "Pick at least two dumps to merge")
    rows = [_live(i) for i in ids]
    if any(r["status"] != "ready" for r in rows):
        raise HTTPException(400, "Only finished dumps can be merged")
    rows.sort(key=lambda r: r["created_at"])
    target, sources = rows[0], rows[1:]
    snapshot = {"target": {k: target[k] for k in ("title", "raw_text", "clean_text", "summary", "concepts", "people", "embedding")},
                "sources": []}
    now = db.now_iso()
    merge_id = db.new_id()
    with db.lock():
        for s in sources:
            snapshot["sources"].append({"id": s["id"],
                                        "item_ids": [r["id"] for r in db.query("SELECT id FROM items WHERE dump_id=?", (s["id"],))]})
        every = [target, *sources]
        raw = "\n\n".join((r["raw_text"] or "").strip() for r in every)
        clean = ("\n\n".join((r["clean_text"] or r["raw_text"] or "").strip() for r in every)
                 if any(r["clean_text"] for r in every) else None)
        summary = "\n".join(s for s in ((r["summary"] or "").strip() for r in every) if s) or None
        concepts = _union(*[_names(r["concepts"]) for r in every])
        people = _union(*[_names(r["people"]) for r in every])
        db.execute("UPDATE dumps SET raw_text=?, clean_text=?, summary=?, concepts=?, people=?, embedding=NULL WHERE id=?",
                   (raw, clean, summary, json.dumps(concepts), json.dumps(people), target["id"]))
        for s in sources:
            db.execute("UPDATE items SET dump_id=? WHERE dump_id=?", (target["id"], s["id"]))
            db.execute("UPDATE dumps SET deleted_at=?, merged_into=? WHERE id=?", (now, target["id"], s["id"]))
            db.execute("DELETE FROM dumps_fts WHERE id=?", (s["id"],))
        db.execute("INSERT INTO dump_merges (id, target_id, snapshot, created_at, undone) VALUES (?,?,?,?,0)",
                   (merge_id, target["id"], json.dumps(snapshot), now))
        _index_dump(target["id"]); _reindex_items(target["id"])
    return {"id": target["id"], "merge_id": merge_id, "merged": [s["id"] for s in sources]}


@router.post("/merges/{merge_id}/undo")
def undo_merge(merge_id: str):
    m = db.query_one("SELECT * FROM dump_merges WHERE id=?", (merge_id,))
    if not m:
        raise HTTPException(404, "Merge not found")
    if m["undone"]:
        raise HTTPException(400, "Already undone")
    snap = json.loads(m["snapshot"])
    tid = m["target_id"]
    missing = [s["id"] for s in snap["sources"] if not db.query_one("SELECT 1 FROM dumps WHERE id=?", (s["id"],))]
    if missing or not db.query_one("SELECT 1 FROM dumps WHERE id=?", (tid,)):
        raise HTTPException(409, "Some of the original dumps were already deleted forever")
    t = snap["target"]
    with db.lock():
        db.execute("UPDATE dumps SET title=?, raw_text=?, clean_text=?, summary=?, concepts=?, people=?, embedding=? WHERE id=?",
                   (t["title"], t["raw_text"], t["clean_text"], t["summary"], t["concepts"], t["people"], t["embedding"], tid))
        for s in snap["sources"]:
            db.execute("UPDATE dumps SET deleted_at=NULL, merged_into=NULL WHERE id=?", (s["id"],))
            for iid in s["item_ids"]:
                db.execute("UPDATE items SET dump_id=? WHERE id=?", (s["id"], iid))
            _index_dump(s["id"]); _reindex_items(s["id"])
        _index_dump(tid); _reindex_items(tid)
        db.execute("UPDATE dump_merges SET undone=1 WHERE id=?", (merge_id,))
    return {"ok": True, "restored": [s["id"] for s in snap["sources"]], "target": tid}


# ── trash ────────────────────────────────────────────────────────────────────

def _hard_delete(dump_id: str) -> None:
    db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
    db.execute("DELETE FROM items_fts WHERE dump_id=?", (dump_id,))
    db.execute("DELETE FROM dumps WHERE id=?", (dump_id,))  # cascades items/links


def purge_expired(days: int = TRASH_DAYS) -> int:
    """Delete forever whatever has been in the trash longer than `days`. Returns how many went."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    ids = [r["id"] for r in db.query("SELECT id FROM dumps WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))]
    for i in ids:
        _hard_delete(i)
    return len(ids)


def _days_left(deleted_at: str) -> int:
    try:
        t = datetime.fromisoformat(deleted_at)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return max(0, TRASH_DAYS - (datetime.now(timezone.utc) - t).days)
    except (ValueError, TypeError):
        return TRASH_DAYS


@router.get("/trash")
def list_trash():
    purge_expired()
    rows = db.query(
        "SELECT d.id, d.title, d.created_at, d.deleted_at, d.raw_text, d.clean_text, "
        "(SELECT COUNT(*) FROM items i WHERE i.dump_id = d.id) AS item_count "
        "FROM dumps d WHERE d.deleted_at IS NOT NULL AND d.merged_into IS NULL AND d.status != 'manual' ORDER BY d.deleted_at DESC")
    return [{"id": r["id"], "title": r["title"], "created_at": r["created_at"], "deleted_at": r["deleted_at"],
             "days_left": _days_left(r["deleted_at"]), "item_count": r["item_count"],
             "preview": (r["clean_text"] or r["raw_text"] or "")[:160]} for r in rows]


@router.post("/trash/{dump_id}/restore")
def restore_dump(dump_id: str):
    if not db.query_one("SELECT 1 FROM dumps WHERE id=? AND deleted_at IS NOT NULL", (dump_id,)):
        raise HTTPException(404, "Not in the trash")
    db.execute("UPDATE dumps SET deleted_at=NULL, merged_into=NULL WHERE id=?", (dump_id,))
    _index_dump(dump_id)
    return {"ok": True, "id": dump_id}


@router.delete("/trash/{dump_id}")
def delete_forever(dump_id: str):
    if not db.query_one("SELECT 1 FROM dumps WHERE id=? AND deleted_at IS NOT NULL", (dump_id,)):
        raise HTTPException(404, "Not in the trash")
    _hard_delete(dump_id)
    return {"ok": True}


@router.delete("/trash")
def empty_trash():
    ids = [r["id"] for r in db.query("SELECT id FROM dumps WHERE deleted_at IS NOT NULL AND merged_into IS NULL")]
    for i in ids:
        _hard_delete(i)
    return {"ok": True, "deleted": len(ids)}
