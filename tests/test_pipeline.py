"""Pipeline end to end with a fake AI provider (no model, no network)."""
import json

import pytest

from app import ai, db, item_types, pipeline
from app.main import create_app

CLASSIFY = {
    "title": "Friday dentist",
    "summary": ["• book the dentist", "• feeling anxious about work"],
    "items": [
        {"type": "task", "content": "Book the dentist by Friday", "priority": 4, "due_date_iso": "2026-09-25",
         "first_tiny_step": "find the number", "estimated_minutes": 30, "urgency": 2, "time_hint": "by Friday"},
        {"type": "concern", "content": "Work is a fog lately", "priority": None, "due_date_iso": None,
         "first_tiny_step": None, "estimated_minutes": None, "urgency": 0, "time_hint": None},
        {"type": "unicorn", "content": "unknown type falls back", "priority": None, "due_date_iso": None,
         "first_tiny_step": None, "estimated_minutes": 999, "urgency": 9, "time_hint": None},
    ],
    "tone": {"label": "anxious", "valence": -1, "energy": 1},
    "people": ["Sam"], "concepts": ["dentist", "work fog"],
}


@pytest.fixture
def fake_ai(monkeypatch):
    create_app()
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "config", lambda: {"provider": "openai", "api_key": "x", "base_url": "", "model": "gpt-test", "embed_model": ""})
    def used():  # a real call sets usage inside the call, after timed() reset it
        ai._usage.value = {"prompt_tokens": 120, "completion_tokens": 40}
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: (used(), "cleaned text about the dentist")[1])
    monkeypatch.setattr(ai, "chat_json", lambda system, user, **kw: (used(), json.loads(json.dumps(CLASSIFY)))[1])
    monkeypatch.setattr(ai, "embed", lambda text: None)
    yield
    db.execute("DELETE FROM runs")


def _new_dump(text="book the dentist by friday, work is a fog"):
    did = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES (?,?,?,?,'pending')",
               (did, db.now_iso(), "freeform", text))
    return did


def test_pipeline_stores_tone_time_provider_and_runs(fake_ai):
    did = _new_dump()
    pipeline.run_pipeline(did)
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (did,))
    assert d["status"] == "ready" and d["provider"] == "openai" and d["captured_local"]
    assert json.loads(d["tone"]) == {"label": "anxious", "valence": -1, "energy": 1}
    items = {r["content"]: dict(r) for r in db.query("SELECT * FROM items WHERE dump_id=?", (did,))}
    t = items["Book the dentist by Friday"]
    assert (t["kind"], t["est_minutes"], t["urgency"], t["time_hint"]) == ("task", 30, 2, "by Friday")
    u = items["unknown type falls back"]
    assert u["kind"] == "note" and u["est_minutes"] is None and u["urgency"] == 3
    stages = {r["stage"]: dict(r) for r in db.query("SELECT * FROM runs WHERE dump_id=?", (did,))}
    assert {"cleanup", "classify"} <= set(stages)
    assert stages["classify"]["ok"] == 1 and stages["classify"]["prompt_tokens"] == 120
    assert stages["classify"]["model"] == "gpt-test"
    hit = db.query("SELECT item_id FROM items_fts WHERE items_fts MATCH 'dentist'")
    assert len(hit) == 1
    db.execute("DELETE FROM dumps WHERE id=?", (did,))


def test_classify_failure_falls_back_and_records_error(fake_ai, monkeypatch):
    def boom(*a, **k):
        raise ai.AIError("model exploded")
    monkeypatch.setattr(ai, "chat_json", boom)
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: user)  # cleanup keeps the two lines
    did = _new_dump("need to call mom\nbuy soap")
    pipeline.run_pipeline(did)
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (did,))
    assert d["status"] == "ready" and d["tone"] is None
    assert db.query_one("SELECT COUNT(*) AS n FROM items WHERE dump_id=?", (did,))["n"] == 2
    run = db.query_one("SELECT * FROM runs WHERE dump_id=? AND stage='classify'", (did,))
    assert run["ok"] == 0 and "model exploded" in run["error"]
    db.execute("DELETE FROM dumps WHERE id=?", (did,))


def test_no_ai_marks_provider_off(monkeypatch):
    create_app()
    monkeypatch.setattr(ai, "available", lambda: False)
    monkeypatch.setattr(ai, "config", lambda: {"provider": "off", "api_key": "", "base_url": "", "model": "", "embed_model": ""})
    did = _new_dump("just a note")
    pipeline.run_pipeline(did)
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (did,))
    assert d["status"] == "ready" and d["provider"] == "off"
    assert db.query_one("SELECT COUNT(*) AS n FROM runs WHERE dump_id=?", (did,))["n"] == 0
    db.execute("DELETE FROM dumps WHERE id=?", (did,))
