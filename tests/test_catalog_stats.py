import time

import pytest
from fastapi.testclient import TestClient

from app import ai, catalog, db, engine, stats
from app.main import create_app


@pytest.fixture(autouse=True)
def clean():
    create_app()
    db.execute("DELETE FROM settings WHERE key='catalog_cache'")
    yield
    db.execute("DELETE FROM settings WHERE key='catalog_cache'")
    db.execute("DELETE FROM runs WHERE dump_id LIKE 'stat-%'")


def test_catalog_bundled_cache_and_refresh(monkeypatch):
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    models = catalog.chat_models()
    assert [m["id"] for m in models][:2] == ["llama-3.2-3b", "qwen3-4b"]
    assert "tags" in models[0] and catalog.price_for("openai", "gpt-5-mini")["input"] == 0.25
    remote = {"version": 2, "chat_models": [{"id": "new-model", "label": "New", "repo": "r", "file": "f.gguf",
                                              "sha256": "0" * 64, "size": 100, "vram_gb": 4, "blurb": "x"}],
              "prices_per_million_tokens": {}}
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: remote)
    assert catalog.load(refresh=True)["version"] == 2
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    assert catalog.load()["version"] == 2                     # fresh cache wins
    db.set_setting("catalog_cache", {"fetched_at": time.time() - 100000, "data": remote})
    assert catalog.load()["version"] == 2                     # stale cache still beats bundled when remote fails
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: {"chat_models": "bad"})
    assert catalog.load(refresh=True)["version"] == 2         # invalid remote ignored


def test_engine_reads_catalog(monkeypatch):
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    ids = [m["id"] for m in engine.status()["models"]]
    assert ids == [m["id"] for m in catalog.chat_models()]
    assert engine.recommended_id(3000) == "llama-3.2-3b"
    assert engine.recommended_id(8500) == "llama-3.1-8b"
    assert engine.recommended_id(6000) in ("qwen3-4b", "gemma-3-4b")


def test_gemini_provider_defaults(monkeypatch):
    assert ai.DEFAULTS["gemini"]["base_url"].startswith("https://generativelanguage.googleapis.com")
    monkeypatch.setattr(db, "get_setting", lambda k, d=None: {"provider": "gemini", "api_key": "k"}.get(k, d))
    c = ai.config()
    assert c["model"] == "gemini-2.5-flash" and c["embed_model"] == "text-embedding-004"
    assert ai.available()


def test_stats_summary_and_daily_sample():
    now = db.now_iso()
    for i, (stage, ok, ms, pt, ct) in enumerate([("classify", 1, 3000, 1000, 500), ("classify", 0, 9000, 800, 0), ("embed", 1, 500, 150, 0)]):
        db.execute("INSERT INTO runs (id, dump_id, stage, provider, model, started_at, ms, prompt_tokens, completion_tokens, ok) VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (f"stat-{i}", f"stat-{i}", stage, "openai", "gpt-5-mini", now, ms, pt, ct, ok))
    s = stats.summary(30)
    assert s["calls"] >= 3
    cl = next(x for x in s["stages"] if x["stage"] == "classify")
    assert cl["calls"] >= 2 and 0 < cl["success_rate"] < 1 and cl["median_ms"] >= 3000
    pv = next(p for p in s["providers"] if p["model"] == "gpt-5-mini")
    assert pv["prompt_tokens"] >= 1950 and pv["est_cost_usd"] is not None and not pv["local"]
    stats.sample_daily()
    assert s["days"] == 30 and db.query_one("SELECT COUNT(*) AS n FROM stats_daily")["n"] >= 1
    client = TestClient(create_app())
    assert client.get("/api/stats?days=7").json()["days"] == 7
    assert client.get("/api/catalog").json()["chat_models"]
