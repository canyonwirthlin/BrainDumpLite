import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import ai, db, digest
from app.main import create_app


@pytest.fixture
def client():
    return TestClient(create_app())


def _dump(did, title="t", private=0, trashed=False):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people, is_private, deleted_at) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?)",
               (did, datetime.now(timezone.utc).isoformat(), "freeform", "some words", "some words", title, "sum of " + title,
                json.dumps(["sleep"]), "[]", private, db.now_iso() if trashed else None))


def _clean():
    db.execute("DELETE FROM dumps WHERE id LIKE 'dg-%'")
    db.execute("DELETE FROM reflections")


def test_narrative_ai_cache_and_exclusions(client, monkeypatch):
    _clean()
    _dump("dg-1", "Visible dump")
    _dump("dg-2", "Secret dump", private=1)
    _dump("dg-3", "Trashed dump", trashed=True)
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('dg-i1','dg-1','task','buy milk','approved',0,?)", (db.now_iso(),))
    seen = []
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "chat", lambda system, user, **k: (seen.append(user), "## Themes\n- sleep")[1])
    r = client.post("/api/digest/weekly/narrative", json={}).json()
    assert r["content"].startswith("## Themes") and not r["cached"]
    assert "Visible dump" in seen[0] and "buy milk" in seen[0]
    assert "Secret" not in seen[0] and "Trashed" not in seen[0]
    row = db.query_one("SELECT content FROM reflections WHERE period_key=?", (r["key"],))
    assert r["key"].startswith("weekly:") and row["content"].startswith(digest.MARKER)
    again = client.post("/api/digest/weekly/narrative", json={}).json()
    assert again["cached"] and len(seen) == 1
    forced = client.post("/api/digest/weekly/narrative", json={"force": True}).json()
    assert not forced["cached"] and len(seen) == 2
    assert client.get("/api/digest/weekly/narrative").json()["content"].startswith("## Themes")
    _clean()


def test_no_ai_fallback_and_old_reflect_cache_ignored(client, monkeypatch):
    _clean()
    _dump("dg-1")
    monkeypatch.setattr(ai, "available", lambda: False)
    key = client.get("/api/digest/weekly/narrative").json()["key"]
    db.execute("INSERT INTO reflections VALUES (?,?,?)", (key, "old /reflect text", db.now_iso()))
    r = client.post("/api/digest/weekly/narrative", json={}).json()
    assert r["content"] is None and r["ai_available"] is False
    assert client.get("/api/digest/weekly/narrative").json()["content"] is None
    _clean()


def test_ai_failure_is_502_and_empty_week_skips_ai(client, monkeypatch):
    _clean()
    monkeypatch.setattr(ai, "available", lambda: True)

    def boom(*a, **k):
        raise ai.AIError("down")
    monkeypatch.setattr(ai, "chat", boom)
    assert client.post("/api/digest/weekly/narrative", json={"weeks_back": 40}).json()["empty"] is True
    _dump("dg-1")
    assert client.post("/api/digest/weekly/narrative", json={}).status_code == 502
    _clean()


def test_markdown_and_save(client, monkeypatch):
    _clean()
    _dump("dg-1", "Alpha")
    monkeypatch.setattr(ai, "available", lambda: False)
    md = client.get("/api/digest/weekly/markdown").json()["markdown"]
    assert md.startswith("# Week of") and "sleep" in md
    monkeypatch.setattr("app.pipeline.run_pipeline", lambda did: None)
    r = client.post("/api/digest/weekly/save", json={})
    assert r.status_code == 200
    saved = db.query_one("SELECT raw_text FROM dumps WHERE id=?", (r.json()["id"],))
    assert saved["raw_text"].startswith("# Week of")
    assert client.post("/api/digest/weekly/save", json={"weeks_back": 40}).status_code == 400
    db.execute("DELETE FROM dumps WHERE id=?", (r.json()["id"],))
    _clean()
