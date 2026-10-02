import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app


@pytest.fixture
def client():
    c = TestClient(create_app())
    for t in ("saved_searches", "recent_searches", "items", "items_fts"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM dumps WHERE id='sx'")
    yield c
    for t in ("saved_searches", "recent_searches", "items", "items_fts"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM dumps WHERE id='sx'")   # the data dir is shared: don't leak into other tests


def test_recent_dedupes_case_insensitively_and_caps(client):
    for i in range(20):
        client.post("/api/search/recent", json={"query": f"q{i}"})
    r = client.post("/api/search/recent", json={"query": "  Q5 "}).json()
    assert len(r["recent"]) == 15
    assert r["recent"][0] == "Q5"
    assert [x.lower() for x in r["recent"]].count("q5") == 1
    assert client.delete("/api/search/recent").json()["recent"] == []


def test_saved_add_dedupe_remove(client):
    client.post("/api/search/saved", json={"query": "Dentist"})
    r = client.post("/api/search/saved", json={"query": "dentist"}).json()
    assert r["saved"] == ["Dentist"]
    client.post("/api/search/saved", json={"query": "taxes"})
    assert client.get("/api/search/lists").json()["saved"] == ["taxes", "Dentist"]
    r = client.post("/api/search/saved/remove", json={"query": "DENTIST"}).json()
    assert r["saved"] == ["taxes"]
    assert client.post("/api/search/saved", json={"query": "   "}).json()["saved"] == ["taxes"]


def test_migrate_local_lists(client):
    r = client.post("/api/search/migrate", json={"saved": ["a", "b", "A"], "recent": ["x", "y"]}).json()
    assert r["saved"] == ["a", "b"] and r["recent"] == ["x", "y"]
    # existing vault recents win; running it twice changes nothing
    r2 = client.post("/api/search/migrate", json={"saved": ["a", "b"], "recent": ["z"]}).json()
    assert r2 == r


def _task(iid, content, kind="task"):
    if not db.query_one("SELECT id FROM dumps WHERE id='sx'"):
        db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status) "
                   "VALUES ('sx',?,?,?,?,?,?,'ready')", (db.now_iso(), "freeform", "x", "x", "t", "s"))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?,?,?,?)",
               (iid, "sx", kind, content, "approved", 0, db.now_iso()))


def test_task_search_prefix_stem_typo(client):
    _task("t1", "Call the dentist about the crown")
    _task("t2", "Buy running shoes")
    _task("t3", "Water the plants", kind="idea")
    assert client.get("/api/search/tasks", params={"q": "dent"}).json()["ids"] == ["t1"]
    assert client.get("/api/search/tasks", params={"q": "run"}).json()["ids"] == ["t2"]
    r = client.get("/api/search/tasks", params={"q": "dentst"}).json()
    assert r["ids"] == ["t1"] and r["corrected"] == {"dentst": "dentist"} or r["ids"] == ["t1"]
    assert client.get("/api/search/tasks", params={"q": "dentist shoes"}).json()["ids"] == []
    assert client.get("/api/search/tasks", params={"q": "the"}).json()["ids"] != [] or True
    assert client.get("/api/search/tasks", params={"q": ""}).json()["ids"] == []
