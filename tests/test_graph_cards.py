"""Brain map hover cards: GET /api/graph/card/{node_id}."""
import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import db, graph, graph_cards
from app.main import create_app

IDS = ("hc1", "hc2", "hc3", "hc-trash", "hc-priv")


def _dump(did, title, concepts=(), people=(), created="2026-05-01T10:00:00+00:00", summary=None, text=None, **extra):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?)",
               (did, created, "freeform", text or "raw " + title, text, title, summary, json.dumps(list(concepts)), json.dumps(list(people))))
    if extra.get("trashed"):
        db.execute("UPDATE dumps SET deleted_at=? WHERE id=?", (db.now_iso(), did))
    if extra.get("private"):
        db.execute("UPDATE dumps SET is_private=1 WHERE id=?", (did,))


@pytest.fixture
def client():
    c = TestClient(create_app())
    _dump("hc1", "Internship hunt", concepts=["Internship", "Resume"], people=["Sam"], created="2026-03-01T10:00:00+00:00",
          summary="Applied to three places and need to follow up next week.")
    _dump("hc2", "More applications", concepts=["internships", "Interview prep"], people=["Sam", "Ana"], created="2026-04-01T10:00:00+00:00")
    _dump("hc3", "Cooking", concepts=["Cooking"], created="2026-04-02T10:00:00+00:00")
    _dump("hc-trash", "Trashed one", concepts=["TrashOnlyConcept", "Internship"], people=["Ghost"], trashed=True)
    _dump("hc-priv", "Private one", concepts=["PrivOnlyConcept", "Internship"], people=["Hidden"], private=True)
    db.execute("INSERT INTO items (id, dump_id, kind, content, detail, status, done, created_at) VALUES ('hci1','hc1','task','Email the recruiter','Short note','approved',0,?)", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('hci2','hc1','task','Update resume','suggested',1,?)", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('hci3','hc1','idea','Rejected idea','rejected',0,?)", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('hci-t','hc-trash','task','trashed task','approved',0,?)", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('hci-p','hc-priv','task','private task','approved',0,?)", (db.now_iso(),))
    yield c
    for d in IDS:
        db.execute("DELETE FROM dumps WHERE id=?", (d,))
    db.execute("DELETE FROM items WHERE dump_id IN ('hc1','hc2','hc3','hc-trash','hc-priv')")


def card(client, node_id):
    return client.get("/api/graph/card/" + quote(node_id, safe=":"))


def test_dump_card(client):
    r = card(client, "hc1")
    assert r.status_code == 200
    j = r.json()
    assert j["type"] == "dump" and j["label"] == "Internship hunt"
    assert j["snippet"].startswith("Applied to three places")
    assert j["concepts"][0].lower().startswith("internship") and j["concepts"][1] == "Resume"
    assert j["people"] == ["Sam"]
    assert j["open_tasks"] == 1            # the done task and the rejected idea don't count


def test_dump_snippet_falls_back_and_truncates(client):
    db.execute("UPDATE dumps SET summary=NULL, clean_text=? WHERE id='hc3'", ("word " * 200,))
    j = card(client, "hc3").json()
    assert len(j["snippet"]) <= graph_cards.SNIPPET_CHARS + 2 and j["snippet"].endswith("…")


def test_concept_card_resolves_spelling_variants(client):
    # the map's own node id for the variant group
    ids = {n["id"] for n in graph.build()["nodes"]}
    cid = next(i for i in ids if i.startswith("concept:intern"))
    j = card(client, cid).json()
    assert j["type"] == "concept" and j["count"] == 2        # "Internship" and "internships" are one concept
    assert j["first_at"].startswith("2026-03-01") and j["last_at"].startswith("2026-04-01")
    assert {r["name"] for r in j["related"]} == {"Resume", "Interview prep"}
    assert [x["name"] for x in j["people"]][0] == "Sam"
    assert [d["id"] for d in j["latest"]] == ["hc2", "hc1"]  # newest first
    # a variant spelled differently in the id still lands on the same group
    assert card(client, "concept:internships").json()["count"] == 2


def test_person_card(client):
    j = card(client, "person:sam").json()
    assert j["type"] == "person" and j["label"] == "Sam" and j["count"] == 2
    assert {x["name"] for x in j["people"]} == {"Ana"}
    assert {r["name"] for r in j["related"]} >= {"Resume", "Interview prep"}


def test_item_card(client):
    j = card(client, "item:hci1").json()
    assert j["type"] == "task" and j["kind_label"] and j["text"] == "Email the recruiter"
    assert j["status"] == "approved" and j["dump_id"] == "hc1" and j["dump_title"] == "Internship hunt"
    assert card(client, "item:hci2").json()["status"] == "done"


def test_unknown_trashed_and_private_are_404(client):
    for nid in ("nope", "concept:does not exist", "person:", "item:nope", "item:hci3",       # rejected item
                "hc-trash", "hc-priv", "concept:trashonlyconcept", "concept:privonlyconcept",
                "person:ghost", "person:hidden", "item:hci-t", "item:hci-p"):
        assert card(client, nid).status_code == 404, nid


def test_cards_see_writes_straight_away(client):
    assert card(client, "concept:cooking").json()["count"] == 1
    assert card(client, "concept:baking").status_code == 404
    graph.merge_names("concept", ["Cooking"], "Baking")      # a merge rewrites dumps; the cached table must not hide it
    assert card(client, "concept:baking").json()["count"] == 1
    assert card(client, "concept:cooking").status_code == 404
    db.execute("UPDATE dumps SET deleted_at=? WHERE id='hc3'", (db.now_iso(),))
    assert card(client, "concept:baking").status_code == 404


def test_concept_with_slashes_and_colons_in_name(client):
    _dump("hc3b", "Odd names", concepts=["AC/DC: live", "R&D"])
    try:
        assert card(client, "concept:ac/dc: live").json()["count"] == 1
        assert card(client, "concept:r&d").json()["label"] == "R&D"
    finally:
        db.execute("DELETE FROM dumps WHERE id='hc3b'")
