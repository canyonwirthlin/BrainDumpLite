// Placement + force simulation as plain functions (no DOM, no module state), so layouts can call and tune them.
//
// A "sim" is { nodes, edges, byId, nbrIds, N, alpha, decay }: the engine builds one per mount and mutates
// sim.alpha (the cooling temperature) as it runs. `env` is { W, H, spacing } - the canvas size in CSS px and the
// current Spacing slider value. `forces` is a layout's knob object merged over DEFAULT_FORCES.

import { communities } from "./community.js";

export const GOLDEN = 2.399963;
export const hash01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };

/** Knobs a layout can override through its `forces` field. */
export const DEFAULT_FORCES = {
  repulsion: 1,        // multiplier on node-node repulsion (0 = none)
  reach: 380,          // px (before Spacing) over which nodes repel / collide
  linkPull: 1,         // multiplier on edge springs (0 = edges don't pull)
  linkLength: 1,       // multiplier on resting edge length
  centerPull: 0.007,   // pull towards the middle of the canvas for nodes that have no target
  anchor: 0,           // pull towards a node's tx/ty target: number, or (node) => strength (0 = none)
  collide: 0.35,       // how hard overlapping nodes shove apart
  collidePad: 14,      // px of breathing room kept between node discs
};

/** Build the simulation state for a node/edge set (nodes must already carry r, w, deg, x, y, vx, vy, fx, fy). */
export function makeSim(nodes, edges, byId) {
  const N = nodes.length;
  const nbrIds = {};
  edges.forEach((e) => { (nbrIds[e.source] ||= []).push(e.target); (nbrIds[e.target] ||= []).push(e.source); });
  const decay = Math.pow(0.001, 1 / (N > 400 ? 600 : N > 120 ? 450 : 320));   // bigger graphs cool slower so they finish untangling
  return { nodes, edges, byId, nbrIds, N, alpha: 1, decay };
}

// ── starting positions ────────────────────────────────────────────────────────────────────────
// Never a random pile: a sunflower (phyllotaxis) spiral with the best-connected nodes in the middle, so the
// simulation begins already spread out and just has to relax.

/** Organic: hubs (anything with 2+ links) go on the sunflower, best-connected in the middle; the one-link leaves
 *  then start fanned out evenly around their hub instead of scattered, so the map doesn't open as a tangle. */
export function placeOrganic(sim, env) {
  const { nodes, byId, nbrIds: nbr } = sim;
  const cx = env.W / 2, cy = env.H / 2;
  const hubs = nodes.filter((n) => n.deg > 1 || !(nbr[n.id] || []).length).sort((a, b) => b.deg - a.deg);
  const c = 62 * env.spacing;
  hubs.forEach((n, i) => {
    const r = c * Math.sqrt(i + 0.5), th = i * GOLDEN;
    n.x = cx + r * Math.cos(th); n.y = cy + r * Math.sin(th);
  });
  const fanned = {};
  nodes.filter((n) => n.deg === 1 && (nbr[n.id] || []).length).forEach((n) => {
    const h = byId[nbr[n.id][0]];
    const k = fanned[h.id] = (fanned[h.id] || 0) + 1;
    const a = k * GOLDEN + hash01(h.id) * 6.28, r = (60 + 9 * Math.sqrt(k)) * env.spacing;
    n.x = (h.x ?? cx) + r * Math.cos(a); n.y = (h.y ?? cy) + r * Math.sin(a);
  });
}

/** Push overlapping targets (tx, ty) apart until every pair of nodes has at least `pad` of air between their discs.
 *  Deterministic (no Math.random) and grid-bucketed, so it costs about the same on 3000 nodes as a few physics steps.
 *  Layouts that hold nodes on fixed targets call this so the targets themselves never pile up. */
export function spreadTargets(nodes, pad, rounds = 80) {
  const list = nodes.filter((n) => n.tx != null);
  const N = list.length;
  if (N < 2) return;
  let maxR = 0;
  for (const a of list) maxR = Math.max(maxR, a.r || 0);
  const cell = 2 * maxR + pad;
  const dx = new Float64Array(N), dy = new Float64Array(N);
  for (let it = 0; it < rounds; it++) {
    const grid = new Map();
    list.forEach((a, i) => { const k = Math.floor(a.tx / cell) * 100003 + Math.floor(a.ty / cell); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    dx.fill(0); dy.fill(0);
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const a = list[i], gx = Math.floor(a.tx / cell), gy = Math.floor(a.ty / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get((gx + ox) * 100003 + (gy + oy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = list[j];
          let ex = a.tx - b.tx, ey = a.ty - b.ty, d = Math.hypot(ex, ey);
          const gap = (a.r || 0) + (b.r || 0) + pad;
          if (d >= gap) continue;
          if (d < 0.01) { const t = hash01(a.id + b.id) * 6.2832; ex = Math.cos(t); ey = Math.sin(t); d = 1; }
          const push = ((gap - d) / 2) * 0.7 / d;
          dx[i] += ex * push; dy[i] += ey * push; dx[j] -= ex * push; dy[j] -= ey * push;
          hits++;
        }
      }
    }
    if (!hits) break;
    for (let i = 0; i < N; i++) { list[i].tx += dx[i]; list[i].ty += dy[i]; }
  }
}

/** Galaxy: a time-ordered spiral with one arm per topic. Every dump gets a slot (oldest at the centre, newest on the
 *  rim) on the arm of the topic group it belongs to (community.js); concepts and people sit among the dumps that
 *  mention them, so ideas that span topics land between the arms; items orbit their dump. Targets are then spread so
 *  nothing overlaps. Sets tx/ty (the targets physics anchors to) and starts each node on its target. */
export function placeGalaxy(sim, env) {
  const { nodes, byId, nbrIds: nbrs } = sim;
  const cx = env.W / 2, cy = env.H / 2, sp = env.spacing;
  const dumps = nodes.filter((n) => n.type === "dump").sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || (a.id < b.id ? -1 : 1));
  const nD = dumps.length;
  // one arm per sizeable topic group (at most 8); everything else is dealt onto an arm by a stable hash
  const armOf = new Map();
  let arms = 1;
  try {
    const big = communities(nodes, sim.edges).list.filter((c) => c.size >= 3).slice(0, 8);
    arms = Math.max(1, big.length);
    big.forEach((c, a) => c.nodeIds.forEach((id) => armOf.set(id, a)));
  } catch { /* no community data: a single arm, which is the classic spiral */ }
  const wedge = (Math.PI * 2) / arms;
  const step = Math.max(38, 270 / Math.sqrt(nD + 2)) * sp;
  dumps.forEach((n, i) => {
    const t = (i + 2) / (nD + 2), r = step * Math.sqrt(i + 2);
    const arm = armOf.has(n.id) ? armOf.get(n.id) : Math.floor(hash01(n.id) * arms);
    const th = arm * wedge + 3.0 * Math.sqrt(t) + (hash01(n.id + "a") - 0.5) * wedge * 0.55;   // the twist bends each arm into a spiral
    n.tx = cx + r * Math.cos(th); n.ty = cy + r * Math.sin(th);
  });
  const rim = step * Math.sqrt(nD + 2);
  nodes.filter((n) => n.type !== "dump" && !n.dump).forEach((n) => {   // hubs: concepts, people
    const ds = (nbrs[n.id] || []).map((id) => byId[id]).filter((m) => m && m.type === "dump" && m.tx != null);
    if (ds.length) {   // the middle of its dumps (so a cross-topic idea sits between arms), kept off the very centre
      let x = ds.reduce((s, m) => s + m.tx, 0) / ds.length - cx, y = ds.reduce((s, m) => s + m.ty, 0) / ds.length - cy;
      const meanR = ds.reduce((s, m) => s + Math.hypot(m.tx - cx, m.ty - cy), 0) / ds.length, d = Math.hypot(x, y), floor = meanR * 0.55;
      if (d < floor) { const a = d > 1 ? Math.atan2(y, x) : hash01(n.id) * Math.PI * 2; x = Math.cos(a) * floor; y = Math.sin(a) * floor; }
      n.tx = cx + x; n.ty = cy + y;
    } else { const a = hash01(n.id) * Math.PI * 2; n.tx = cx + Math.cos(a) * rim * 1.1; n.ty = cy + Math.sin(a) * rim * 1.1; }
  });
  nodes.filter((n) => n.dump).forEach((n) => {   // items orbit their dump
    const d = byId[n.dump], a = hash01(n.id) * Math.PI * 2, o = (d ? d.r : 7) + (n.r || 3.5) + 6;
    const bx = d && d.tx != null ? d.tx : cx, by = d && d.ty != null ? d.ty : cy;
    n.tx = bx + Math.cos(a) * o; n.ty = by + Math.sin(a) * o;
  });
  spreadTargets(nodes, 9 * sp);
  nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
  sim.galaxy = { cx, cy, step, times: dumps.map((d) => Date.parse(d.created_at || "") || 0) };   // what the layout's time rings are drawn from
}

// ── one physics step ──────────────────────────────────────────────────────────────────────────
// Repulsion falls off as 1/distance (not 1/d²) and reaches across the map, so clusters push each other apart
// instead of collapsing into one blob; a spatial grid keeps it fast. Links are weaker on hubs (a hub with 40
// links isn't crushed into a point), nodes can't overlap, and a gentle pull to the middle stops separate
// clusters drifting away.
export function step(sim, forces, env) {
  const { nodes, edges, byId, N } = sim;
  const k = sim.alpha;
  const reach = forces.reach * env.spacing, cell = reach;
  const grid = new Map();
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    const key = Math.floor(n.x / cell) * 100003 + Math.floor(n.y / cell);
    (grid.get(key) || grid.set(key, []).get(key)).push(i);
  }
  const charge = 1500 * env.spacing * env.spacing * (N > 250 ? 1 + Math.log10(N / 250) : 1) * forces.repulsion;
  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get((gx + ox) * 100003 + (gy + oy));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
        const d = Math.sqrt(d2);
        if (d > reach) continue;
        let f = forces.repulsion ? (charge / d) * k * 0.05 * Math.sqrt(a.w * b.w) : 0;
        const gap = a.r + b.r + forces.collidePad;
        if (d < gap) f += (gap - d) * forces.collide;           // collision: overlapping nodes shove apart
        if (!f) continue;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
  }
  edges.forEach((e) => {
    const a = byId[e.source], b = byId[e.target];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const target = (e.type === "similar" ? 130 : e.type === "in" ? 34 : 80) * env.spacing * (1 + 0.1 * Math.sqrt(Math.max(a.deg, b.deg))) * forces.linkLength;   // busy hubs get longer spokes so their neighbours fit around them
    const strength = 1 / Math.sqrt(Math.max(1, Math.min(a.deg, b.deg)));
    const f = (d - target) * 0.06 * strength * forces.linkPull * k;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  });
  const gcx = env.W / 2, gcy = env.H / 2;
  const anchor = forces.anchor;
  nodes.forEach((n) => {
    const g = n.tx != null && anchor ? (typeof anchor === "function" ? anchor(n) : anchor) : 0;
    if (g) { n.vx += (n.tx - n.x) * g; n.vy += (n.ty - n.y) * g; }
    else { n.vx += (gcx - n.x) * forces.centerPull * k; n.vy += (gcy - n.y) * forces.centerPull * k; }
  });
  nodes.forEach((n) => {
    if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; return; }
    n.vx *= 0.72; n.vy *= 0.72;
    n.x += Math.max(-40, Math.min(40, n.vx)); n.y += Math.max(-40, Math.min(40, n.vy));
  });
  sim.alpha *= sim.decay;
}
