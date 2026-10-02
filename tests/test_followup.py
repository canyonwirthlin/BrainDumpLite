"""AI follow-up question: lazy generation, gating, answer append + reindex, dismiss, settings switch."""
import json

import pytest
from fastapi.testclient import TestClient

from app import ai, db
from app.main import create_app

TEXT = "I keep going back and forth about whether to take the new job offer or stay where I am, honestly not sure."


@pytest.fixture
def env(monkeypatch):
    c = TestClient(create_app())
    calls = {"chat": 0}
    state = {"reply": "What is pulling you toward staying?", "available": True}

    monkeypatch.setattr(ai, "available", lambda: state["available"])

    def fake_chat(system, user, **kw):
        calls["chat"] += 1
        return state["reply"]
    monkeypatch.setattr(ai, "chat", fake_chat)
    monkeypatch.setattr(ai, "embed", lambda t: [0.1, 0.2])
    monkeypatch.setattr(ai, "chat_json", lambda *a, **k: {"items": [
        {"type": "task", "content": "email the recruiter back"}]})
    db.execute("DELETE FROM dumps WHERE id LIKE 'fu-%'")
    db.set_setting("followup_enabled", True)
    yield c, calls, state
    db.execute("DELETE FROM items WHERE dump_id LIKE 'fu-%'")
    db.execute("DELETE FROM items_fts WHERE dump_id LIKE 'fu-%'")
    db.execute("DELETE FROM dumps_fts WHERE id LIKE 'fu-%'")
    db.execute("DELETE FROM dumps WHERE id LIKE 'fu-%'")


def mk(did, text=TEXT, status="ready"):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status) "
               "VALUES (?,?,?,?,?,?,?,?)", (did, "2026-09-18T10:00:00+00:00", "freeform", text, None, "Job", "• job", status))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (did, text))


def test_question_generated_once_and_stored(env):
    c, calls, _ = env
    mk("fu-1")
    r = c.get("/api/dumps/fu-1/followup").json()
    assert r == {"state": "open", "question": "What is pulling you toward staying?"}
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "open"
    assert calls["chat"] == 1
    assert json.loads(db.query_one("SELECT reflection FROM dumps WHERE id='fu-1'")["reflection"])["state"] == "open"


def test_no_question_when_ai_off_switch_off_short_or_not_ready(env):
    c, calls, state = env
    mk("fu-1"); mk("fu-2", "too short"); mk("fu-3", status="processing")
    state["available"] = False
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "none"
    state["available"] = True
    db.set_setting("followup_enabled", False)
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "none"
    db.set_setting("followup_enabled", True)
    assert c.get("/api/dumps/fu-2/followup").json()["state"] == "none"
    assert c.get("/api/dumps/fu-3/followup").json()["state"] == "none"
    assert calls["chat"] == 0
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "open"  # nothing was cached as "none"


def test_none_reply_and_ai_error_never_break(env, monkeypatch):
    c, calls, state = env
    mk("fu-1")
    state["reply"] = "NONE"
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "none"
    mk("fu-2")
    monkeypatch.setattr(ai, "chat", lambda *a, **k: (_ for _ in ()).throw(ai.AIError("boom")))
    assert c.get("/api/dumps/fu-2/followup").json()["state"] == "none"
    assert db.query_one("SELECT reflection FROM dumps WHERE id='fu-2'")["reflection"] is None  # retried later


def test_answer_appends_marked_block_and_reindexes(env):
    c, _, _ = env
    mk("fu-1")
    c.get("/api/dumps/fu-1/followup")
    r = c.post("/api/dumps/fu-1/followup/answer", json={"text": "Mostly the quokka commute"})
    assert r.status_code == 200 and r.json()["items_added"] == 0
    d = db.query_one("SELECT raw_text, reflection FROM dumps WHERE id='fu-1'")
    assert "Follow-up: What is pulling you toward staying?\nMostly the quokka commute" in d["raw_text"]
    assert json.loads(d["reflection"])["state"] == "answered"
    assert db.query("SELECT 1 FROM dumps_fts WHERE dumps_fts MATCH 'quokka'")
    assert db.query_one("SELECT embedding FROM dumps WHERE id='fu-1'")["embedding"]
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "answered"


def test_answer_can_extract_items(env):
    c, _, _ = env
    mk("fu-1")
    c.get("/api/dumps/fu-1/followup")
    r = c.post("/api/dumps/fu-1/followup/answer", json={"text": "I should reply to the recruiter", "extract": True})
    assert r.json()["items_added"] == 1
    it = db.query_one("SELECT content, status FROM items WHERE dump_id='fu-1'")
    assert it["content"] == "email the recruiter back" and it["status"] == "suggested"


def test_dismiss_empty_answer_and_trashed(env):
    c, calls, _ = env
    mk("fu-1")
    c.get("/api/dumps/fu-1/followup")
    assert c.post("/api/dumps/fu-1/followup/answer", json={"text": "  "}).status_code == 400
    assert c.post("/api/dumps/fu-1/followup/dismiss").json()["ok"]
    assert c.get("/api/dumps/fu-1/followup").json()["state"] == "dismissed"
    assert c.post("/api/dumps/nope/followup/dismiss").status_code == 404
    db.execute("UPDATE dumps SET deleted_at='2026-09-19T00:00:00+00:00' WHERE id='fu-1'")
    assert c.post("/api/dumps/fu-1/followup/answer", json={"text": "x"}).status_code == 404


def test_settings_switch(env):
    c, _, state = env
    assert c.get("/api/followup/settings").json() == {"enabled": True, "ai_available": True}
    assert c.put("/api/followup/settings", json={"enabled": False}).json()["enabled"] is False
    state["available"] = False
    assert c.get("/api/followup/settings").json()["ai_available"] is False
