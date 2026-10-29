// Placement + force simulation as plain functions (no DOM, no module state), so layouts can call and tune them.
//
// A "sim" is { nodes, edges, byId, nbrIds, N, alpha, decay }: the engine builds one per mount and mutates
// sim.alpha (the cooling temperature) as it runs. `env` is { W, H, spacing } - the canvas size in CSS px and the
// current Spacing slider value. `forces` is a layout's knob object merged over DEFAULT_FORCES.

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
  collidePad: 10,      // px of breathing room kept between node discs
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

/** Galaxy: every dump gets a fixed slot on a time-ordered sunflower (oldest at the centre, newest on the rim),
 *  concepts/people sit at the centre of the dumps that mention them, and items orbit their dump. Sets tx/ty
 *  (the targets physics anchors to) and starts each node on its target. */
export function placeGalaxy(sim, env) {
  const { nodes, byId, nbrIds: nbrs } = sim;
  const cx = env.W / 2, cy = env.H / 2;
  const dumps = nodes.filter((n) => n.type === "dump").sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  // Slot spacing shrinks as the history grows, but never below 30px; with few dumps the spiral is
  // widened to a minimum radius so a young map isn't one tight clump.
  const step = Math.max(30, 230 / Math.sqrt(dumps.length + 2)) * env.spacing;
  dumps.forEach((n, i) => { const r = step * Math.sqrt(i + 2), th = i * GOLDEN; n.tx = cx + r * Math.cos(th); n.ty = cy + r * Math.sin(th); });
  const rim = step * Math.sqrt(dumps.length + 2);
  nodes.filter((n) => n.type !== "dump" && !n.dump).forEach((n) => {   // hubs: concepts, people
    const ds = (nbrs[n.id] || []).map((id) => byId[id]).filter((m) => m && m.type === "dump" && m.tx != null);
    if (ds.length) {   // centre of its dumps, nudged along a per-node angle so hubs sharing the same dumps don't stack
      const a = hash01(n.id) * Math.PI * 2, off = step * 0.7;
      n.tx = ds.reduce((s, m) => s + m.tx, 0) / ds.length + Math.cos(a) * off;
      n.ty = ds.reduce((s, m) => s + m.ty, 0) / ds.length + Math.sin(a) * off;
    }
    else { const a = hash01(n.id) * Math.PI * 2; n.tx = cx + Math.cos(a) * rim * 1.1; n.ty = cy + Math.sin(a) * rim * 1.1; }
  });
  nodes.filter((n) => n.dump).forEach((n) => {   // items orbit their dump
    const d = byId[n.dump], a = hash01(n.id) * Math.PI * 2;
    const bx = d && d.tx != null ? d.tx : cx, by = d && d.ty != null ? d.ty : cy;
    n.tx = bx + Math.cos(a) * 16; n.ty = by + Math.sin(a) * 16;
  });
  nodes.forEach((n) => { n.x = n.tx + (Math.random() - 0.5) * 4; n.y = n.ty + (Math.random() - 0.5) * 4; });
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
