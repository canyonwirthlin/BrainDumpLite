"""Brain map: dot size follows mentions, the K most mentioned get names, the galaxy no longer piles up. Real runs of
sizing.js and physics.js under Node (no browser)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "static" / "js" / "graph"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run(script: str) -> dict:
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_radius_grows_with_mentions_and_labels_rank_by_mentions():
    res = run("""
import { mentionCounts, maxHubMentions, radiusFor, rankedForLabels } from %s;
const nodes = [], edges = [];
const hub = (id, type, n) => { nodes.push({ id, label: id, type }); for (let i = 0; i < n; i++) { const d = id + '-d' + i; nodes.push({ id: d, label: d, type: 'dump' }); edges.push({ source: d, target: id, type: 'mention' }); } };
hub('concept:big', 'concept', 9); hub('person:mid', 'person', 4); hub('concept:small', 'concept', 1);
nodes.push({ id: 'task1', label: 't', type: 'task', dump: 'concept:big-d0' });
edges.push({ source: 'concept:big-d0', target: 'concept:big', type: 'mention' });   // a duplicate link must not count twice
const c = mentionCounts(nodes, edges), max = maxHubMentions(nodes, c);
const r = (id, on = true) => radiusFor(nodes.find((n) => n.id === id), c.get(id), max, on);
console.log(JSON.stringify({ big: c.get('concept:big'), mid: c.get('person:mid'), max,
  rBig: r('concept:big'), rMid: r('person:mid'), rSmall: r('concept:small'), task: r('task1'),
  off: r('concept:big', false), offSmall: r('concept:small', false),
  ranked: rankedForLabels(nodes, c) }));
""" % json.dumps((GRAPH / "sizing.js").as_uri()))
    assert (res["big"], res["mid"], res["max"]) == (9, 4, 9)
    assert res["rBig"] > res["rMid"] > res["rSmall"]
    assert res["rBig"] - res["rSmall"] > 15          # the busiest node is unmistakably bigger
    assert res["task"] == 3.5                        # items stay small
    assert res["off"] - res["offSmall"] < 10         # Off keeps the old, gentle look
    assert res["ranked"] == ["concept:big", "person:mid", "concept:small"]   # hubs only, most mentioned first


def test_layout_supplied_mentions_win_over_edges():
    res = run("""
import { mentionCounts } from %s;
const nodes = [{ id: 'a', label: 'a', type: 'concept', meta: { mentions: 7 } }, { id: 'b', label: 'b', type: 'concept', meta: {} }];
const c = mentionCounts(nodes, [{ source: 'a', target: 'b', type: 'co', weight: 2 }]);
console.log(JSON.stringify({ a: c.get('a'), b: c.get('b') }));
""" % json.dumps((GRAPH / "sizing.js").as_uri()))
    assert res == {"a": 7, "b": 1}


def test_galaxy_targets_do_not_overlap_and_spread_out():
    res = run("""
import { makeSim, placeGalaxy, hash01 } from %s;
const nodes = [], edges = [];
for (let h = 0; h < 14; h++) nodes.push({ id: 'concept:h' + h, label: 'h' + h, type: 'concept', r: 5 + (h %% 5) * 4 });
for (let i = 0; i < 120; i++) {
  const d = { id: 'd' + i, label: 'd' + i, type: 'dump', r: 7, created_at: new Date(2026, 0, 1 + i).toISOString() }; nodes.push(d);
  for (let k = 0; k < 3; k++) edges.push({ source: d.id, target: 'concept:h' + Math.floor(hash01(d.id + k) * 14), type: 'mention' });
}
nodes.forEach((n) => { n.w = 1; n.deg = 0; n.fx = null; n.x = 0; n.y = 0; n.tx = null; n.ty = null; });
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const sim = makeSim(nodes, edges, byId);
placeGalaxy(sim, { W: 1200, H: 700, spacing: 1 });
let worst = Infinity, finite = true;
for (let i = 0; i < nodes.length; i++) {
  if (!Number.isFinite(nodes[i].x) || !Number.isFinite(nodes[i].y)) finite = false;
  for (let j = i + 1; j < nodes.length; j++) { const a = nodes[i], b = nodes[j]; worst = Math.min(worst, Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r)); }
}
console.log(JSON.stringify({ worst, finite, rings: !!sim.galaxy }));
""" % json.dumps((GRAPH / "physics.js").as_uri()))
    assert res["finite"] and res["rings"]
    assert res["worst"] > 2, "every pair of nodes keeps clear air between their discs"
