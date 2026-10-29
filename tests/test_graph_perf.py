"""Brain map performance work: the large-map threshold, the typed-array physics core (checked against the original
physics.step under Node), the main-thread driver, and structural guards for the worker."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "static" / "js" / "graph"
NODE = shutil.which("node")


def _run(script: str) -> str:
    out = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", script], capture_output=True, text=True,
                         timeout=120, cwd=str(ROOT))
    assert out.returncode == 0, out.stdout + out.stderr
    return out.stdout


def test_threshold_is_one_explicit_constant():
    src = (GRAPH / "perf.js").read_text(encoding="utf-8")
    assert re.search(r"DEFAULT_PERF_NODES = 1500;", src)
    assert "export const PERF_NODES" in src and "export const isLargeMap" in src
    engine = (GRAPH / "engine.js").read_text(encoding="utf-8")
    assert "isLargeMap(N)" in engine, "the engine must gate every large-map path on the shared constant"
    assert not re.search(r"\b1500\b", engine), "no second copy of the threshold in the engine"


def test_worker_is_a_module_worker_over_the_shared_core():
    worker = (GRAPH / "physics-worker.js").read_text(encoding="utf-8")
    assert 'from "./physics-core.js"' in worker and "self.onmessage" in worker
    driver = (GRAPH / "sim-large.js").read_text(encoding="utf-8")
    assert 'new Worker(new URL("./physics-worker.js", import.meta.url), { type: "module" })' in driver
    assert "worker.terminate()" in driver and "toInline" in driver   # terminated on dispose, falls back when it cannot run


def test_engine_terminates_the_simulation_when_the_map_goes_away():
    engine = (GRAPH / "engine.js").read_text(encoding="utf-8")
    assert engine.count("drv?.dispose()") >= 2   # rebuild / dispose() and the "view switched away" branch of tick()


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_threshold_gating():
    out = _run(f"""
import {{ PERF_NODES, isLargeMap }} from {(GRAPH / 'perf.js').as_uri()!r};
console.log(JSON.stringify([PERF_NODES, isLargeMap(140), isLargeMap(1500), isLargeMap(1501), isLargeMap(2615)]));
""")
    assert out.strip() == "[1500,false,false,true,true]"


_GRAPH_SETUP = """
import { makeSim, step, DEFAULT_FORCES, placeOrganic, placeGalaxy } from %r;
import { packSim, createCore, coreStep, coreRun } from %r;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function build(N) {
  const nodes = [], edges = [];
  for (let i = 0; i < N; i++) nodes.push({ id: 'n' + i, type: i %% 5 === 0 ? 'concept' : 'dump', created_at: new Date(2024, 0, 1 + i).toISOString(), deg: 0, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, tx: null, ty: null, r: 5, w: 1 });
  for (let i = 0; i < N; i++) { const k = 1 + Math.floor(rnd() * 3); for (let j = 0; j < k; j++) { const t = Math.floor(rnd() * N); if (t !== i) edges.push({ source: nodes[i].id, target: nodes[t].id, type: rnd() < 0.2 ? 'similar' : 'mention' }); } }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  edges.forEach((e) => { byId[e.source].deg++; byId[e.target].deg++; });
  nodes.forEach((n) => { n.r = 5 + Math.min(9, n.deg * 1.1); n.w = 1 + 0.45 * Math.sqrt(n.deg); });
  return { nodes, edges };
}
const clone = (g) => { const nodes = g.nodes.map((n) => ({ ...n })); return { nodes, edges: g.edges, byId: Object.fromEntries(nodes.map((n) => [n.id, n])) }; };
""" % ((GRAPH / "physics.js").as_uri(), (GRAPH / "physics-core.js").as_uri())


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_core_matches_the_original_physics_step():
    out = _run(_GRAPH_SETUP + """
const cases = [
  [300, 'organic', {}],
  [800, 'organic', {}],
  [700, 'galaxy', { repulsion: 0, reach: 60, linkPull: 0.25, anchor: (n) => (n.type === 'dump' ? 0.12 : 0.03) }],
  [500, 'islands', { repulsion: 0.35, reach: 90, linkPull: 0.3, centerPull: 0, anchor: 0.1 }],
];
const res = [];
for (const [N, layout, forces] of cases) {
  const g = build(N), F = { ...DEFAULT_FORCES, ...forces }, env = { W: 1500, H: 900, spacing: 1 };
  const a = clone(g), b = clone(g);
  const simA = makeSim(a.nodes, a.edges, a.byId);
  (layout === 'galaxy' ? placeGalaxy : placeOrganic)(simA, env);
  if (layout === 'islands') a.nodes.forEach((n) => { n.tx = n.x; n.ty = n.y; });
  b.nodes.forEach((n, i) => { n.x = a.nodes[i].x; n.y = a.nodes[i].y; n.tx = a.nodes[i].tx; n.ty = a.nodes[i].ty; });
  for (const q of [a, b]) { const p = q.nodes[3]; p.fx = p.x = 42; p.fy = p.y = 17; }   // one pinned node
  const core = createCore(packSim(b.nodes, b.edges, F, env, 1, simA.decay));
  let maxd = 0;
  for (let it = 0; it < 12; it++) {
    step(simA, F, env); coreStep(core);
    for (let i = 0; i < N; i++) maxd = Math.max(maxd, Math.abs(a.nodes[i].x - core.x[i]), Math.abs(a.nodes[i].y - core.y[i]));
  }
  res.push([N, layout, maxd < 1e-3, core.x[3] === 42 && core.y[3] === 17, Math.abs(simA.alpha - core.alpha) < 1e-12]);
}
console.log(JSON.stringify(res));
""")
    import json
    for n, layout, close, pinned, alpha_ok in json.loads(out.strip().splitlines()[-1]):
        assert close, f"{layout} {n}: positions diverged from physics.step"
        assert pinned and alpha_ok, f"{layout} {n}"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_inline_driver_settles_pins_and_reheats():
    out = _run(_GRAPH_SETUP + """
import { createLargeSim } from %r;
const g = build(400), c = clone(g), env = { W: 1500, H: 900, spacing: 1 };
placeOrganic(makeSim(c.nodes, c.edges, c.byId), env);
const drv = createLargeSim({ nodes: c.nodes, edges: c.edges, forces: { ...DEFAULT_FORCES }, getEnv: () => env, alpha: 1, decay: Math.pow(0.001, 1 / 300), useWorker: false });
let guard = 0;
while (drv.alpha > 0.01 && guard++ < 2000) { drv.run(5); drv.pull(); }
const settled = drv.alpha <= 0.01, finite = c.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
// pin a node somewhere else: it must go there and stay
const n = c.nodes[7]; n.fx = n.x = 123; n.fy = n.y = -45; drv.syncPins(); drv.setAlpha(0.3);
for (let i = 0; i < 40; i++) { drv.run(5); drv.pull(); }
const pinnedOk = n.x === 123 && n.y === -45;
// release it: it is free again and the simulation reacts to the reheat
n.fx = null; n.fy = null; drv.syncPins(); drv.setAlpha(0.3);
const before = [n.x, n.y];
for (let i = 0; i < 40; i++) { drv.run(5); drv.pull(); }
const freed = Math.hypot(n.x - before[0], n.y - before[1]) > 0.5;
drv.dispose();
console.log(JSON.stringify({ mode: drv.mode, settled, finite, pinnedOk, freed }));
""" % (GRAPH / "sim-large.js").as_uri())
    import json
    res = json.loads(out.strip().splitlines()[-1])
    assert res == {"mode": "inline", "settled": True, "finite": True, "pinnedOk": True, "freed": True}
