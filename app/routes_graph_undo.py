"""Undoable concept / person merges for the Brain map (Merge tool + Ctrl+Z).

`graph.merge_names` (POST /api/merge) rewrites the concepts/people JSON of every dump that carries the old
name and records the old spellings as aliases (settings key `name_aliases`). It cannot be reversed afterwards, so
the map goes through this module instead:

  POST /api/merge/undoable   {kind, sources, target}  -> same result as /api/merge plus `undo_id`
  POST /api/merge/undo/{id}                            -> puts every touched dump and the aliases back exactly

How it stays exact. Before the merge we read the raw concepts/people column of every dump and the alias setting;
after it we keep only what changed: `{dump id: [column before, column after]}` and `{alias key: [before, after]}`.
Undo restores the "before" values, but only where the row still holds the "after" value:
  * a touched dump that was edited since (or touched by a later merge) refuses the whole undo with 409 and a plain
    message, so nothing is half-restored and a newer change is never overwritten (undo the newer one first);
  * a touched dump that was deleted for good since is skipped (nothing left to restore);
  * an alias that someone else re-pointed since is left alone.
Undoing twice answers 409 "already undone"; an id that is unknown or was pushed out of the cache answers 404.
Redo is simply running the merge again (a new undo id).

Trash / private: `merge_names` has always rewritten every dump that has the name, including trashed and private ones
(so a restored dump does not bring the old spelling back as a stray node). Undo mirrors that exactly, which is the only
way to be byte-identical. Nothing about those dumps is ever returned to the caller (counts only), and the snapshot
lives in the settings key `graph_undo_cache`, whose name makes `dataio` skip it in data exports (`cache` is on its
secret-ish list), so it never leaves the vault. The cache keeps the newest `MAX_ENTRIES` merges and survives restarts;
an undone entry drops its payload. Concept/person merges do not touch the FTS index (it only holds dump text), so
there is nothing to reindex on undo.

Dump-to-dump merges use the existing /api/dumps/merge and /api/merges/{id}/undo (routes_dumps.py), unchanged."""
from __future__ import annotations

import copy
import json

from fastapi import APIRouter, HTTPException

from . import db, graph
from .routes import MergeIn

router = APIRouter()

CACHE_KEY = "graph_undo_cache"
MAX_ENTRIES = 30


def _cache() -> list[dict]:
    v = db.get_setting(CACHE_KEY, [])
    return [e for e in v if isinstance(e, dict)] if isinstance(v, list) else []


def _alias_part(al, kind: str) -> dict:
    part = al.get(kind) if isinstance(al, dict) else None
    return part if isinstance(part, dict) else {}


@router.post("/merge/undoable")
def merge_undoable(body: MergeIn):
    col = graph._COLUMN.get(body.kind)
    if not col:
        raise HTTPException(400, "kind must be person or concept")
    with db.lock():
        before = {r["id"]: r[col] for r in db.query(f"SELECT id, {col} FROM dumps WHERE {col} IS NOT NULL")}
        al_before = copy.deepcopy(db.get_setting(graph.ALIAS_KEY, None))
        try:
            res = graph.merge_names(body.kind, body.sources, body.target)
        except ValueError as e:
            raise HTTPException(400, str(e))
        dumps = {}
        for r in db.query(f"SELECT id, {col} FROM dumps WHERE {col} IS NOT NULL"):
            if before.get(r["id"]) != r[col]:
                dumps[r["id"]] = [before.get(r["id"]), r[col]]
        al_after = db.get_setting(graph.ALIAS_KEY, None)
        ab, aa = _alias_part(al_before, body.kind), _alias_part(al_after, body.kind)
        aliases = {k: [ab.get(k), aa.get(k)] for k in set(ab) | set(aa) if ab.get(k) != aa.get(k)}
        undo_id = None
        if dumps or aliases:
            undo_id = db.new_id()
            entry = {"id": undo_id, "kind": body.kind, "target": res["name"], "at": db.now_iso(), "undone": False,
                     "col": col, "dumps": dumps, "aliases": aliases,
                     "had_setting": al_before is not None,
                     "had_kind": isinstance(al_before, dict) and body.kind in al_before}
            db.set_setting(CACHE_KEY, (_cache() + [entry])[-MAX_ENTRIES:])
    return {**res, "undo_id": undo_id}


@router.post("/merge/undo/{undo_id}")
def undo_merge_names(undo_id: str):
    with db.lock():
        cache = _cache()
        e = next((x for x in cache if x.get("id") == undo_id), None)
        if not e:
            raise HTTPException(404, "That merge can no longer be undone (it is too old, or it was already cleared).")
        if e.get("undone"):
            raise HTTPException(409, "That merge was already undone.")
        col = e["col"]
        rows = {}
        for did, (b, a) in e["dumps"].items():
            r = db.query_one(f"SELECT {col} FROM dumps WHERE id=?", (did,))
            if r is not None:
                rows[did] = r[col]
        stale = [d for d, cur in rows.items() if cur != e["dumps"][d][1]]
        if stale:
            raise HTTPException(409, "Some notes changed after this merge (an edit, or a newer merge), so it can't be undone "
                                     "safely. Undo the newer change first.")
        for did in rows:
            db.execute(f"UPDATE dumps SET {col}=? WHERE id=?", (e["dumps"][did][0], did))
        # aliases: put back only the keys that still hold the value the merge wrote
        al = db.get_setting(graph.ALIAS_KEY, None)
        if e["aliases"]:
            al = al if isinstance(al, dict) else {}
            part = al.setdefault(e["kind"], {})
            if not isinstance(part, dict):
                part = al[e["kind"]] = {}
            for k, (b, a) in e["aliases"].items():
                if part.get(k) == a:
                    if b is None:
                        part.pop(k, None)
                    else:
                        part[k] = b
            if not part and not e.get("had_kind"):
                al.pop(e["kind"], None)
            if not al and not e.get("had_setting"):
                db.execute("DELETE FROM settings WHERE key=?", (graph.ALIAS_KEY,))
            else:
                db.set_setting(graph.ALIAS_KEY, al)
        restored = len(rows)
        e["undone"] = True
        e["dumps"], e["aliases"] = {}, {}          # the payload is no longer needed
        db.set_setting(CACHE_KEY, cache)
    return {"ok": True, "restored_dumps": restored, "name": e["target"]}
