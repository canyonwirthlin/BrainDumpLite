"""Focus features: correction factor math, "I have N minutes" fit, tags, timer/actual, habit streak edge cases."""
import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app
from app.routes_extra import habit_stats
from app.routes_focus import adjusted, correction_factor


@pytest.fixture
def client():
    c = TestClient(create_app())
    for t in ("items", "habit_log", "habits"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM settings WHERE key='focus_timers'")
    return c


def _task(client, content, est=None, tags=None):
    t = client.post("/api/tasks", json={"content": content}).json()
    if est:
        client.patch(f"/api/items/{t['id']}", json={"est_minutes": est})
    if tags is not None:
        assert client.put(f"/api/items/{t['id']}/tags", json={"tags": tags}).status_code == 200
    return t["id"]


# ── factor math ──────────────────────────────────────────────────────────────

def test_factor_needs_enough_samples():
    f = correction_factor([(10, 20), (10, 20)])
    assert f == {"factor": 1.0, "samples": 2, "applied": False}
    assert adjusted(30, f) == 30


def test_factor_is_geometric_mean():
    f = correction_factor([(10, 20), (20, 40), (30, 60)])
    assert f["applied"] and f["factor"] == 2.0 and f["samples"] == 3
    assert adjusted(25, f) == 50
    # 2x and 0.5x cancel out (a plain mean of ratios would say 1.25)
    assert correction_factor([(10, 20), (10, 5), (10, 10)])["factor"] == 1.0


def test_factor_ignores_missing_and_clamps_outliers():
    f = correction_factor([(0, 10), (10, 0), (None, 5), (10, 10), (10, 10), (10, 10)])
    assert f["samples"] == 3 and f["factor"] == 1.0
    big = correction_factor([(1, 1000), (10, 10), (10, 10)])   # 1000x clamps to 6x
    assert big["factor"] == round(6 ** (1 / 3), 2)
    assert adjusted(None, big) is None


def test_factor_uses_recent_window():
    old = [(10, 100)] * 60
    new = [(10, 10)] * 50
    assert correction_factor(old + new)["factor"] == 1.0


# ── endpoints ────────────────────────────────────────────────────────────────

def test_tags_validated_and_stored(client):
    tid = _task(client, "Buy milk", tags=["Errand", "errand", "home"])
    got = [t for t in client.get("/api/tasks").json() if t["id"] == tid][0]
    assert json.loads(got["tags"]) == ["errand", "home"]
    assert client.put(f"/api/items/{tid}/tags", json={"tags": ["mars"]}).status_code == 400
    assert client.put("/api/items/nope/tags", json={"tags": []}).status_code == 404
    client.put(f"/api/items/{tid}/tags", json={"tags": []})
    assert [t for t in client.get("/api/tasks").json() if t["id"] == tid][0]["tags"] is None


def test_fit_filters_by_minutes_tag_and_separates_unknown(client):
    a = _task(client, "quick email", est=5, tags=["pc"])
    b = _task(client, "laundry", est=25, tags=["home"])
    c = _task(client, "taxes", est=120, tags=["pc"])
    d = _task(client, "mystery", tags=["pc"])
    r = client.get("/api/focus/fit?minutes=30").json()
    assert [t["id"] for t in r["fits"]] == [b, a]          # biggest that fits first
    assert [t["id"] for t in r["unknown"]] == [d] and r["too_long"] == 1
    r = client.get("/api/focus/fit?minutes=30&tag=pc").json()
    assert [t["id"] for t in r["fits"]] == [a] and [t["id"] for t in r["unknown"]] == [d]
    assert client.get("/api/focus/fit?minutes=0").status_code == 400
    assert client.get("/api/focus/fit?minutes=10&tag=x").status_code == 400
    client.patch(f"/api/items/{c}", json={"done": True})
    assert client.get("/api/focus/fit?minutes=500").json()["too_long"] == 0


def test_actual_minutes_updates_factor_and_fit(client):
    ids = [_task(client, f"job {i}", est=10) for i in range(3)]
    for i in ids:
        r = client.post(f"/api/items/{i}/actual", json={"minutes": 20}).json()
        assert r["ratio"] == 2.0
    assert r["factor"]["applied"] and r["factor"]["factor"] == 2.0
    fresh = _task(client, "new thing", est=10)
    fit = client.get("/api/focus/fit?minutes=15").json()
    assert fit["fits"] == [] and fit["too_long"] >= 1          # 10m guess is really ~20m
    assert [t for t in client.get("/api/focus/fit?minutes=20").json()["fits"] if t["id"] == fresh][0]["adjusted_minutes"] == 20
    assert client.post(f"/api/items/{fresh}/actual", json={"minutes": 0}).status_code == 400


def test_timer_start_stop_records_minutes(client):
    t = _task(client, "timed", est=5)
    assert client.post(f"/api/items/{t}/actual", json={}).status_code == 400   # no timer, no minutes
    s = client.post(f"/api/items/{t}/timer/start").json()["started"]
    assert client.post(f"/api/items/{t}/timer/start").json()["started"] == s   # idempotent
    assert t in client.get("/api/focus/timers").json()
    r = client.post(f"/api/items/{t}/actual", json={}).json()
    assert r["actual_minutes"] == 1 and t not in client.get("/api/focus/timers").json()
    row = db.query_one("SELECT done, actual_minutes FROM items WHERE id=?", (t,))
    assert row["done"] == 1 and row["actual_minutes"] == 1


# ── habit streak edge cases ──────────────────────────────────────────────────

def _h(freq="daily", target=1):
    return {"id": "h", "title": "x", "notes": None, "frequency": freq, "target": target}


def _days(today, *backs):
    return {(today - timedelta(days=b)).isoformat() for b in backs}


def test_daily_missed_day_breaks_streak_but_pending_today_does_not():
    today = date(2026, 10, 7)
    assert habit_stats(_h(), _days(today, 1, 2, 3), today)["streak"] == 3       # today still pending
    assert habit_stats(_h(), _days(today, 2, 3, 4), today)["streak"] == 0       # yesterday missed
    s = habit_stats(_h(), _days(today, 0, 1, 3, 4, 5, 6), today)                # gap at day 2
    assert s["streak"] == 2 and s["best"] == 4


def test_daily_streak_across_month_and_year_rollover():
    today = date(2027, 1, 2)
    days = {"2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"}
    s = habit_stats(_h(), days, today)
    assert s["streak"] == 4 and s["done_today"]
    assert [d["day"] for d in s["days"]][-1] == "2027-01-02" and len(s["days"]) == 14


def test_weekly_target_streak_weeks_start_on_monday():
    today = date(2026, 10, 7)               # Wednesday; this week's Monday is Oct 5
    mon = date(2026, 10, 5)
    log = set()
    for w in (1, 2, 3):                    # three finished weeks with 3 check-ins each
        log |= {(mon - timedelta(days=7 * w - d)).isoformat() for d in (0, 2, 4)}
    s = habit_stats(_h("weekly", 3), log, today)
    assert s["streak"] == 3 and s["week_count"] == 0                            # running week doesn't break it
    log.add("2026-10-05")
    log.add("2026-10-06")
    s = habit_stats(_h("weekly", 3), log, today)
    assert s["streak"] == 3 and s["week_count"] == 2
    log.add("2026-10-07")
    assert habit_stats(_h("weekly", 3), log, today)["streak"] == 4              # this week now counts


def test_weekly_week_boundary_sunday_vs_monday_and_short_week():
    today = date(2026, 10, 12)              # Monday
    # Sun Oct 4 and Sun Oct 11 belong to the weeks starting Sep 28 and Oct 5 respectively
    log = {"2026-10-04", "2026-10-11"}
    s = habit_stats(_h("weekly", 1), log, today)
    assert s["streak"] == 2                 # both prior weeks hit; new week (Mon) pending
    assert habit_stats(_h("weekly", 2), {"2026-10-05", "2026-10-11"}, today)["streak"] == 1
    # a week with 2 of 3 breaks the chain
    broke = {"2026-09-28", "2026-09-29", "2026-09-30", "2026-10-05", "2026-10-06"}
    s = habit_stats(_h("weekly", 3), broke, date(2026, 10, 14))
    assert s["streak"] == 0 and s["best"] == 1


def test_malformed_logged_day_does_not_crash():
    today = date(2026, 10, 7)
    s = habit_stats(_h(), {"garbage", "2026-10-06"}, today)
    assert s["streak"] == 1 and s["total"] == 1


def test_habit_api_weekly_target_clamped_and_uncheck_future_rejected(client):
    h = client.post("/api/habits", json={"title": "Run", "frequency": "weekly", "target": 99}).json()
    assert h["target"] == 7
    d = client.post("/api/habits", json={"title": "Read"}).json()
    assert d["target"] == 1 and client.post("/api/habits", json={"title": "z", "frequency": "monthly"}).status_code == 400
    assert client.post(f"/api/habits/{d['id']}/check", json={"day": "10/07/2026"}).status_code == 400
