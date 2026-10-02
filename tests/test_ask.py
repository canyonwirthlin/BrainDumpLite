"""Ask your brain: retrieval, citation mapping, no-results, AI off (fake provider, no model)."""
import pytest
from fastapi.testclient import TestClient

from app import ai, ask, db
from app.main import create_app


def _dump(title, body, deleted=False, private=False):
    did = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, deleted_at, is_private) VALUES (?,?,?,?,?,'ready',?,?)",
               (did, db.now_iso(), "freeform", body, title, db.now_iso() if deleted else None, 1 if private else 0))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?, ?)", (did, f"{title} {body}"))
    return did


@pytest.fixture
def client(monkeypatch):
    c = TestClient(create_app())
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "embed", lambda text: None)
    yield c
    db.execute("DELETE FROM dumps")
    db.execute("DELETE FROM dumps_fts")


def test_answer_cites_and_maps_sources(client, monkeypatch):
    a = _dump("Quokka plan", "quokka sanctuary visit planned for spring")
    seen = {}
    def fake_chat(system, user, **kw):
        seen["user"], seen["system"] = user, system
        return "You plan a quokka visit [1]. Also [9] is bogus."
    monkeypatch.setattr(ai, "chat", fake_chat)
    r = client.post("/api/ask", json={"question": "when is the quokka visit?"}).json()
    assert r["ok"] and "[1]" in r["answer"]
    assert [s["id"] for s in r["sources"]] == [a]
    s = r["sources"][0]
    assert s["n"] == 1 and s["cited"] is True and s["title"] == "Quokka plan" and s["snippet"]
    assert "[1]" in seen["user"] and "quokka sanctuary" in seen["user"] and "ONLY" in seen["system"]


def test_uncited_sources_are_flagged(client, monkeypatch):
    _dump("Quokka plan", "quokka sanctuary visit")
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: "No citation here.")
    r = client.post("/api/ask", json={"question": "quokka"}).json()
    assert r["sources"][0]["cited"] is False


def test_trashed_and_private_dumps_never_reach_the_model(client, monkeypatch):
    ok = _dump("Visible zebra", "zebra notes")
    _dump("Trashed zebra", "zebra trashed", deleted=True)
    _dump("Private zebra", "zebra secret", private=True)
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: "see [1]")
    r = client.post("/api/ask", json={"question": "zebra"}).json()
    assert [s["id"] for s in r["sources"]] == [ok]
    assert [x["id"] for x in ask.visible_dumps([ok])] == [ok]


def test_no_results_does_not_call_the_model(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("model must not be called")
    monkeypatch.setattr(ai, "chat", boom)
    r = client.post("/api/ask", json={"question": "xylophonequasar"}).json()
    assert r["ok"] and r["reason"] == "no_results" and r["sources"] == [] and "couldn't find" in r["answer"]


def test_ai_off_says_so(client, monkeypatch):
    monkeypatch.setattr(ai, "available", lambda: False)
    _dump("Quokka plan", "quokka")
    r = client.post("/api/ask", json={"question": "quokka"}).json()
    assert not r["ok"] and r["reason"] == "ai_off" and "AI is off" in r["answer"]


def test_ai_error_degrades_gracefully(client, monkeypatch):
    _dump("Quokka plan", "quokka")
    def boom(*a, **k):
        raise ai.AIError("model exploded")
    monkeypatch.setattr(ai, "chat", boom)
    r = client.post("/api/ask", json={"question": "quokka"}).json()
    assert not r["ok"] and r["reason"] == "ai_error" and "exploded" in r["answer"]


def test_followup_uses_history_for_retrieval_and_prompt(client, monkeypatch):
    _dump("Quokka plan", "quokka sanctuary visit")
    seen = {}
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: (seen.setdefault("user", user), "ok [1]")[1])
    hist = [{"role": "user", "content": "tell me about the quokka"}, {"role": "assistant", "content": "A visit [1]."}]
    r = client.post("/api/ask", json={"question": "xyzzyplugh?", "history": hist}).json()
    assert r["sources"] and "Conversation so far" in seen["user"] and "tell me about the quokka" in seen["user"]


def test_empty_question(client):
    assert client.post("/api/ask", json={"question": "  "}).json()["reason"] == "empty"
