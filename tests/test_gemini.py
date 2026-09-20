"""Gemini model discovery: nothing hard-coded, best *free* model that answers wins."""
import pytest
from fastapi.testclient import TestClient

from app import ai, db, gemini
from app.main import create_app

M = lambda mid, methods=("generateContent",), label="": {"id": mid, "label": label or mid, "methods": list(methods)}

# Shaped like Google's real list: stable + preview + snapshots + non-chat noise.
LISTING = [
    M("gemini-3.8-flash"), M("gemini-3.7-flash"), M("gemini-3.5-flash-lite"), M("gemini-2.5-flash"), M("gemini-2.5-flash-lite"),
    M("gemini-2.5-pro"), M("gemini-3.1-pro-preview"), M("gemini-3-flash-preview"), M("gemini-2.5-flash-preview-05-20"),
    M("gemini-flash-latest"), M("gemini-3.8-live", ("bidiGenerateContent",)), M("gemini-3.8-live-extended-thinking"),
    M("gemini-2.5-flash-image"), M("gemini-2.5-flash-preview-tts"), M("gemini-2.0-flash-thinking-exp"), M("gemma-3-27b-it"),
    M("gemini-embedding-001", ("embedContent",)), M("gemini-embedding-2-preview", ("embedContent",)),
    M("gemini-embedding-2", ("embedContent",)), M("text-embedding-004", ("embedContent",)),
]


def test_classify_chat_orders_free_flash_first_and_drops_noise():
    ids = [m["id"] for m in gemini.classify_chat(LISTING)]
    assert ids[:4] == ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-2.5-flash", "gemini-3-flash-preview"]   # stable Flash, newest first, then preview Flash
    assert ids.index("gemini-3.8-flash") < ids.index("gemini-2.5-flash") < ids.index("gemini-3.5-flash-lite")   # all Flash before any Flash-Lite
    for junk in ("gemini-3.8-live", "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-2.0-flash-thinking-exp", "gemma-3-27b-it", "gemini-embedding-001"):
        assert junk not in ids
    by = {m["id"]: m for m in gemini.classify_chat(LISTING)}
    assert not by["gemini-2.5-pro"]["default_ok"] and "paid" in by["gemini-2.5-pro"]["note"]   # Pro is selectable, never the default
    assert not by["gemini-flash-latest"]["default_ok"]


def test_classify_embed_prefers_newest_stable_and_skips_retired():
    ids = [m["id"] for m in gemini.classify_embed(LISTING)]
    assert ids[0] == "gemini-embedding-2" and "gemini-embedding-001" in ids
    assert "text-embedding-004" not in ids and ids.index("gemini-embedding-2") < ids.index("gemini-embedding-2-preview")


def test_setup_skips_models_that_do_not_answer(monkeypatch):
    monkeypatch.setattr(gemini, "fetch_models", lambda key: LISTING)
    dead = {"gemini-3.8-flash": "quota limit: 0", "gemini-3.7-flash": "not found"}
    monkeypatch.setattr(gemini, "probe_chat", lambda key, m: (m not in dead, dead.get(m, "")))
    monkeypatch.setattr(gemini, "probe_embed", lambda key, m: (m != "gemini-embedding-2", "nope"))
    r = gemini.setup("k")
    assert r["model"] == "gemini-2.5-flash"                       # next-best that really works for this key
    assert [t["id"] for t in r["tried"]] == ["gemini-3.8-flash", "gemini-3.7-flash"]
    assert r["embed_model"] == "gemini-embedding-001"             # embedding-2 failed its probe
    assert "gemini-2.5-pro" in [m["id"] for m in r["chat_models"]]  # whole list still offered for manual choice


def test_setup_without_probe_makes_no_calls(monkeypatch):
    monkeypatch.setattr(gemini, "fetch_models", lambda key: LISTING)
    def boom(*a): raise AssertionError("must not probe")
    monkeypatch.setattr(gemini, "probe_chat", boom); monkeypatch.setattr(gemini, "probe_embed", boom)
    assert gemini.setup("k", probe=False)["model"] == "gemini-3.8-flash"


def test_setup_endpoint_and_bad_key(monkeypatch):
    client = TestClient(create_app())
    monkeypatch.setattr(gemini, "fetch_models", lambda key: LISTING)
    monkeypatch.setattr(gemini, "probe_chat", lambda key, m: (True, ""))
    monkeypatch.setattr(gemini, "probe_embed", lambda key, m: (True, ""))
    assert client.post("/api/gemini/setup", json={"api_key": "abc"}).json()["model"] == "gemini-3.8-flash"
    def bad(key): raise gemini.GeminiError("Google rejected that API key — check it and try again.")
    monkeypatch.setattr(gemini, "fetch_models", bad)
    r = client.post("/api/gemini/setup", json={"api_key": "abc"})
    assert r.status_code == 502 and "rejected" in r.json()["detail"]


def test_heal_saves_replacement_and_is_rate_limited(monkeypatch):
    create_app()
    db.set_setting("api_key", "k")
    monkeypatch.setattr(gemini, "fetch_models", lambda key: LISTING)
    monkeypatch.setattr(gemini, "probe_chat", lambda key, m: (True, ""))
    monkeypatch.setattr(gemini, "probe_embed", lambda key, m: (True, ""))
    gemini._heal_at.clear()
    assert gemini.heal("chat") == "gemini-3.8-flash" and db.get_setting("model") == "gemini-3.8-flash"
    assert gemini.heal("chat") is None                            # a second failure within 10 min doesn't hammer Google
    gemini._heal_at.clear(); db.set_setting("api_key", "")


def test_chat_heals_a_retired_model_once(monkeypatch):
    from openai import NotFoundError
    import httpx
    create_app()
    for k, v in {"provider": "gemini", "api_key": "k", "model": "gemini-2.5-flash"}.items():
        db.set_setting(k, v)
    calls = []
    class Completions:
        def create(self, **kw):
            calls.append(kw["model"])
            if kw["model"] == "gemini-2.5-flash":
                req = httpx.Request("POST", "http://x"); raise NotFoundError("model not found", response=httpx.Response(404, request=req), body=None)
            msg = type("M", (), {"content": "OK"})(); ch = type("C", (), {"message": msg, "finish_reason": "stop"})()
            return type("R", (), {"choices": [ch], "usage": None})()
    fake = type("Cl", (), {"chat": type("Ch", (), {"completions": Completions()})()})()
    monkeypatch.setattr(ai, "_client", lambda c=None: fake)
    monkeypatch.setattr(gemini, "heal", lambda kind: "gemini-3.8-flash")
    assert ai.chat("s", "u") == "OK" and calls == ["gemini-2.5-flash", "gemini-3.8-flash"]
    for k in ("provider", "api_key", "model"):
        db.set_setting(k, "")
