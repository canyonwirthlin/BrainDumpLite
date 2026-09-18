import json

import pytest
from fastapi.testclient import TestClient

from app import ai, db, sessions
from app.main import create_app


@pytest.fixture
def fake_ai(monkeypatch):
    create_app()
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "config", lambda: {"provider": "openai", "api_key": "x", "base_url": "", "model": "gpt-test", "embed_model": ""})
    monkeypatch.setattr(ai, "chat_stream", lambda messages, **kw: iter(["Hel", "lo, ", "tell me more?"]))
    monkeypatch.setattr(ai, "chat_json", lambda system, user, **kw: {"items": [{"type": "task", "content": "call the dentist"}, {"type": "bogus", "content": "x"}]})
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: user)
    monkeypatch.setattr(ai, "embed", lambda text: None)
    yield


def test_session_round_trip(fake_ai):
    with pytest.raises(ValueError):
        sessions.start("freeform")
    s = sessions.start("therapy")
    turn = sessions.append(s["id"], "user", "I keep putting off the dentist")
    assert turn == 0
    reply = "".join(sessions.reply_stream(s["id"]))
    assert reply == "Hello, tell me more?"
    assert [t["role"] for t in sessions.get(s["id"])["transcript"]] == ["user", "assistant"]
    got = sessions.extract_lite(s["id"], turn, "I keep putting off the dentist")
    assert [g["kind"] for g in got] == ["task", "note"]
    assert len(sessions.get(s["id"])["items"]) == 2
    assert s["id"] in [o["id"] for o in sessions.list_open()]
    dump_id = sessions.end(s["id"], run_async=False)
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (dump_id,))
    assert d["mode"] == "therapy" and d["status"] == "ready"
    assert d["raw_text"].startswith("You: I keep putting off the dentist\n\nAI: Hello")
    after = sessions.get(s["id"])
    assert after["status"] == "ended" and after["dump_id"] == dump_id and after["items"] == []
    assert s["id"] not in [o["id"] for o in sessions.list_open()]
    assert sessions.end(s["id"]) == dump_id  # idempotent
    sessions.delete(s["id"])
    assert sessions.get(s["id"]) is None
    db.execute("DELETE FROM dumps WHERE id=?", (dump_id,))


def test_end_requires_a_user_turn(fake_ai):
    s = sessions.start("brainstorm")
    with pytest.raises(ValueError):
        sessions.end(s["id"])
    sessions.delete(s["id"])


def test_session_api_streams_sse(fake_ai):
    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"mode": "brainstorm"}).json()["id"]
    with client.stream("POST", f"/api/sessions/{sid}/message", json={"text": "an app that reminds me to drink water"}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    assert 'data: "Hel"' in body and "event: done" in body
    s = client.get(f"/api/sessions/{sid}").json()
    assert s["transcript"][-1]["role"] == "assistant"
    assert client.get("/api/sessions?open=1").json()[0]["id"] == sid
    dump_id = client.post(f"/api/sessions/{sid}/end").json()["dump_id"]
    assert client.get(f"/api/dumps/{dump_id}").status_code == 200
    client.delete(f"/api/sessions/{sid}")
    db.execute("DELETE FROM dumps WHERE id=?", (dump_id,))
