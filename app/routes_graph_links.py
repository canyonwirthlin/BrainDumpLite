"""Brain map "Link" mode (blueprint wires): connect two nodes by dragging, no note has to be opened.

One uniform API over the places a link between two map nodes really lives (nothing here adds schema):

  dump  <-> dump      the manual `links` table (score 1.0), the same rows POST /api/dumps/{id}/links writes
  dump  <-> concept   the name is added to / removed from the dump's `concepts` list (the chips editor's PATCH does the same)
  dump  <-> person    the name is added to / removed from the dump's `people` list
  concept/person <-> concept/person   the user's accepted links kept in settings (graph_insights.accept_link): "pair"
  anything with a task / idea / other item   not linkable (items belong to the dump they were found in)

Dump <-> concept/person wires are also remembered in the free-form setting `graph_blueprint_wires`, so the map can keep
drawing them as "wires you made" (a plain mention and a wired one are otherwise the same data). The list is only a label:
entries whose dump no longer mentions the name are dropped on read.

Trashed and private dumps never take part: they 404 like a dump that does not exist, and are never listed.

  GET    /api/graph/blueprint/links          -> {"links": [{a, b, kind, a_label, b_label}]}
  POST   /api/graph/blueprint/link {a, b, names?}   -> {created, kind, names, links}   (idempotent: created=false when it was already there)
  DELETE /api/graph/blueprint/link?a=&b=     -> {removed, kind, names, links}        (idempotent)
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db, graph
from . import graph_insights as gi
from .routes import _clean_names

router = APIRouter()

WIRES_KEY = "graph_blueprint_wires"          # settings: [{"dump": dump id, "node": "concept:key" | "person:key"}]
NAME_CAP = 12                                # same cap as the dump chips editor (_clean_names)
PAIR_SCORE = 0.999                           # links rows this strong are manual ones (hand-added rows are 1.0)

_LIVE = f"status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}"


class LinkIn(BaseModel):
    a: str
    b: str
    names: list[str] | None = None           # restore these exact spellings (undo of a delete); default: the node's label


def _kind_of(node_id: str) -> str:
    if node_id.startswith("concept:"):
        return "concept"
    if node_id.startswith("person:"):
        return "person"
    return "dump"


def _live_dump(dump_id: str):
    row = db.query_one(f"SELECT id, title, concepts, people FROM dumps WHERE id=? AND {_LIVE}", (dump_id,))
    if not row:
        raise HTTPException(404, "That note isn't on the map any more.")
    return row


def _universe() -> dict[str, str]:
    concepts, people = gi._concept_universe()
    return {**concepts, **people}


def _need_node(universe: dict[str, str], node_id: str) -> str:
    if node_id not in universe:
        raise HTTPException(404, "That concept or person isn't on the map any more.")
    return universe[node_id]


def _kinds(a: str, b: str) -> tuple[str, str, str]:
    """(kind of link, dump id side, hub side) for two node ids. Raises 400 for pairs that cannot be linked."""
    if a == b or not a or not b:
        raise HTTPException(400, "Pick two different nodes")
    ka, kb = _kind_of(a), _kind_of(b)
    if a.startswith("item:") or b.startswith("item:"):
        raise HTTPException(400, "Tasks and ideas belong to the note they were found in, so they can't be linked by hand.")
    if ka == "dump" and kb == "dump":
        return "dump-dump", a, b
    if ka == "dump":
        return f"dump-{kb}", a, b
    if kb == "dump":
        return f"dump-{ka}", b, a
    return "pair", a, b


# ── wires remembered for the map ─────────────────────────────────────────────────────────────

def _read_wires() -> list[dict]:
    d = db.get_setting(WIRES_KEY, [])
    return [x for x in d if isinstance(x, dict) and x.get("dump") and x.get("node")] if isinstance(d, list) else []


def _mark_wire(dump_id: str, node_id: str) -> None:
    wires = _read_wires()
    if not any(w["dump"] == dump_id and w["node"] == node_id for w in wires):
        wires.append({"dump": dump_id, "node": node_id})
        db.set_setting(WIRES_KEY, wires[-2000:])


def _unmark_wire(dump_id: str, node_id: str) -> None:
    wires = _read_wires()
    keep = [w for w in wires if not (w["dump"] == dump_id and w["node"] == node_id)]
    if len(keep) != len(wires):
        db.set_setting(WIRES_KEY, keep)


# ── names on a dump ──────────────────────────────────────────────────────────────────────────

def _column(kind: str) -> str:
    return "concepts" if kind == "concept" else "people"


def _key_of(name: str, kind: str, cmap: dict[str, str] | None) -> str:
    """The map node key of a stored name (spelling variants of a concept share one)."""
    return (cmap.get(name.lower(), name) if cmap is not None else name).lower()


def _names_matching(row, kind: str, node_id: str) -> list[str]:
    cmap = graph.canonical_map("concepts") if kind == "concept" else None
    want = node_id.split(":", 1)[1]
    return [n for n in graph._names(row[_column(kind)]) if _key_of(n, kind, cmap) == want]


def _write_names(dump_id: str, kind: str, names: list[str]) -> None:
    db.execute(f"UPDATE dumps SET {_column(kind)}=? WHERE id=?", (json.dumps(names), dump_id))


# ── the list the map draws ───────────────────────────────────────────────────────────────────

def list_links() -> list[dict]:
    out: list[dict] = []
    titles = {r["id"]: r["title"] or "Untitled" for r in db.query(f"SELECT id, title FROM dumps WHERE {_LIVE}")}
    seen: set[str] = set()
    for r in db.query("SELECT dump_id, related_id FROM links WHERE score >= ?", (PAIR_SCORE,)):
        a, b = r["dump_id"], r["related_id"]
        key = "|".join(sorted((a, b)))
        if a in titles and b in titles and key not in seen:
            seen.add(key)
            out.append({"a": a, "b": b, "kind": "dump-dump", "a_label": titles[a], "b_label": titles[b]})
    universe = _universe()
    rows = {r["id"]: r for r in db.query(f"SELECT id, concepts, people FROM dumps WHERE {_LIVE}")}
    for w in _read_wires():
        row, kind = rows.get(w["dump"]), _kind_of(w["node"])
        if row is None or w["node"] not in universe or kind == "dump":
            continue
        if _names_matching(row, kind, w["node"]):          # the dump still says it
            out.append({"a": w["dump"], "b": w["node"], "kind": f"dump-{kind}", "a_label": titles[w["dump"]], "b_label": universe[w["node"]]})
    for l in gi.manual_links():
        out.append({"a": l["a"], "b": l["b"], "kind": "pair", "a_label": l["a_label"], "b_label": l["b_label"]})
    return out


@router.get("/graph/blueprint/links")
def get_links():
    return {"links": list_links()}


# ── create ───────────────────────────────────────────────────────────────────────────────────

@router.post("/graph/blueprint/link")
def create_link(body: LinkIn):
    kind, a, b = _kinds(body.a.strip(), body.b.strip())
    created, names = False, []
    if kind == "dump-dump":
        _live_dump(a), _live_dump(b)
        if not db.query_one("SELECT 1 FROM links WHERE (dump_id=? AND related_id=?) OR (dump_id=? AND related_id=?)", (a, b, b, a)):
            db.execute("INSERT INTO links VALUES (?,?,?)", (a, b, 1.0))
            created = True
    elif kind == "pair":
        universe = _universe()
        _need_node(universe, a), _need_node(universe, b)
        if any("|".join(sorted((l["a"], l["b"]))) == "|".join(sorted((a, b))) for l in gi.manual_links()):
            created = False
        else:
            try:
                gi.accept_link(a, b)
            except ValueError as e:
                raise HTTPException(400, str(e))
            created = True
    else:
        hub_kind = kind.split("-", 1)[1]
        row = _live_dump(a)
        label = _need_node(_universe(), b)
        if _names_matching(row, hub_kind, b):
            created = False                                  # the dump already has it (maybe under another spelling)
        else:
            have = graph._names(row[_column(hub_kind)])
            add = _clean_names(body.names) if body.names else [label]
            add = [n for n in add if n.lower() not in {h.lower() for h in have}]
            if len(have) + len(add) > NAME_CAP:
                raise HTTPException(400, f"That note already has {len(have)} {_column(hub_kind)}. Remove one first.")
            _write_names(a, hub_kind, have + add)
            created, names = True, add
        if created:
            _mark_wire(a, b)
    return {"ok": True, "created": created, "kind": kind, "names": names, "links": list_links()}


# ── remove ───────────────────────────────────────────────────────────────────────────────────

@router.delete("/graph/blueprint/link")
def remove_link(a: str, b: str):
    kind, a, b = _kinds(a.strip(), b.strip())
    removed, names = False, []
    if kind == "dump-dump":
        _live_dump(a), _live_dump(b)
        cur = db.query_one("SELECT 1 FROM links WHERE (dump_id=? AND related_id=?) OR (dump_id=? AND related_id=?)", (a, b, b, a))
        if cur:
            db.execute("DELETE FROM links WHERE (dump_id=? AND related_id=?) OR (dump_id=? AND related_id=?)", (a, b, b, a))
            removed = True
    elif kind == "pair":
        universe = _universe()
        _need_node(universe, a), _need_node(universe, b)
        key = "|".join(sorted((a, b)))
        if any("|".join(sorted((l["a"], l["b"]))) == key for l in gi.manual_links()):
            gi.remove_link(a, b)
            removed = True
    else:
        hub_kind = kind.split("-", 1)[1]
        row = _live_dump(a)
        _need_node(_universe(), b)
        names = _names_matching(row, hub_kind, b)
        if names:
            drop = {n.lower() for n in names}
            _write_names(a, hub_kind, [n for n in graph._names(row[_column(hub_kind)]) if n.lower() not in drop])
            removed = True
        _unmark_wire(a, b)
    return {"ok": True, "removed": removed, "kind": kind, "names": names, "links": list_links()}
