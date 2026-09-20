"""Daily dump streaks + word counts for the Statistics tab.

A "streak day" is any local calendar date with at least one dump. Gained by
dumping at least once a day; lost the moment a full day passes with nothing —
same rule Snapchat uses (today doesn't break yesterday's streak until today
itself ends with nothing captured).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from . import db


def _local_date(iso: str) -> date | None:
    try:
        return datetime.fromisoformat(iso).astimezone().date()
    except (ValueError, TypeError):
        return None


def _dump_dates() -> set[date]:
    out = set()
    for r in db.query("SELECT captured_local, created_at FROM dumps"):
        d = _local_date(r["captured_local"] or r["created_at"])
        if d:
            out.add(d)
    return out


def _runs(dates: set[date]) -> list[int]:
    """Lengths of every consecutive-day run in the set, oldest first."""
    if not dates:
        return []
    ordered = sorted(dates)
    runs, cur = [], 1
    for prev, nxt in zip(ordered, ordered[1:]):
        if nxt - prev == timedelta(days=1):
            cur += 1
        else:
            runs.append(cur)
            cur = 1
    runs.append(cur)
    return runs


def compute() -> dict:
    dates = _dump_dates()
    today = date.today()
    runs = _runs(dates)
    # Current streak: the run ending today, or ending yesterday if today has
    # nothing YET — a streak is only lost once today itself passes empty.
    current, at_risk = 0, False
    if today in dates:
        cursor = today
    elif today - timedelta(days=1) in dates:
        cursor, at_risk = today - timedelta(days=1), True
    else:
        cursor = None
    if cursor:
        d = cursor
        while d in dates:
            current += 1
            d -= timedelta(days=1)
    return {
        "current_streak": current,
        "at_risk": at_risk and current > 0,
        "longest_streak": max(runs, default=0),
        "average_streak": round(sum(runs) / len(runs), 1) if runs else 0,
        "active_days": len(dates),
        "total_streaks": len(runs),
    }


def _word_count(text: str | None) -> int:
    return len(text.split()) if text else 0


def word_stats() -> dict:
    today = date.today()
    week_start = today - timedelta(days=today.weekday())          # Monday
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)
    week = month = year = alltime = 0
    for r in db.query("SELECT captured_local, created_at, clean_text, raw_text FROM dumps"):
        d = _local_date(r["captured_local"] or r["created_at"])
        if not d:
            continue
        n = _word_count(r["clean_text"] or r["raw_text"])
        alltime += n
        if d >= year_start:
            year += n
            if d >= month_start:
                month += n
                if d >= week_start:
                    week += n
    return {"week": week, "month": month, "year": year, "alltime": alltime}
