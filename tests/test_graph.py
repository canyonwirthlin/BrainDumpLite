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


# ── Concept grouping: "internships" vs "internship applications" (real case) ──

@pytest.fixture
def internships():
    create_app()
    _dump("gi1", "Balancing hobbies and work", concepts=["home lab", "internship applications", "exam"])
    _dump("gi2", "Mixed progress and gratitude", concepts=["Internships", "finances", "home lab"])
    _dump("gi3", "Unrelated", concepts=["cooking"])
    yield
    db.execute("DELETE FROM dumps WHERE id IN ('gi1','gi2','gi3')")


def test_similar_concept_names_fold_into_one_group(internships):
    cmap = graph.canonical_map("concepts")
    assert cmap["internship applications"] == cmap["internships"] == "Internships"
    assert cmap["cooking"] == "cooking"           # unrelated names stay themselves
    tally = {c["name"]: c["count"] for c in graph.concepts()}
    assert tally["Internships"] == 2 and "internship applications" not in tally


def test_grouped_concepts_share_a_node_and_browse_together(internships):
    g = graph.build()
    concept_nodes = [n for n in g["nodes"] if n["type"] == "concept" and "internship" in n["label"].lower()]
    assert len(concept_nodes) == 1
    mentions = {e["source"] for e in g["edges"] if e["target"] == concept_nodes[0]["id"]}
    assert mentions == {"gi1", "gi2"}
    # either spelling opens the same group
    assert {d["id"] for d in graph.for_concept("internship applications")} == {"gi1", "gi2"}
    assert {d["id"] for d in graph.for_concept("Internships")} == {"gi1", "gi2"}
    via = graph.backlinks("gi1")["via_concepts"]
    assert [v["name"] for v in via if "ntern" in v["name"]] == ["Internships"]


def test_short_and_unrelated_names_do_not_fold():
    create_app()
    _dump("gs1", "a", concepts=["ai", "ai safety"])
    _dump("gs2", "b", concepts=["game design", "game night"])
    try:
        cmap = graph.canonical_map("concepts")
        assert cmap["ai safety"] == "ai safety"       # "ai" is too short to absorb anything
        assert cmap["game design"] == "game design" and cmap["game night"] == "game night"
    finally:
        db.execute("DELETE FROM dumps WHERE id IN ('gs1','gs2')")


def test_known_concepts_hint_lists_existing_names(internships):
    from app import pipeline
    hint = pipeline._known_concepts_hint("some-new-dump")
    low = hint.lower()
    assert "home lab" in low and "internships" in low and "internship applications" in low
    assert pipeline._known_concepts_hint("gi1").count("Internships") == 1
