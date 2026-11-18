"""Model comparison for the Stats page: per provider/model (and per pipeline stage) numbers derived from
the `runs` table, plus one quality signal that stored data can honestly support.

What a `runs` row can and cannot say (see app/instrument.py):
- one row per model call: stage, provider, model, wall ms, prompt/completion tokens (when the provider
  reports them), ok, error;
- `ok = 0` on the cleanup and classify stages means the pipeline FELL BACK (raw text / heuristics). On other
  stages it is a plain error. A model answer the pipeline discarded as runaway output is still `ok = 1`:
  that is not recorded, so it is not counted here;
- quality: for classify runs we look at the tasks/ideas the model produced and how the user judged them
  (`items.status` approved vs rejected). Pending ("suggested") items are not counted. Whether the user EDITED
  an item or a person is not stored, so there is no edit rate.

Runs of trashed or private dumps are excluded (they join `dumps`); runs with no dump (Ask, follow-ups
without a dump id) are kept.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from statistics import median

from fastapi import APIRouter

from . import db

router = APIRouter()

FALLBACK_STAGES = ("cleanup", "classify")
LOCAL_PROVIDERS = ("builtin", "local")
RANGES = (7, 30, 90, 0)        # 0 = all time


def _p90(values: list[float]) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, int(round((len(s) - 1) * 0.9)))] if s else 0.0


def _since(days: int) -> str | None:
    if not days or days <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=min(int(days), 3650))).isoformat()


def _runs(since: str | None, stage: str | None) -> list[dict]:
    sql = ("SELECT r.* FROM runs r LEFT JOIN dumps d ON d.id = r.dump_id "
           f"WHERE (d.id IS NULL OR (d.deleted_at IS NULL AND {db.PRIVATE_SQL}))")
    args: list = []
    if since:
        sql += " AND r.started_at >= ?"; args.append(since)
    if stage:
        sql += " AND r.stage = ?"; args.append(stage)
    return [dict(r) for r in db.query(sql + " ORDER BY r.started_at", tuple(args))]


def _approval(since: str | None) -> dict[tuple, dict]:
    """{(provider, model): {"approved": n, "rejected": n, "dumps": n}} from each dump's latest ok classify run.
    Re-processing replaces a dump's items, so only the newest classify run owns the items that exist now."""
    sql = ("SELECT r.dump_id, r.provider, r.model, r.started_at FROM runs r JOIN dumps d ON d.id = r.dump_id "
           f"WHERE r.stage='classify' AND r.ok=1 AND d.deleted_at IS NULL AND {db.PRIVATE_SQL}")
    args: list = []
    if since:
        sql += " AND r.started_at >= ?"; args.append(since)
    latest: dict[str, dict] = {}
    for r in db.query(sql + " ORDER BY r.started_at", tuple(args)):
        latest[r["dump_id"]] = dict(r)
    if not latest:
        return {}
    counts = {r["dump_id"]: (r["a"] or 0, r["x"] or 0) for r in db.query(
        "SELECT dump_id, SUM(status='approved') AS a, SUM(status='rejected') AS x FROM items GROUP BY dump_id")}
    out: dict[tuple, dict] = {}
    for did, r in latest.items():
        a, x = counts.get(did, (0, 0))
        if a + x == 0:
            continue
        o = out.setdefault((r["provider"], r["model"]), {"approved": 0, "rejected": 0, "dumps": 0})
        o["approved"] += a; o["rejected"] += x; o["dumps"] += 1
    return out


def _row(provider, model, runs: list[dict], stage: str | None = None) -> dict:
    n = len(runs)
    ok = sum(1 for r in runs if r["ok"])
    ms = [r["ms"] for r in runs]
    fb = [r for r in runs if r["stage"] in FALLBACK_STAGES]
    fb_fail = sum(1 for r in fb if not r["ok"])
    with_out = [r for r in runs if r["ok"] and (r["completion_tokens"] or 0) > 0 and r["ms"] > 0]
    with_in = [r for r in runs if (r["prompt_tokens"] or 0) > 0]
    out_ms = sum(r["ms"] for r in with_out)
    return {
        "provider": provider, "model": model, "stage": stage, "local": provider in LOCAL_PROVIDERS,
        "runs": n, "ok": ok, "errors": n - ok, "success_rate": round(ok / n, 3),
        "fallback_runs": len(fb), "fallbacks": fb_fail,
        "fallback_rate": round(fb_fail / len(fb), 3) if fb else None,
        "median_ms": int(median(ms)), "p90_ms": int(_p90(ms)),
        "token_runs": len(with_out),
        "avg_out_tokens": round(sum(r["completion_tokens"] for r in with_out) / len(with_out), 1) if with_out else None,
        "avg_in_tokens": round(sum(r["prompt_tokens"] for r in with_in) / len(with_in), 1) if with_in else None,
        "tokens_per_sec": round(sum(r["completion_tokens"] for r in with_out) / (out_ms / 1000), 1) if with_out and out_ms else None,
        "items_approved": None, "items_rejected": None, "approval_rate": None, "approval_dumps": 0,
    }


def compare(days: int = 30, stage: str | None = None) -> dict:
    """Per-model rows (`models`), per model-and-stage rows (`by_stage`), the stages seen, and plain-English notes."""
    days = int(days) if days is not None else 30
    if days not in RANGES:
        days = max(0, min(3650, days))
    since = _since(days)
    stage = (stage or "").strip() or None
    runs = _runs(since, stage)
    stages = sorted({r["stage"] for r in _runs(since, None)}) if stage else sorted({r["stage"] for r in runs})
    groups: dict[tuple, list[dict]] = {}
    sub: dict[tuple, list[dict]] = {}
    for r in runs:
        prov, mod = r["provider"] or "?", r["model"] or "?"
        groups.setdefault((prov, mod), []).append(r)
        sub.setdefault((prov, mod, r["stage"]), []).append(r)
    models = [_row(p, m, rs) for (p, m), rs in groups.items()]
    by_stage = [_row(p, m, rs, st) for (p, m, st), rs in sub.items()]
    quality_on = stage in (None, "classify")
    if quality_on:
        appr = _approval(since)
        for row in models + [b for b in by_stage if b["stage"] == "classify"]:
            a = appr.get((row["provider"], row["model"]))
            if a:
                dec = a["approved"] + a["rejected"]
                row.update(items_approved=a["approved"], items_rejected=a["rejected"],
                           approval_rate=round(a["approved"] / dec, 3), approval_dumps=a["dumps"])
    models.sort(key=lambda r: -r["runs"])
    by_stage.sort(key=lambda r: (-r["runs"], r["stage"]))
    notes = [
        "Latency is wall time per call, so on a cloud model it includes the network.",
        "Tokens per second is output tokens divided by that wall time (prompt processing included); it is only "
        "shown for calls where the provider reported output tokens.",
        "A failed cleanup or classify call means the pipeline fell back to your raw text or to simple heuristics. "
        "A model answer that was thrown away as runaway output still counts as a success; that is not recorded.",
        "Item approval is the share of tasks/ideas you approved versus rejected on dumps this model classified "
        "(newest classify run per dump; items you have not decided on are ignored). "
        "Whether you edited an item or a person is not stored, so there is no edit rate.",
        "Runs on trashed or private dumps are left out.",
    ]
    if not quality_on:
        notes.append("Item approval only applies to the classify stage, so it is blank for this stage filter.")
    return {"days": days, "stage": stage, "runs": len(runs), "stages": stages, "models": models,
            "by_stage": by_stage, "notes": notes, "min_models": 2}


@router.get("/stats/models")
def get_model_stats(days: int = 30, stage: str | None = None):
    return compare(days, stage)
