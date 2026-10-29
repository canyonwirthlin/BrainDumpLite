"""Brain map hover cards: a small summary for one node of the map.

The graph payload only carries labels, so the card endpoint (routes_graph_cards.py) asks this module for the rest.
Node ids are the ones graph.build() makes: a dump id, "concept:<lowercase name>", "person:<lowercase name>" or
"item:<id>". Concept spelling variants resolve through graph.canonical_map exactly like the map does, so a card for
"internship" counts the dumps that say "Internships" too. Trashed and private dumps never show up (and a node that
only exists because of one is "not found")."""
from __future__ import annotations

import re
import time
from collections import Counter

from . import db, graph, item_types

SNIPPET_CHARS = 170
CO_LIMIT = 5


class NotFound(Exception):
    """The node doesn't exist (any more), or belongs to a trashed / private dump."""


def _snippet(text: str | None, limit: int = SNIPPET_CHARS) -> str:
    t = re.sub(r"\s+", " ", (text or "")).strip()
    t = re.sub(r"^[•\-*–\s]+", "", t)   # summaries often start with a list marker
    if len(t) <= limit:
        return t
    cut = t[:limit].rsplit(" ", 1)[0] or t[:limit]
    return cut.rstrip(" ,;:.-") + "…"


def _unique(names: list[str], key) -> list[str]:
    seen, out = set(), []
    for n in names:
        k = key(n)
        if k not in seen:
            seen.add(k)
            out.append(n)
    return out


# Parsing every dump's concept/people JSON is the expensive part of a named card, and a hover sweep asks for many cards
# in a row. So the parsed table (and the spelling-variant map) is cached and rebuilt whenever anything is written to the
# vault (sqlite's per-connection change counter), or after TTL seconds as a safety net.
TTL = 30.0
_cache: dict = {"key": None, "at": 0.0, "val": None}


def _table() -> tuple[list[dict], dict]:
    key = (str(db.db_path()), id(db.conn()), db.query_one("SELECT total_changes() AS n")["n"])
    if _cache["key"] == key and time.monotonic() - _cache["at"] < TTL:
        return _cache["val"]
    rows = [{"id": r["id"], "title": r["title"] or "Untitled", "created_at": r["created_at"],
             "concepts": graph._names(r["concepts"]), "people": graph._names(r["people"])}
            for r in db.query("SELECT id, title, created_at, concepts, people FROM dumps WHERE status='ready' AND deleted_at IS NULL "
                              f"AND {db.PRIVATE_SQL} ORDER BY created_at DESC")]
    val = (rows, graph.canonical_map("concepts"))
    _cache.update(key=key, at=time.monotonic(), val=val)
    return val


def _dump_card(dump_id: str) -> dict:
    r = db.query_one(
        "SELECT id, title, created_at, summary, clean_text, raw_text, people, concepts FROM dumps "
        f"WHERE id=? AND status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}", (dump_id,))
    if not r:
        raise NotFound(dump_id)
    cmap = _table()[1]
    concepts = _unique([cmap.get(n.lower(), n) for n in graph._names(r["concepts"])], lambda n: n.lower())
    people = _unique(graph._names(r["people"]), lambda n: n.lower())
    open_tasks = db.query_one("SELECT COUNT(*) AS n FROM items WHERE dump_id=? AND kind='task' AND done=0 AND status!='rejected'",
                              (dump_id,))["n"]
    return {"id": r["id"], "type": "dump", "label": r["title"] or "Untitled", "created_at": r["created_at"],
            "snippet": _snippet(r["summary"] or r["clean_text"] or r["raw_text"]),
            "concepts": concepts[:4], "people": people[:3], "open_tasks": open_tasks}


def _named_card(kind: str, name: str, node_id: str) -> dict:
    col = "concepts" if kind == "concept" else "people"
    rows, ccmap = _table()
    gk = (lambda n: graph._group_key(n, ccmap)) if kind == "concept" else (lambda n: n.lower())
    want = gk(name)
    shown = {v.lower(): v for v in ccmap.values()} if kind == "concept" else {}
    count, first, last, label = 0, None, None, None
    co_concepts: Counter = Counter()
    co_people: Counter = Counter()
    co_label: dict[str, str] = {}
    latest: list[dict] = []
    for r in rows:                      # newest first
        mine = r[col]
        if want not in {gk(n) for n in mine}:
            continue
        count += 1
        first = r["created_at"] if first is None or r["created_at"] < first else first
        last = r["created_at"] if last is None or r["created_at"] > last else last
        if label is None:
            label = shown.get(want) or next((n for n in mine if n.lower() == want), name)
        if len(latest) < 3:
            latest.append({"id": r["id"], "title": r["title"], "created_at": r["created_at"]})
        for n in r["concepts"]:
            k = graph._group_key(n, ccmap)
            if kind == "concept" and k == want:
                continue
            co_concepts[k] += 1
            co_label.setdefault(k, ccmap.get(n.lower(), n))
        for n in r["people"]:           # people alongside a concept, other people alongside a person
            if kind == "person" and n.lower() == want:
                continue
            co_people[n.lower()] += 1
            co_label.setdefault("p:" + n.lower(), n)
    if not count:
        raise NotFound(node_id)

    def top(counter: Counter, prefix: str, n: int) -> list[dict]:
        return [{"name": co_label[prefix + k], "count": v} for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]

    return {"id": node_id, "type": kind, "label": label or name, "count": count, "first_at": first, "last_at": last,
            "related": top(co_concepts, "", CO_LIMIT), "people": top(co_people, "p:", 3), "latest": latest}


def _item_card(item_id: str, node_id: str) -> dict:
    r = db.query_one(
        "SELECT i.id, i.kind, i.content, i.detail, i.status, i.done, i.due_date, i.dump_id, d.title AS dump_title "
        "FROM items i JOIN dumps d ON d.id = i.dump_id "
        f"WHERE i.id=? AND i.status != 'rejected' AND d.status='ready' AND d.deleted_at IS NULL AND {db.PRIVATE_SQL}", (item_id,))
    if not r:
        raise NotFound(node_id)
    t = item_types.get(r["kind"])
    return {"id": node_id, "type": r["kind"], "kind_label": (t or {}).get("label") or r["kind"].title(), "label": r["content"],
            "text": _snippet(r["content"], 260), "detail": _snippet(r["detail"], 140), "done": bool(r["done"]),
            "status": "done" if r["done"] else ("approved" if r["status"] == "approved" else "suggested"),
            "due_date": r["due_date"], "dump_id": r["dump_id"], "dump_title": r["dump_title"] or "Untitled"}


def card(node_id: str) -> dict:
    """The card for one map node. Raises NotFound for unknown / trashed / private nodes."""
    node_id = (node_id or "").strip()
    if not node_id:
        raise NotFound(node_id)
    head, sep, rest = node_id.partition(":")
    if sep and head in ("concept", "person") and rest.strip():
        return _named_card(head, rest.strip(), node_id)
    if sep and head == "item" and rest:
        return _item_card(rest, node_id)
    return _dump_card(node_id)
