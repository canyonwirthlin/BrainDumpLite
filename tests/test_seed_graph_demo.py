"""The brain-map demo seeder (scripts/seed_graph_demo.py) runs in a subprocess against its own temp vault, so it
never mixes with the shared test vault; the assertions are made by a second subprocess that loads that vault."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "scripts" / "seed_graph_demo.py"

_INSPECT = """
import json, sys
sys.path.insert(0, %r)
from app import db, graph
db.init_db()
g = graph.build(items=True)
labels = [n["label"] for n in g["nodes"]]
print(json.dumps({
    "dumps": db.query_one("SELECT COUNT(*) n FROM dumps WHERE id != ?", (db.MANUAL_DUMP_ID,))["n"],
    "node_types": sorted({n["type"] for n in g["nodes"]}),
    "dump_nodes": sum(1 for n in g["nodes"] if n["type"] == "dump"),
    "concept_nodes": sum(1 for n in g["nodes"] if n["type"] == "concept"),
    "edge_types": sorted({e["type"] for e in g["edges"]}),
    "node_ids": [n["id"] for n in g["nodes"]],
    "labels": labels,
    "all_edges_resolve": all(e["source"] in {n["id"] for n in g["nodes"]} and e["target"] in {n["id"] for n in g["nodes"]} for e in g["edges"]),
    "onboarded": db.get_setting("onboarded"),
    "trashed_deleted": db.query_one("SELECT deleted_at FROM dumps WHERE id='seed-trashed'")["deleted_at"] is not None,
    "private_flag": db.query_one("SELECT is_private FROM dumps WHERE id='seed-private'")["is_private"],
    "lonely": db.query_one("SELECT COUNT(*) n FROM dumps WHERE concepts='[]' AND people='[]' AND status='ready' AND id NOT IN ('seed-trashed','seed-private')")["n"],
    "overdue_open_tasks": db.query_one("SELECT COUNT(*) n FROM items WHERE kind='task' AND done=0 AND due_date < date('now')")["n"],
    "done_tasks": db.query_one("SELECT COUNT(*) n FROM items WHERE kind='task' AND done=1")["n"],
    "kinds": sorted({r["kind"] for r in db.query("SELECT DISTINCT kind FROM items")}),
    "span_days": db.query_one("SELECT julianday(MAX(created_at)) - julianday(MIN(created_at)) d FROM dumps WHERE id != ?", (db.MANUAL_DUMP_ID,))["d"],
    "tone_ok": all(set(json.loads(r["tone"])) == {"label", "valence", "energy"} for r in db.query("SELECT tone FROM dumps WHERE tone IS NOT NULL")),
}))
""" % str(ROOT)


def _run(args, data, **kw):
    env = {**os.environ, "BRAINDUMP_LITE_DATA": str(data)}
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=120, **kw)


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    data = tmp_path_factory.mktemp("seeded-vault")
    r = _run([sys.executable, str(SEED), "--dumps", "140"], data)
    assert r.returncode == 0, r.stderr
    r = _run([sys.executable, "-c", _INSPECT], data)
    assert r.returncode == 0, r.stderr
    return data, json.loads(r.stdout.strip().splitlines()[-1])


def test_counts_and_shape(seeded):
    _, s = seeded
    assert s["dumps"] == 140
    assert s["onboarded"] is True
    assert s["dump_nodes"] == 138               # 140 minus the trashed and the private dump
    assert {"dump", "concept", "person", "task"} <= set(s["node_types"])
    assert {"mention", "similar", "in"} <= set(s["edge_types"])
    assert s["concept_nodes"] >= 40
    assert s["all_edges_resolve"]
    assert s["tone_ok"]
    assert s["span_days"] > 400                 # roughly 18 months of history
    assert s["lonely"] >= 3
    assert s["overdue_open_tasks"] >= 1 and s["done_tasks"] >= 1
    assert {"task", "goal", "idea", "concern", "event", "note"} <= set(s["kinds"])


def test_trashed_and_private_excluded(seeded):
    _, s = seeded
    assert s["trashed_deleted"] and s["private_flag"] == 1
    assert "seed-trashed" not in s["node_ids"] and "seed-private" not in s["node_ids"]
    assert not any("TrashedOnlyConcept" in lbl or "PrivateOnlyConcept" in lbl for lbl in s["labels"])
    assert not any("Excluded task" in lbl for lbl in s["labels"])


def test_refuses_without_env_or_on_non_empty_vault(seeded, tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "BRAINDUMP_LITE_DATA"}
    r = subprocess.run([sys.executable, str(SEED)], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "BRAINDUMP_LITE_DATA" in (r.stdout + r.stderr)
    data, _ = seeded
    r = _run([sys.executable, str(SEED), "--dumps", "20"], data)
    assert r.returncode != 0 and "--force" in (r.stdout + r.stderr)
    r = _run([sys.executable, str(SEED), "--dumps", "20", "--force"], data)
    assert r.returncode == 0, r.stderr


def test_deterministic_and_scales(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    for d in (a, b):
        assert _run([sys.executable, str(SEED), "--dumps", "30"], d).returncode == 0
    ra, rb = (_run([sys.executable, "-c", _INSPECT], d) for d in (a, b))
    ja, jb = json.loads(ra.stdout.strip().splitlines()[-1]), json.loads(rb.stdout.strip().splitlines()[-1])
    assert ja["labels"] == jb["labels"] and ja["dumps"] == 30
