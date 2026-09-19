import json
import re
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


def test_bundled_catalog_is_well_formed():
    data = json.loads(catalog.bundled_path().read_text(encoding="utf-8"))
    models = data["chat_models"]
    assert catalog._valid(data)
    assert len({m["id"] for m in models}) == len(models)
    assert len({m["file"] for m in models}) == len(models)
    assert len(models) >= 15
    for m in models:
        who = m["id"]
        assert re.fullmatch(r"[0-9a-f]{64}", m["sha256"]), who
        assert isinstance(m["size"], int) and m["size"] > 0, who
        assert m["file"].endswith(".gguf") and "/" not in m["file"] and "\\" not in m["file"], who  # joined onto the models dir
        assert m["repo"].count("/") == 1, who
        assert m["vram_gb"] in (4, 6, 8, 10, 12, 16, 20, 24), who
        assert m["vram_gb"] * 2**30 > m["size"], f"{who}: weights alone exceed the VRAM tier"
        assert m["ram_gb"] in (4, 8, 16, 32, 64), who
        assert m["arch"] in ("dense", "moe"), who
        assert m["family"] and m["params"] and m["quant"] and m["license"], who
        assert isinstance(m["context_k"], int) and m["context_k"] > 0, who
        assert m["tags"] and all(isinstance(t, str) for t in m["tags"]), who
        assert m["caveats"] and all(isinstance(c, str) and c for c in m["caveats"]), who
        assert (m["arch"] == "moe") == ("moe" in m["tags"]), who


def test_recommendation_never_overshoots_the_gpu(monkeypatch):
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    models = {m["id"]: m for m in catalog.chat_models()}
    smallest = min(m["vram_gb"] for m in models.values())
    for vram_mb in range(1000, 50000, 250):
        rec = models[engine.recommended_id(vram_mb)]
        fits = [m for m in models.values() if vram_mb >= m["vram_gb"] * 1024 - 600]
        if fits:
            assert rec["vram_gb"] == max(m["vram_gb"] for m in fits), vram_mb
        else:
            assert rec["vram_gb"] == smallest, vram_mb


def test_engine_status_carries_spec_fields(monkeypatch):
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    for m in engine.status()["models"]:
        assert m["family"] and m["params"] and m["license"] and m["ram_gb"], m["id"]
        assert isinstance(m["caveats"], list) and m["caveats"], m["id"]
    # An entry from an older catalog without the new fields must still serialise.
    bare = {"id": "bare", "label": "Bare", "repo": "r/r", "file": "b.gguf", "sha256": "0" * 64, "size": 1, "vram_gb": 4, "blurb": "x"}
    monkeypatch.setattr(catalog, "chat_models", lambda: [bare])
    row = engine.status()["models"][0]
    assert row["caveats"] == [] and row["params"] is None


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
