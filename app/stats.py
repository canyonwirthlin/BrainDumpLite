"""Stats (Phase 7): summaries of the `runs` table plus a daily sample of vault
size and dump count (`stats_daily`, written once per local day at boot)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from statistics import median

from . import catalog, db


def sample_daily() -> None:
    today = date.today().isoformat()
    try:
        dumps = db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"]
        size = db.db_path().stat().st_size if db.db_path().exists() else 0
        db.execute("INSERT OR REPLACE INTO stats_daily (date, dumps, db_bytes) VALUES (?,?,?)", (today, dumps, size))
    except Exception as e:  # never block boot
        print(f"[stats] daily sample skipped: {e}", flush=True)


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(round((len(s) - 1) * p)))]


def summary(days: int = 30) -> dict:
    days = max(1, min(365, int(days)))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    runs = [dict(r) for r in db.query("SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at", (since,))]
    by_stage: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    prices = catalog.prices()
    for r in runs:
        st = by_stage.setdefault(r["stage"], {"stage": r["stage"], "calls": 0, "ok": 0, "ms": []})
        st["calls"] += 1; st["ok"] += r["ok"]; st["ms"].append(r["ms"])
        key = f"{r['provider'] or '?'}/{r['model'] or '?'}"
        pv = by_provider.setdefault(key, {"provider": r["provider"], "model": r["model"], "calls": 0, "ok": 0,
                                          "prompt_tokens": 0, "completion_tokens": 0, "ms": []})
        pv["calls"] += 1; pv["ok"] += r["ok"]; pv["ms"].append(r["ms"])
        pv["prompt_tokens"] += r["prompt_tokens"] or 0
        pv["completion_tokens"] += r["completion_tokens"] or 0
    stages = []
    for st in by_stage.values():
        stages.append({"stage": st["stage"], "calls": st["calls"], "success_rate": round(st["ok"] / st["calls"], 3),
                       "median_ms": int(median(st["ms"])), "p90_ms": int(_pct(st["ms"], 0.9))})
    providers = []
    for pv in by_provider.values():
        price = prices.get(f"{pv['provider']}/{pv['model']}")
        cost = None
        if price:
            cost = round(pv["prompt_tokens"] / 1e6 * price["input"] + pv["completion_tokens"] / 1e6 * price["output"], 4)
        providers.append({**{k: v for k, v in pv.items() if k != "ms"},
                          "success_rate": round(pv["ok"] / pv["calls"], 3), "median_ms": int(median(pv["ms"])),
                          "local": pv["provider"] in ("builtin", "local"), "est_cost_usd": cost})
    per_day: dict[str, int] = {}
    for r in db.query("SELECT created_at FROM dumps WHERE created_at >= ?", (since,)):
        try:
            d = datetime.fromisoformat(r["created_at"])
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            per_day[d.astimezone().date().isoformat()] = per_day.get(d.astimezone().date().isoformat(), 0) + 1
        except ValueError:
            pass
    growth = [dict(r) for r in db.query("SELECT date, dumps, db_bytes FROM stats_daily WHERE date >= ? ORDER BY date",
                                        ((date.today() - timedelta(days=days)).isoformat(),))]
    return {"days": days, "calls": len(runs), "success_rate": round(sum(r["ok"] for r in runs) / len(runs), 3) if runs else None,
            "stages": sorted(stages, key=lambda s: s["stage"]), "providers": sorted(providers, key=lambda p: -p["calls"]),
            "dumps_per_day": [{"date": k, "dumps": v} for k, v in sorted(per_day.items())],
            "growth": growth, "total_dumps": db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"],
            "db_bytes": db.db_path().stat().st_size if db.db_path().exists() else 0}
