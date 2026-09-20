"""Streak math + word counts (app/streaks.py)."""
from datetime import date, timedelta

from app import db, streaks
from app.main import create_app


def _dump(days_ago: int, text: str = "one two three"):
    create_app()
    did = db.new_id()
    d = date.today() - timedelta(days=days_ago)
    local = f"{d.isoformat()}T09:00:00-05:00"
    db.execute(
        "INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, status, captured_local) "
        "VALUES (?,?,?,?,?, 'ready', ?)",
        (did, db.now_iso(), "freeform", text, text, local))
    return did


def test_no_dumps_is_zero():
    create_app()
    r = streaks.compute()
    assert r == {"current_streak": 0, "at_risk": False, "longest_streak": 0,
                 "average_streak": 0, "active_days": 0, "total_streaks": 0}


def test_streak_alive_today_and_broken_after_gap():
    create_app()
    for i in (0, 1, 2):
        _dump(i)
    r = streaks.compute()
    assert r["current_streak"] == 3 and not r["at_risk"] and r["longest_streak"] == 3
    db.execute("DELETE FROM dumps")


def test_streak_at_risk_when_today_is_empty():
    create_app()
    _dump(1)
    _dump(2)
    r = streaks.compute()
    assert r["current_streak"] == 2 and r["at_risk"] is True
    db.execute("DELETE FROM dumps")


def test_streak_broken_after_two_day_gap():
    create_app()
    _dump(2)
    _dump(3)
    r = streaks.compute()
    assert r["current_streak"] == 0 and r["at_risk"] is False and r["longest_streak"] == 2
    db.execute("DELETE FROM dumps")


def test_average_and_longest_across_multiple_runs():
    create_app()
    for i in (0, 1):          # run of 2, ending today
        _dump(i)
    for i in (5, 6, 7):       # older run of 3
        _dump(i)
    r = streaks.compute()
    assert r["longest_streak"] == 3
    assert r["total_streaks"] == 2
    assert r["average_streak"] == 2.5
    db.execute("DELETE FROM dumps")


def test_word_counts_bucket_by_calendar_period():
    create_app()
    today = date.today()
    _dump(0, "one two three four five")            # this week/month/year
    if today.day > 1:
        _dump(min(today.day - 1, 3), "six seven")  # still this month
    w = streaks.word_stats()
    assert w["week"] >= 5
    assert w["alltime"] >= w["year"] >= w["month"] >= w["week"] >= 5
    db.execute("DELETE FROM dumps")
