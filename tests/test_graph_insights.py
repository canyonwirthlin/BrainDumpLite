import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, graph_insights as gi
from app.main import create_app

NOW = datetime.now(timezone.utc)


def _dump(did, title, concepts=(), people=(), created=None, private=0, deleted=None, text=None, embedding=None):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, concepts, people, is_private, deleted_at, embedding) "
               "VALUES (?,?,?,?,?,'ready',?,?,?,?,?)",
               (did, created or db.now_iso(), "freeform", text or ("text of " + title), title, json.dumps(list(concepts)),
                json.dumps(list(people)), private, deleted, json.dumps(embedding) if embedding else None))


def _task(iid, did, content, due=None, done=0, status="approved", kind="task"):
    db.execute("INSERT INTO items (id, dump_id, kind, content, due_date, status, done, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (iid, did, kind, content, due, status, done, db.now_iso()))


def _wipe():
    with db.lock():
        c = db.conn()
        for table in ("items", "links", "dumps"):
            c.execute(f"DELETE FROM {table} WHERE id NOT IN ('{db.MANUAL_DUMP_ID}')" if table == "dumps" else f"DELETE FROM {table}")
        c.execute("DELETE FROM settings WHERE key IN (?,?)", (gi.MANUAL_KEY, gi.DISMISS_KEY))
        c.commit()


@pytest.fixture
def vault():
    create_app()
    _wipe()
    yield
    _wipe()


@pytest.fixture
def client(vault):
    return TestClient(create_app())


def _iso(days_ago):
    return (NOW - timedelta(days=days_ago)).isoformat()


# ── empty vault ──────────────────────────────────────────────────────────────────────────────

def test_empty_vault_returns_empty_lists(client):
    assert client.get("/api/graph/insights/lonely").json() == {"count": 0, "total": 0, "dumps": []}
    j = client.get("/api/graph/insights/loops").json()
    assert j["dumps"] == {} and j["total_open"] == 0 and j["total_overdue"] == 0
    assert client.get("/api/graph/insights/suggested-links").json() == {"links": []}
    assert client.get("/api/graph/insights/links").json() == {"links": []}


# ── open loops ───────────────────────────────────────────────────────────────────────────────

def test_loops_counts_overdue_and_excludes_done_rejected_trashed_private(client):
    today = date.today()
    _dump("l1", "Plan trip", ["Travel"])
    _dump("l2", "Quiet", ["Zen"])
    _dump("ltrash", "Trashed", ["Travel"], deleted=db.now_iso())
    _dump("lpriv", "Private", ["Travel"], private=1)
    late = (today - timedelta(days=3)).isoformat()
    soon = (today + timedelta(days=3)).isoformat()
    _task("t1", "l1", "Book flights", due=late)
    _task("t2", "l1", "Pack bag", due=soon)
    _task("t3", "l1", "Already done", due=late, done=1)
    _task("t4", "l1", "Rejected idea", status="rejected")
    _task("t5", "l1", "An idea, not a task", kind="idea")
    _task("t6", "l1", "No due date")
    _task("t7", "ltrash", "Trashed task", due=late)
    _task("t8", "lpriv", "Private task", due=late)
    j = client.get("/api/graph/insights/loops").json()
    assert set(j["dumps"]) == {"l1"}
    e = j["dumps"]["l1"]
    assert e["open"] == 3 and e["overdue"] == 1
    assert [t["title"] for t in e["tasks"]] == ["Book flights", "Pack bag", "No due date"]   # overdue first, then by date
    assert e["tasks"][0]["overdue"] is True and e["tasks"][1]["overdue"] is False
    assert j["total_open"] == 3 and j["total_overdue"] == 1


def test_loops_task_titles_capped_at_five(client):
    _dump("l1", "Busy", ["Work"])
    for i in range(8):
        _task(f"t{i}", "l1", f"Task {i}")
    e = client.get("/api/graph/insights/loops").json()["dumps"]["l1"]
    assert e["open"] == 8 and len(e["tasks"]) == 5


# ── lonely dumps ─────────────────────────────────────────────────────────────────────────────

def test_lonely_finds_orphans_and_candidates(client):
    # a connected group sharing concepts, a linked pair, and two orphans that talk about the same thing
    _dump("c1", "Running log", ["Running", "Sleep"], text="Ran along the river this morning and my knee hurt on the hills")
    _dump("c2", "More running", ["Running"], text="Training plan for the river race, hills on Saturday")
    _dump("c3", "Sleep notes", ["Sleep"], text="Bedtime routine and caffeine")
    _dump("c4", "Both", ["Running", "Sleep"], text="Late run then bad sleep")
    _dump("k1", "Linked A", ["Alpha"])
    _dump("k2", "Linked B", ["Beta"])
    db.execute("INSERT INTO links VALUES ('k1','k2',0.8)")
    _dump("o1", "Knee pain on hills", [], text="My knee hurts whenever I run the river hills, should see someone about the knee")
    _dump("o2", "Cooking idea", [], text="Soup recipes with lentils")
    _dump("o3", "Soup again", [], text="Lentils soup recipes for winter")
    j = client.get("/api/graph/insights/lonely").json()
    ids = {d["id"] for d in j["dumps"]}
    assert ids == {"o1", "o2", "o3"} and j["count"] == 3 and j["total"] == 9
    by = {d["id"]: d for d in j["dumps"]}
    assert by["o1"]["candidates"][0]["id"] in ("c1", "c2") and by["o1"]["candidates"][0]["via"] == "words"
    assert [c["id"] for c in by["o2"]["candidates"]][:1] == ["o3"]
    assert all(len(d["candidates"]) <= 3 for d in j["dumps"])
    assert all(c["id"] != d["id"] for d in j["dumps"] for c in d["candidates"])


def test_lonely_ignores_trashed_and_private_dumps_everywhere(client):
    _dump("a", "Alone", [], text="Quiet lentils soup thoughts")
    _dump("b", "Shares", ["Soup"], text="Lentils soup thoughts")
    _dump("trash", "Trashed", ["Soup"], deleted=db.now_iso(), text="Quiet lentils soup thoughts")
    _dump("priv", "Private", ["Soup"], private=1, text="Quiet lentils soup thoughts")
    db.execute("INSERT INTO links VALUES ('a','trash',0.9)")      # a link to a trashed dump is not a connection
    j = client.get("/api/graph/insights/lonely").json()
    ids = {d["id"] for d in j["dumps"]}
    assert "trash" not in ids and "priv" not in ids
    assert "a" in ids
    cand_ids = {c["id"] for d in j["dumps"] for c in d["candidates"]}
    assert not cand_ids & {"trash", "priv"}


def test_lonely_prefers_embeddings_when_present(client):
    _dump("e0", "Hub", ["Hub"]); _dump("e0b", "Hub two", ["Hub"])
    _dump("e1", "Lonely one", [], text="soup lentils", embedding=[1.0, 0.0, 0.0])
    _dump("e2", "Near in meaning", [], text="gardening tomatoes soup", embedding=[0.95, 0.05, 0.0])
    _dump("e3", "Far in meaning", [], text="soup lentils soup lentils soup", embedding=[0.0, 1.0, 0.0])
    j = client.get("/api/graph/insights/lonely").json()
    e1 = next(d for d in j["dumps"] if d["id"] == "e1")
    assert e1["candidates"][0]["id"] == "e2" and e1["candidates"][0]["via"] == "meaning"
    assert "e3" not in {c["id"] for c in e1["candidates"]}      # cosine below the floor


# ── suggested links ──────────────────────────────────────────────────────────────────────────

def _suggestion_vault():
    """Running and Hydration never share a dump, but both appear next to Marathon and Coach Dan."""
    _dump("s1", "r1", ["Running", "Marathon"], people=["Coach Dan"])
    _dump("s2", "r2", ["Running", "Training plan"], people=["Coach Dan"])
    _dump("s3", "h1", ["Hydration", "Marathon"], people=["Coach Dan"])
    _dump("s4", "h2", ["Hydration", "Training plan"])
    _dump("s5", "x", ["Taxes"])


def test_suggested_links_pair_up_concepts_that_never_share_a_dump(client):
    _suggestion_vault()
    links = client.get("/api/graph/insights/suggested-links").json()["links"]
    pairs = {frozenset((l["a"], l["b"])) for l in links}
    assert frozenset(("concept:running", "concept:hydration")) in pairs
    top = links[0]
    assert top["score"] == 1.0 and top["reason"] and top["shared"]
    assert "never been in the same dump" in top["reason"]
    # concepts that already share a dump are never suggested, nor are one-off concepts
    assert frozenset(("concept:running", "concept:marathon")) not in pairs
    assert not any("concept:taxes" in (l["a"], l["b"]) for l in links)
    assert len(links) <= gi.SUGGEST_CAP


def test_suggested_links_skip_trashed_and_private_dumps(client):
    _dump("s1", "r1", ["Running", "Marathon"])
    _dump("s2", "r2", ["Running", "Training plan"])
    _dump("s3", "h1", ["Hydration", "Marathon"])
    _dump("s4", "h2", ["Hydration", "Training plan"])
    # only trashed/private dumps would make Sleeping and Running look related
    _dump("t1", "t", ["Sleeping", "Marathon"], deleted=db.now_iso())
    _dump("t2", "t", ["Sleeping", "Marathon"], private=1)
    _dump("t3", "t", ["Sleeping", "Training plan"], private=1)
    links = client.get("/api/graph/insights/suggested-links").json()["links"]
    assert not any("sleeping" in l["a"] or "sleeping" in l["b"] for l in links)


def test_accept_and_dismiss_persist_and_hide_suggestions(client):
    _suggestion_vault()
    r = client.post("/api/graph/insights/links", json={"a": "concept:hydration", "b": "concept:running"})
    assert r.status_code == 200
    assert r.json()["links"][0]["a"] == "concept:hydration" and r.json()["links"][0]["b"] == "concept:running"
    # idempotent, order-insensitive
    client.post("/api/graph/insights/links", json={"a": "concept:running", "b": "concept:hydration"})
    assert len(client.get("/api/graph/insights/links").json()["links"]) == 1
    sug = client.get("/api/graph/insights/suggested-links").json()["links"]
    assert not any({l["a"], l["b"]} == {"concept:running", "concept:hydration"} for l in sug)
    assert db.get_setting(gi.MANUAL_KEY)[0]["at"]
    # unlink
    client.delete("/api/graph/insights/links", params={"a": "concept:hydration", "b": "concept:running"})
    assert client.get("/api/graph/insights/links").json()["links"] == []
    assert any({l["a"], l["b"]} == {"concept:running", "concept:hydration"}
               for l in client.get("/api/graph/insights/suggested-links").json()["links"])
    # dismiss: never suggested again, until reset
    assert client.post("/api/graph/insights/dismiss", json={"a": "concept:running", "b": "concept:hydration"}).json()["dismissed"] == 1
    assert db.get_setting(gi.DISMISS_KEY) == ["concept:hydration|concept:running"]
    sug = client.get("/api/graph/insights/suggested-links").json()["links"]
    assert not any({l["a"], l["b"]} == {"concept:running", "concept:hydration"} for l in sug)
    client.delete("/api/graph/insights/dismissed")
    assert any({l["a"], l["b"]} == {"concept:running", "concept:hydration"}
               for l in client.get("/api/graph/insights/suggested-links").json()["links"])


def test_accepting_a_link_never_touches_dumps(client):
    _suggestion_vault()
    before = [tuple(r) for r in db.query("SELECT id, title, raw_text, concepts, people FROM dumps ORDER BY id")]
    client.post("/api/graph/insights/links", json={"a": "concept:hydration", "b": "concept:running"})
    client.post("/api/graph/insights/dismiss", json={"a": "concept:taxes", "b": "concept:running"})
    after = [tuple(r) for r in db.query("SELECT id, title, raw_text, concepts, people FROM dumps ORDER BY id")]
    assert before == after


def test_links_reject_unknown_or_identical_nodes(client):
    _suggestion_vault()
    assert client.post("/api/graph/insights/links", json={"a": "concept:running", "b": "concept:running"}).status_code == 400
    assert client.post("/api/graph/insights/links", json={"a": "concept:running", "b": "concept:nonexistent"}).status_code == 400
    assert client.post("/api/graph/insights/dismiss", json={"a": "", "b": "concept:running"}).status_code == 400


def test_manual_links_drop_out_when_a_node_disappears(client):
    _suggestion_vault()
    client.post("/api/graph/insights/links", json={"a": "concept:hydration", "b": "concept:running"})
    db.execute("UPDATE dumps SET deleted_at=? WHERE concepts LIKE '%Hydration%'", (db.now_iso(),))
    assert client.get("/api/graph/insights/links").json()["links"] == []
