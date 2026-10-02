"""JSON export -> fresh vault -> import round trip, idempotency and id collisions."""
import io
import json

import pytest
from fastapi.testclient import TestClient

from app import dataio, db
from app.main import create_app

TABLES = [t[0] for t in dataio.TABLES]


def _wipe():
    for t in reversed(TABLES):
        db.execute(f"DELETE FROM {t}")
    for t in ("dumps_fts", "items_fts"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM settings WHERE key IN ('name_aliases','theme','secret:todoist','app_lock')")


@pytest.fixture(autouse=True)
def _vault():
    db.init_db()
    _wipe()
    yield
    _wipe()


def _seed():
    db.execute("INSERT INTO dumps (id, created_at, raw_text, clean_text, title, summary, status, people, concepts, embedding, is_private, deleted_at, pinned) "
               "VALUES ('d1','2026-09-10T10:00:00+00:00','raw one','clean one','One','sum','ready','[\"Ann\"]','[\"Gym\"]','[0.1,0.2]',1,NULL,1)")
    db.execute("INSERT INTO dumps (id, created_at, raw_text, title, status, deleted_at) VALUES ('d2','2026-09-11T10:00:00+00:00','raw two','Two','ready','2026-09-12T00:00:00+00:00')")
    db.execute("INSERT INTO task_folders (id, name, sort, created_at) VALUES ('f1','Home',1,'2026-09-01T00:00:00+00:00')")
    db.execute("INSERT INTO items (id, dump_id, kind, content, detail, priority, status, done, created_at, est_minutes, folder_id, recurrence, tags, pinned) "
               "VALUES ('i1','d1','task','buy milk','tiny',3,'approved',1,'2026-09-10T10:00:00+00:00',15,'f1','{\"every\":1,\"unit\":\"week\"}','[\"home\"]',1)")
    db.execute("INSERT INTO links (dump_id, related_id, score) VALUES ('d1','d2',1.0)")
    db.execute("INSERT INTO habits (id, title, frequency, target, created_at) VALUES ('h1','Walk','daily',1,'2026-09-01T00:00:00+00:00')")
    db.execute("INSERT INTO habit_log (habit_id, day) VALUES ('h1','2026-09-10')")
    db.execute("INSERT INTO reflections (period_key, content, created_at) VALUES ('daily:2026-09-10','good day','2026-09-10T20:00:00+00:00')")
    db.execute("INSERT INTO saved_searches (id, query, created_at) VALUES ('s1','gym','2026-09-01T00:00:00+00:00')")
    db.execute("INSERT INTO dumps_fts (id, body) VALUES ('d1','One\nsum\nclean one')")
    db.set_setting("name_aliases", {"ann": "Anna"})
    db.set_setting("secret:todoist", "dpapi:AAAA")


def _snapshot():
    return {t: sorted(json.dumps(dict(r), sort_keys=True) for r in db.query(f"SELECT * FROM {t}")) for t in TABLES}


def test_round_trip_is_lossless_and_keeps_private_and_deleted():
    _seed()
    before = _snapshot()
    data = dataio.export_data()
    assert "secret:todoist" not in data["settings"] and data["settings"]["name_aliases"] == {"ann": "Anna"}
    d1 = next(r for r in data["tables"]["dumps"]["rows"] if r["id"] == "d1")
    assert d1["is_private"] == 1 and d1["pinned"] == 1
    assert next(r for r in data["tables"]["dumps"]["rows"] if r["id"] == "d2")["deleted_at"]
    data = json.loads(json.dumps(data))      # through the wire format

    _wipe()
    assert db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"] == 0
    rep = dataio.import_data(data)
    assert rep["added"] > 0
    assert _snapshot() == before
    assert db.get_setting("name_aliases") == {"ann": "Anna"}
    assert db.query_one("SELECT 1 FROM dumps_fts WHERE id='d1'") and db.query_one("SELECT 1 FROM items_fts WHERE item_id='i1'")


def test_import_is_idempotent():
    _seed()
    data = json.loads(json.dumps(dataio.export_data()))
    before = _snapshot()
    rep = dataio.import_data(data)               # into the same vault: everything already there
    assert rep["added"] == 0 and _snapshot() == before
    _wipe()
    dataio.import_data(data)
    once = _snapshot()
    assert dataio.import_data(data)["added"] == 0
    assert _snapshot() == once


def test_id_collision_keeps_both_and_second_import_adds_nothing():
    _seed()
    data = json.loads(json.dumps(dataio.export_data()))
    # a different dump that happens to use the id d1 locally
    db.execute("UPDATE dumps SET raw_text='locally edited', created_at='2026-01-01T00:00:00+00:00' WHERE id='d1'")
    rep = dataio.import_data(data)
    assert rep["tables"]["dumps"]["renamed"] == 1
    assert db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"] == 3
    copy = db.query_one("SELECT id FROM dumps WHERE raw_text='raw one'")
    assert copy["id"] != "d1"
    # its item follows the new id
    assert db.query_one("SELECT 1 FROM items WHERE dump_id=? AND content='buy milk'", (copy["id"],))
    assert dataio.import_data(data)["added"] == 0
    assert db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"] == 3


def test_export_filters_and_bad_files():
    _seed()
    d = dataio.export_data(include_private=False, include_deleted=False)
    assert d["tables"]["dumps"]["rows"] == [] and d["tables"]["items"]["rows"] == []
    with pytest.raises(ValueError):
        dataio.import_data({"hello": 1})
    with pytest.raises(ValueError):
        dataio.import_data({"format": dataio.FORMAT, "version": 99})


def test_endpoints_round_trip_and_markdown():
    _seed()
    c = TestClient(create_app())
    r = c.get("/api/data/export.json")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    before = _snapshot()
    _wipe()
    up = c.post("/api/data/import", files={"file": ("x.json", io.BytesIO(r.content), "application/json")})
    assert up.status_code == 200 and up.json()["added"] > 0
    assert _snapshot() == before
    assert c.post("/api/data/import", files={"file": ("x.json", io.BytesIO(b"nope"), "application/json")}).status_code == 400
    assert c.get("/api/data/export.md").headers["content-type"] == "application/zip"
