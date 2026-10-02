"""0.22 search endpoints: saved + recent searches (moved from localStorage into the vault) and task search.

Task search reuses the Search tab's engine pieces (stop-word-aware terms, porter-style stems, prefix
matching, vault-vocabulary typo correction) so "dentst" finds "call the dentist" in Tasks too."""
from __future__ import annotations

import re

from fastapi import APIRouter
from pydantic import BaseModel

from . import db, graph, search as search_mod

router = APIRouter()
RECENT_CAP = 15
SAVED_CAP = 50
MAX_Q = 200


def _clean(q: str | None) -> str:
    return re.sub(r"\s+", " ", (q or "")).strip()[:MAX_Q]


def _remember(q: str) -> None:
    db.execute("DELETE FROM recent_searches WHERE lower(query)=lower(?)", (q,))
    db.execute("INSERT INTO recent_searches (query, used_at) VALUES (?,?)", (q, db.now_iso()))
    db.execute("DELETE FROM recent_searches WHERE query NOT IN "
               "(SELECT query FROM recent_searches ORDER BY used_at DESC, rowid DESC LIMIT ?)", (RECENT_CAP,))


def _save(q: str) -> None:
    if db.query_one("SELECT id FROM saved_searches WHERE lower(query)=lower(?)", (q,)):
        return
    db.execute("INSERT INTO saved_searches (id, query, created_at) VALUES (?,?,?)", (db.new_id(), q, db.now_iso()))
    db.execute("DELETE FROM saved_searches WHERE id NOT IN "
               "(SELECT id FROM saved_searches ORDER BY created_at DESC, rowid DESC LIMIT ?)", (SAVED_CAP,))


def _lists() -> dict:
    return {"saved": [r["query"] for r in db.query("SELECT query FROM saved_searches ORDER BY created_at DESC, rowid DESC")],
            "recent": [r["query"] for r in db.query("SELECT query FROM recent_searches ORDER BY used_at DESC, rowid DESC")]}


def _uniq(xs: list[str]) -> list[str]:
    seen, out = set(), []
    for x in map(_clean, xs):
        if x and x.lower() not in seen:
            seen.add(x.lower())
            out.append(x)
    return out


class QueryBody(BaseModel):
    query: str


class MigrateBody(BaseModel):
    saved: list[str] = []
    recent: list[str] = []


@router.get("/search/lists")
def search_lists():
    return _lists()


@router.post("/search/recent")
def add_recent(body: QueryBody):
    q = _clean(body.query)
    if q:
        _remember(q)
    return _lists()


@router.delete("/search/recent")
def clear_recent():
    db.execute("DELETE FROM recent_searches")
    return _lists()


@router.post("/search/saved")
def add_saved(body: QueryBody):
    q = _clean(body.query)
    if q:
        _save(q)
    return _lists()


@router.post("/search/saved/remove")
def remove_saved(body: QueryBody):
    db.execute("DELETE FROM saved_searches WHERE lower(query)=lower(?)", (_clean(body.query),))
    return _lists()


@router.post("/search/migrate")
def migrate_local(body: MigrateBody):
    """One-time import of the old localStorage lists. Oldest first so the newest end up on top;
    existing vault entries win and duplicates are ignored."""
    for q in reversed(_uniq(body.saved)[:SAVED_CAP]):
        _save(q)
    if not db.query_one("SELECT query FROM recent_searches LIMIT 1"):
        for q in reversed(_uniq(body.recent)[:RECENT_CAP]):
            _remember(q)
    return _lists()


def search_tasks(q: str) -> dict:
    """Task/goal/idea items matching every search word (prefix, stem or typo-corrected)."""
    ts = search_mod.terms(q)
    if not ts:
        return {"query": q, "ids": [], "corrected": {}}
    vocab = search_mod._vocab()
    fixes = {t: c for t in ts if (c := search_mod.correct(t, vocab))}
    ids = []
    for r in db.query("SELECT id, content FROM items WHERE status != 'rejected' AND kind IN ('task','goal','idea') "
                        f"AND dump_id NOT IN (SELECT id FROM dumps WHERE deleted_at IS NOT NULL) AND {db.PRIVATE_ITEM_SQL}"):
        toks = re.findall(r"\w+", (r["content"] or "").lower())

        def hit(t: str) -> bool:
            cands = [t] + ([fixes[t]] if t in fixes else [])
            return any(tok.startswith(c) or graph._stem(tok) == graph._stem(c) for c in cands for tok in toks)

        if toks and all(hit(t) for t in ts):
            ids.append(r["id"])
    return {"query": q, "ids": ids, "corrected": fixes}


@router.get("/search/tasks")
def search_tasks_endpoint(q: str):
    return search_tasks(q)
