import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, graph, item_types
from app.main import create_app


def _dump(did, title, concepts=(), people=(), created=None):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, concepts, people) VALUES (?,?,?,?,?,'ready',?,?)",
               (did, created or db.now_iso(), "freeform", "text of " + title, title, json.dumps(list(concepts)), json.dumps(list(people))))


@pytest.fixture
def data():
    create_app()
    old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    _dump("g1", "Work fog", concepts=["Work Fog", "sleep"], people=["Sam"])
    _dump("g2", "Sleep plan", concepts=["sleep"], created=old)
    _dump("g3", "Unrelated", concepts=["cooking"])
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('gi1','g1','task','fix sleep','suggested',0,?)", (db.now_iso(),))
    db.execute("INSERT OR REPLACE INTO links VALUES ('g1','g3',0.8)")
    yield
    for d in ("g1", "g2", "g3"):
        db.execute("DELETE FROM dumps WHERE id=?", (d,))
    db.execute("DELETE FROM links WHERE dump_id IN ('g1','g2','g3')")
    db.execute("DELETE FROM settings WHERE key LIKE 'resurface:%'")


def test_types_and_item_nodes(data):
    ids = [t["id"] for t in graph.types()]
    assert ids[:3] == ["dump", "concept", "person"] and "task" in ids
    g = graph.build(items=False)
    assert not any(n["type"] == "task" for n in g["nodes"])
    g = graph.build(items=True)
    item_node = next(n for n in g["nodes"] if n["id"] == "item:gi1")
    assert item_node["type"] == "task" and item_node["dump"] == "g1"
    assert {"source": "item:gi1", "target": "g1", "type": "in"} in g["edges"]


def test_concepts_people_browsers(data):
    sleep = next(c for c in graph.concepts() if c["name"].lower() == "sleep")
    assert sleep["count"] == 2
    assert [d["id"] for d in graph.for_concept("SLEEP")] == ["g1", "g2"]
    assert [d["id"] for d in graph.for_person("sam")] == ["g1"]


def test_backlinks(data):
    b = graph.backlinks("g1")
    assert [d["id"] for d in b["similar"]] == ["g3"]
    assert b["via_concepts"][0]["name"] == "sleep" and [d["id"] for d in b["via_concepts"][0]["dumps"]] == ["g2"]


def test_today_and_resurface(data):
    t = graph.today()
    assert {"g1", "g3"} <= {d["id"] for d in t["dumps"]} and "g2" not in {d["id"] for d in t["dumps"]}
    assert t["dumps"][0]["items"] or t["dumps"][1]["items"]
    r = graph.resurface()
    assert r and r["dump"]["id"] == "g2" and r["reason"] in ("from a while ago",) or "on this day" in r["reason"]
    assert graph.resurface()["dump"]["id"] == r["dump"]["id"]  # cached for the day


def test_api(data):
    client = TestClient(create_app())
    assert client.get("/api/graph/types").status_code == 200
    assert any(n["id"] == "item:gi1" for n in client.get("/api/graph?items=1").json()["nodes"])
    assert client.get("/api/concepts/sleep").json()[0]["id"] == "g1"
    assert client.get("/api/dumps/g1/backlinks").json()["similar"][0]["id"] == "g3"
    assert client.get("/api/today").json()["date"] == date.today().isoformat()
    assert client.get("/api/resurface").status_code == 200


def test_base_node_kinds_can_be_renamed_recolored_and_reset(data):
    client = TestClient(create_app())
    try:
        r = client.put("/api/graph/types/person", json={"label": "Friends", "color": "#ff8800"})
        assert r.status_code == 200 and r.json()["label"] == "Friends" and r.json()["color"] == "#ff8800"
        by_id = {t["id"]: t for t in client.get("/api/graph/types").json()}
        assert by_id["person"]["label"] == "Friends" and by_id["person"]["color"] == "#ff8800"
        assert by_id["concept"]["label"] == "Concepts"                       # others untouched
        # Partial update keeps the other field.
        client.put("/api/graph/types/person", json={"label": "Crew"})
        assert next(t for t in graph.types() if t["id"] == "person")["color"] == "#ff8800"
        # Validation: bad colour, empty/long label, and non-base ids are rejected.
        assert client.put("/api/graph/types/person", json={"color": "purple"}).status_code == 400
        assert client.put("/api/graph/types/person", json={"label": "  "}).status_code == 400
        assert client.put("/api/graph/types/person", json={"label": "x" * 31}).status_code == 400
        assert client.put("/api/graph/types/task", json={"label": "Nope"}).status_code == 400
        assert client.delete("/api/graph/types/person").json()["label"] == "People"
        assert next(t for t in graph.types() if t["id"] == "person")["color"] == "blue"
        assert client.delete("/api/graph/types/task").status_code == 400
    finally:
        db.execute("DELETE FROM settings WHERE key=?", (graph.BASE_KEY,))
