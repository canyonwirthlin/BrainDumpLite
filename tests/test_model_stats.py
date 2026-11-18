"""Model comparison (Stats page): aggregation over seeded `runs` rows."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app
from app.routes_model_stats import compare

TAG = "mcmp-"


@pytest.fixture(autouse=True)
def clean():
    create_app()
    _wipe()
    yield
    _wipe()


def _wipe():
    db.execute("DELETE FROM runs")
    db.execute(f"DELETE FROM items WHERE dump_id LIKE '{TAG}%'")
    db.execute(f"DELETE FROM dumps WHERE id LIKE '{TAG}%'")


def _run(stage, model, ms, ok=1, pt=None, ct=None, provider="openai", dump_id=None, days_ago=0.0):
    when = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    db.execute("INSERT INTO runs (id, dump_id, stage, provider, model, started_at, ms, prompt_tokens, completion_tokens, ok) "
               "VALUES (?,?,?,?,?,?,?,?,?,?)", (db.new_id(), dump_id, stage, provider, model, when, ms, pt, ct, ok))


def _dump(did, private=0, trashed=False):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status, is_private, deleted_at) VALUES (?,?,?,?,?,?,?)",
               (did, db.now_iso(), "freeform", "x", "ready", private, db.now_iso() if trashed else None))


def _item(did, status):
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?,?,0,?)",
               (db.new_id(), did, "task", "t", status, db.now_iso()))


def _m(res, model):
    return next(r for r in res["models"] if r["model"] == model)


def test_empty_vault():
    res = compare(30)
    assert res["runs"] == 0 and res["models"] == [] and res["by_stage"] == [] and res["stages"] == []
    assert res["notes"] and res["min_models"] == 2


def test_single_model_row():
    for ms in (100, 200, 300, 400, 1000):
        _run("classify", "alpha", ms, pt=100, ct=50)
    res = compare(30)
    assert len(res["models"]) == 1
    a = _m(res, "alpha")
    assert a["runs"] == 5 and a["success_rate"] == 1.0 and a["errors"] == 0
    assert a["median_ms"] == 300 and a["p90_ms"] == 1000
    assert a["avg_out_tokens"] == 50 and a["avg_in_tokens"] == 100
    assert a["tokens_per_sec"] == pytest.approx(250 / 2.0, abs=0.1)     # 250 tokens over 2.0 s
    assert a["approval_rate"] is None and a["fallback_rate"] == 0


def test_two_models_rates_and_stage_split():
    _run("cleanup", "alpha", 500, ok=0, provider="local")
    _run("cleanup", "alpha", 700, provider="local", pt=10, ct=20)
    _run("classify", "alpha", 3000, provider="local", pt=100, ct=60)
    _run("embed", "alpha", 50, provider="local", pt=30)             # embed: no output tokens
    _run("ask", "beta", 900, ok=0)                                  # not a fallback stage: plain error
    _run("ask", "beta", 1100, pt=200, ct=100)
    res = compare(30)
    a, b = _m(res, "alpha"), _m(res, "beta")
    assert a["local"] and not b["local"]
    assert a["runs"] == 4 and a["errors"] == 1 and a["success_rate"] == 0.75
    assert a["fallback_runs"] == 3 and a["fallbacks"] == 1 and a["fallback_rate"] == pytest.approx(0.333, abs=0.001)
    assert a["token_runs"] == 2                                     # embed and the failed run carry no output
    assert b["errors"] == 1 and b["fallback_rate"] is None and b["fallbacks"] == 0
    assert [m["model"] for m in res["models"]] == ["alpha", "beta"]  # busiest first
    assert res["stages"] == ["ask", "classify", "cleanup", "embed"]
    keys = {(r["model"], r["stage"]) for r in res["by_stage"]}
    assert ("alpha", "cleanup") in keys and ("beta", "ask") in keys and len(keys) == 4
    only = compare(30, "ask")
    assert [m["model"] for m in only["models"]] == ["beta"] and only["stage"] == "ask"
    assert only["stages"] == ["ask", "classify", "cleanup", "embed"]  # the picker still lists every stage


def test_time_range():
    _run("classify", "old", 100, days_ago=60)
    _run("classify", "new", 100, days_ago=2)
    assert {m["model"] for m in compare(7)["models"]} == {"new"}
    assert {m["model"] for m in compare(30)["models"]} == {"new"}
    assert {m["model"] for m in compare(90)["models"]} == {"old", "new"}
    assert {m["model"] for m in compare(0)["models"]} == {"old", "new"}      # 0 = all time


def test_approval_from_items_latest_classify_run_only():
    _dump(TAG + "1"); _dump(TAG + "2")
    # dump 1 was first classified by "old", then re-processed by "alpha": only alpha owns its items
    _run("classify", "old", 100, dump_id=TAG + "1", days_ago=3)
    _run("classify", "alpha", 100, dump_id=TAG + "1", days_ago=1)
    _run("classify", "alpha", 100, dump_id=TAG + "2")
    for st in ("approved", "approved", "rejected", "suggested"):
        _item(TAG + "1", st)
    _item(TAG + "2", "rejected")
    res = compare(30)
    a = _m(res, "alpha")
    assert (a["items_approved"], a["items_rejected"], a["approval_dumps"]) == (2, 2, 2)
    assert a["approval_rate"] == 0.5
    assert _m(res, "old")["approval_rate"] is None
    cl = next(r for r in res["by_stage"] if r["model"] == "alpha" and r["stage"] == "classify")
    assert cl["approval_rate"] == 0.5
    assert compare(30, "embed")["models"] == []
    _run("embed", "alpha", 10)
    assert _m(compare(30, "embed"), "alpha")["approval_rate"] is None       # approval only for classify


def test_failed_classify_run_is_not_credited_with_items():
    _dump(TAG + "3")
    _run("classify", "alpha", 100, ok=0, dump_id=TAG + "3")
    _item(TAG + "3", "approved")
    assert _m(compare(30), "alpha")["approval_rate"] is None


def test_trashed_and_private_dumps_excluded_but_dumpless_runs_kept():
    _dump(TAG + "ok"); _dump(TAG + "priv", private=1); _dump(TAG + "bin", trashed=True)
    _run("classify", "alpha", 100, dump_id=TAG + "ok")
    _run("classify", "secret", 100, dump_id=TAG + "priv")
    _run("classify", "gone", 100, dump_id=TAG + "bin")
    _run("ask", "askonly", 100)                                     # no dump at all
    _run("classify", "orphan", 100, dump_id=TAG + "deleted-forever")  # dump row no longer exists: kept
    assert {m["model"] for m in compare(30)["models"]} == {"alpha", "askonly", "orphan"}


def test_endpoint():
    _run("classify", "alpha", 100); _run("classify", "beta", 200)
    c = TestClient(create_app())
    j = c.get("/api/stats/models?days=90").json()
    assert j["days"] == 90 and len(j["models"]) == 2
    assert c.get("/api/stats/models?days=0&stage=classify").json()["days"] == 0
    assert c.get("/api/stats/models?stage=nope").json()["models"] == []
