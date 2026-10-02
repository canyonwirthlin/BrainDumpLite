"""Queue-while-AI-is-off, opt-in re-processing and the search-index rebuild."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import ai, db, embeddings, reprocess
from app.main import create_app

CLASSIFY = {"title": "New title", "summary": ["• s"], "items": [
    {"type": "task", "content": "Fresh suggestion", "priority": 3, "due_date_iso": None, "first_tiny_step": None,
     "estimated_minutes": None, "urgency": 1, "time_hint": None}], "tone": None, "people": [], "concepts": []}


@pytest.fixture
def client():
    c = TestClient(create_app())
    yield c
    # the test DB is shared across the session: leave nothing behind
    for t in ("items", "items_fts", "dumps_fts", "runs"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM dumps")


def _cfg(provider):
    return lambda: {"provider": provider, "api_key": "", "base_url": "", "model": "m", "embed_model": ""}


def _fake_ai(monkeypatch, available=True, provider="openai"):
    monkeypatch.setattr(ai, "available", lambda: available)
    monkeypatch.setattr(ai, "config", _cfg(provider))
    monkeypatch.setattr(ai, "chat", lambda s, u, **kw: "cleaned")
    monkeypatch.setattr(ai, "chat_json", lambda s, u, **kw: json.loads(json.dumps(CLASSIFY)))
    monkeypatch.setattr(ai, "embed", lambda t: [0.1, 0.2])


def _ready(did, provider=None, text="some words", title="old"):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, provider) "
               "VALUES (?,?,?,?,?,?,?, 'ready', ?)", (did, db.now_iso(), "freeform", text, text, title, "old", provider))


def _wait(fn, n=100):
    for _ in range(n):
        if not fn()["running"]:
            return
        time.sleep(0.05)
    raise AssertionError("still running")


# ── queue ────────────────────────────────────────────────────────────────────

def test_dump_is_queued_when_chosen_ai_is_unusable(client, monkeypatch):
    _fake_ai(monkeypatch, available=False)
    r = client.post("/api/dumps", json={"text": "call mom tomorrow"}).json()
    assert r["status"] == "queued"
    d = client.get("/api/dumps/" + r["id"]).json()
    assert d["status"] == "queued" and d["raw_text"] == "call mom tomorrow"
    assert r["id"] in [x["id"] for x in client.get("/api/dumps").json()]   # stays visible in history
    assert client.get("/api/pipeline/queue").json()["queued"] >= 1
    assert client.post("/api/pipeline/queue/process").status_code == 400    # AI still off
    assert reprocess.process_queued() == 0

    monkeypatch.setattr(ai, "available", lambda: True)                     # AI comes up
    assert reprocess.process_queued() >= 1
    d = db.query_one("SELECT status, title FROM dumps WHERE id=?", (r["id"],))
    assert d["status"] == "ready" and d["title"] == "New title"


def test_provider_off_still_runs_raw_pipeline(client, monkeypatch):
    _fake_ai(monkeypatch, available=False, provider="off")
    assert reprocess.should_queue() is False
    assert client.post("/api/dumps", json={"text": "x y z"}).json()["status"] == "pending"


# ── re-process ───────────────────────────────────────────────────────────────

def test_reprocess_requires_confirm_and_ai(client, monkeypatch):
    _fake_ai(monkeypatch)
    assert client.post("/api/pipeline/reprocess", json={"scope": "all"}).status_code == 400
    _fake_ai(monkeypatch, available=False)
    assert client.post("/api/pipeline/reprocess", json={"scope": "all", "confirm": True}).status_code == 400


def test_reprocess_scopes_and_keeps_user_decisions(client, monkeypatch):
    _fake_ai(monkeypatch, provider="openai")
    _ready("rp-raw", provider="off", title="some words")
    _ready("rp-other", provider="gemini")
    _ready("rp-same", provider="openai")
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES "
               "('rp-keep','rp-raw','task','Fresh suggestion','approved',1,?)", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES "
               "('rp-old','rp-raw','task','Stale suggestion','suggested',0,?)", (db.now_iso(),))
    p = client.get("/api/pipeline/reprocess").json()
    assert p["raw"] >= 1 and p["other"] >= 1 and p["all"] >= 3
    assert "rp-other" in reprocess.candidates("other") and "rp-same" not in reprocess.candidates("other")
    assert "rp-same" not in reprocess.candidates("raw")

    r = client.post("/api/pipeline/reprocess", json={"scope": "ids", "ids": ["rp-raw"], "confirm": True})
    assert r.status_code == 200
    _wait(reprocess.status)
    assert reprocess.status()["done"] == 1
    d = db.query_one("SELECT status, title, provider FROM dumps WHERE id='rp-raw'")
    assert (d["status"], d["title"], d["provider"]) == ("ready", "New title", "openai")
    rows = db.query("SELECT id, status, done FROM items WHERE dump_id='rp-raw'")
    assert [(x["id"], x["status"], x["done"]) for x in rows] == [("rp-keep", "approved", 1)]   # no dupes, stale gone
    assert db.query_one("SELECT 1 FROM dumps WHERE id='rp-other'")["1"] == 1
    assert db.query_one("SELECT title FROM dumps WHERE id='rp-other'")["title"] == "old"      # untouched


# ── search index ─────────────────────────────────────────────────────────────

def test_rebuild_all_and_unembeddable_provider(client, monkeypatch):
    _fake_ai(monkeypatch)
    _ready("em-1")
    db.execute("UPDATE dumps SET embedding='[9]' WHERE id='em-1'")
    assert client.post("/api/pipeline/embeddings/rebuild-all").status_code == 200
    _wait(embeddings.status)
    assert db.query_one("SELECT embedding FROM dumps WHERE id='em-1'")["embedding"] == "[0.1, 0.2]"

    # a provider that can't embed: gives up after a few failures with a helpful message
    db.execute("UPDATE dumps SET embedding=NULL")
    for i in range(5):
        _ready(f"em-x{i}")
    monkeypatch.setattr(ai, "embed", lambda t: None)
    assert client.post("/api/embeddings/rebuild").status_code == 200
    _wait(embeddings.status)
    s = embeddings.status()
    assert s["done"] == 0 and s["failed"] == 3 and "can't create embeddings" in s["error"]
