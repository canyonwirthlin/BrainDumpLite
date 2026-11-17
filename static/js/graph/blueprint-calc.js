// Pure maths and rules for the Brain map "Link" mode (blueprint wires). No DOM and no imports, so it runs under node
// (tests/test_graph_links.py). The drawing and pointer handling live in blueprint.js.
//
// Geometry is in WORLD units unless a name says "px". A node is a circle {x, y, r}. A wire is a cubic bezier that leaves the
// side of one node that faces the other and enters the facing side of the other, with horizontal tangents (the node-editor
// look): curve = { p0, p1, p2, p3 }.

export const PORT_HIT_PX = 5;     // how close (screen px) to a port dot counts as "on the port"
export const NODE_SLACK_PX = 5;   // extra grab room around a node (screen px)
export const WIRE_HIT_PX = 7;     // how close (screen px) to a wire counts as on it

export const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

/** A link the user made by hand: the vault's manual dump links (stored with score 1) and accepted concept / person links. */
export const isManualEdge = (e) => !!e && (e.type === "manual" || (e.type === "similar" && (e.score ?? 0) >= 0.999));

export const kindOf = (n) => (n.type === "dump" ? "dump" : n.type === "concept" ? "concept" : n.type === "person" ? "person" : "item");

const short = (s, n = 30) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/**
 * Can a and b be linked, and what would it do?   existing(a, b) -> truthy when they are already linked in the way this
 * drop would link them.  Returns { ok, kind, duplicate, reason }; kind is one of dump-dump, dump-concept, dump-person, pair.
 * `reason` is the plain-English line shown under the pointer (why not, or what will happen).
 */
export function validateLink(a, b, existing) {
  if (!a || !b || a === b || a.id === b.id) return { ok: false, kind: null, duplicate: false, reason: "Drop it on a different note to link them." };
  const ka = kindOf(a), kb = kindOf(b);
  if (ka === "item" || kb === "item") {
    return { ok: false, kind: null, duplicate: false, reason: "Tasks and ideas belong to the note they were found in, so they can't be linked by hand. Link the note itself." };
  }
  let kind, what;
  if (ka === "dump" && kb === "dump") { kind = "dump-dump"; what = `Link “${short(a.label)}” to “${short(b.label)}”`; }
  else if (ka === "dump" || kb === "dump") {
    const d = ka === "dump" ? a : b, h = ka === "dump" ? b : a, hk = kindOf(h);
    kind = `dump-${hk}`;
    what = `Add the ${hk} “${short(h.label)}” to the note “${short(d.label)}”`;
  } else { kind = "pair"; what = `Link “${short(a.label)}” and “${short(b.label)}”`; }
  const dup = existing ? existing(a, b) : null;
  return { ok: true, kind, duplicate: !!dup, reason: dup ? "Already linked" : what };
}

/** The label of an undo entry / toast for a link between a and b. */
export const linkLabel = (a, b) => `“${short(a.label, 40)}” to “${short(b.label, 40)}”`;

// ── wires ────────────────────────────────────────────────────────────────────────────────────

/** Tangent length: grows with the distance so short wires stay tight and long ones swing. */
const tangent = (dx, dy) => Math.min(180, Math.max(12, 0.35 * Math.hypot(dx, dy)));

/** Where a wire between nodes a and b touches them: a's port facing b and b's port facing a (and the direction each leaves). */
export function wireEnds(a, b) {
  const dir = b.x >= a.x ? 1 : -1;
  return { a: { x: a.x + dir * a.r, y: a.y }, b: { x: b.x - dir * b.r, y: b.y }, dirA: dir, dirB: -dir };
}

/** The bezier between two nodes. */
export function wireCurve(a, b) {
  const e = wireEnds(a, b), k = tangent(e.b.x - e.a.x, e.b.y - e.a.y);
  return { p0: e.a, p1: { x: e.a.x + e.dirA * k, y: e.a.y }, p2: { x: e.b.x + e.dirB * k, y: e.b.y }, p3: e.b };
}

/** The bezier from node `a` to a free point (the pointer): leaves a's side that faces the point, arrives horizontally. */
export function wireCurveTo(a, pt) {
  const dir = pt.x >= a.x ? 1 : -1, p0 = { x: a.x + dir * a.r, y: a.y }, k = tangent(pt.x - p0.x, pt.y - p0.y);
  return { p0, p1: { x: p0.x + dir * k, y: p0.y }, p2: { x: pt.x - dir * k, y: pt.y }, p3: { x: pt.x, y: pt.y } };
}

export function bezierPoint(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

/** Distance from (x, y) to the curve, and the curve parameter of the closest point. Sampled, then refined once. */
export function distToCurve(c, x, y, steps = 28) {
  let best = { dist: Infinity, t: 0 };
  const at = (t) => { const p = bezierPoint(c, t); return Math.hypot(p.x - x, p.y - y); };
  for (let i = 0; i <= steps; i++) { const t = i / steps, d = at(t); if (d < best.dist) best = { dist: d, t }; }
  const lo = Math.max(0, best.t - 1 / steps), hi = Math.min(1, best.t + 1 / steps);
  for (let i = 0; i <= 8; i++) { const t = lo + ((hi - lo) * i) / 8, d = at(t); if (d < best.dist) best = { dist: d, t }; }
  return best;
}

// ── hit-testing ──────────────────────────────────────────────────────────────────────────────

/** The topmost visible node under world point (x, y): inside its circle plus a few px of grab room. */
export function nodeAt(nodes, x, y, scale, visible = () => true) {
  const slack = NODE_SLACK_PX / Math.max(0.3, scale);
  let best = null, bd = Infinity;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - x, n.y - y) - n.r;
    if (d <= slack && d < bd) { bd = d; best = n; }
  }
  return best;
}

/** "e" / "w" when (x, y) is on that port dot of node n (right / left edge), else null. */
export function portAt(n, x, y, scale) {
  const r = PORT_HIT_PX / Math.max(0.3, scale);
  if (Math.hypot(n.x + n.r - x, n.y - y) <= r) return "e";
  if (Math.hypot(n.x - n.r - x, n.y - y) <= r) return "w";
  return null;
}

/** The wire nearest to (x, y) within WIRE_HIT_PX: wires = [{ curve, ... }] -> { wire, t, dist } | null. */
export function wireAt(wires, x, y, scale) {
  const tol = WIRE_HIT_PX / Math.max(0.3, scale);
  let best = null;
  for (const w of wires) {
    const d = distToCurve(w.curve, x, y);
    if (d.dist <= tol && (!best || d.dist < best.dist)) best = { wire: w, t: d.t, dist: d.dist };
  }
  return best;
}
