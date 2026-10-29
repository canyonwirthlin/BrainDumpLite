// Cluster outlines: a soft rounded shape behind each group of related notes (a community, see community.js), titled
// with the group's main topic. Works in any layout: the groups come from the links, the shapes from where the nodes
// currently are. Shapes are recomputed only when nodes have actually moved (and at most ~8 times a second), so a
// settled 2500-node map costs almost nothing per frame.
import { registerOverlay } from "./overlays.js";
import { communities } from "./community.js";
import { palette, groupColor, screenPx, haloText, fitText, isAlive, esc } from "./layout-util.js";

const MIN_MEMBERS = 4, MAX_GROUPS = 24, PAD = 15;

/** Convex hull (Andrew's monotone chain), counter-clockwise in numeric terms. */
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
const area = (h) => { let a = 0; for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; } return Math.abs(a) / 2; };

/** Trace the hull grown by `pad` with rounded corners (one path, so a single translucent fill never doubles up). */
function roundedPath(ctx, h, pad) {
  ctx.beginPath();
  if (h.length === 1) { ctx.arc(h[0][0], h[0][1], pad, 0, Math.PI * 2); return; }
  const n = h.length, TAU = Math.PI * 2;
  const ang = (i) => { const a = h[i], b = h[(i + 1) % n]; return Math.atan2(-(b[0] - a[0]), b[1] - a[1]); };   // outward normal of edge i
  for (let i = 0; i < n; i++) {
    const a = h[i], b = h[(i + 1) % n], t = ang(i), nx = Math.cos(t) * pad, ny = Math.sin(t) * pad;
    if (i === 0) ctx.moveTo(a[0] + nx, a[1] + ny); else ctx.lineTo(a[0] + nx, a[1] + ny);
    ctx.lineTo(b[0] + nx, b[1] + ny);
    let t2 = ang((i + 1) % n);
    while (t2 < t) t2 += TAU;
    ctx.arc(b[0], b[1], pad, t, t2, false);
  }
  ctx.closePath();
}

function build(api) {
  if (!api.nodes.length) return { cm: null };
  const cm = communities(api.nodes, api.edges);
  const rank = new Map(cm.list.map((c, i) => [c.id, i]));
  return { cm, rank, sig: NaN, at: 0, hulls: [], pending: false, nodesRef: api.nodes };
}

function members(api, st, c) {
  const out = [];
  for (const id of c.nodeIds) { const n = api.byId[id]; if (n && isAlive(api, n)) out.push(n); }
  return out;
}

/** Groups -> hulls from the nodes' current positions. Outliers are trimmed, loose (spread-out) groups are skipped. */
function geometry(api, st) {
  const nodes = api.nodes;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y; }
  const total = Math.max(1, ((x1 - x0) * (y1 - y0)) * 0.7);
  const hulls = [];
  for (const c of st.cm.list) {
    if (c.size < MIN_MEMBERS || hulls.length >= MAX_GROUPS) continue;
    let ms = members(api, st, c);
    if (ms.length < MIN_MEMBERS) continue;
    if (ms.length >= 6) {   // drop strays far from the group's middle so one outlier doesn't stretch the outline
      const mx = ms.reduce((s, n) => s + n.x, 0) / ms.length, my = ms.reduce((s, n) => s + n.y, 0) / ms.length;
      const d = ms.map((n) => Math.hypot(n.x - mx, n.y - my)), sorted = d.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      const lim = Math.max(2.4 * med, 70);
      const kept = ms.filter((_, i) => d[i] <= lim);
      if (kept.length >= MIN_MEMBERS) ms = kept;
    }
    const hull = convexHull(ms.map((n) => [n.x, n.y]));
    // a group whose notes are scattered across the map (timeline lanes, ego rings ...) has no honest outline
    if (hull.length >= 3 && area(hull) * (nodes.length / ms.length) > total * 1.7) continue;
    const cx = ms.reduce((s, n) => s + n.x, 0) / ms.length;
    let top = Infinity; for (const p of hull) if (p[1] < top) top = p[1];
    hulls.push({ id: c.id, label: c.topLabel, rank: st.rank.get(c.id) || 0, hull, cx, top, size: ms.length });
  }
  return hulls;
}

function refresh(api, st) {
  if (!st || !st.cm) return [];
  const now = performance.now();
  let sig = api.nodes.length * 7;
  for (const n of api.nodes) sig += n.x * 0.37 + n.y * 0.73;
  const alive = api.timelapse && api.timelapse.playing ? api.nodes.reduce((s, n) => s + (isAlive(api, n) ? 1 : 0), 0) : 0;
  sig += alive * 1.7;
  if (Math.abs(sig - st.sig) > 0.5 || Number.isNaN(st.sig)) {
    if (!Number.isNaN(st.sig) && now - st.at < 120) {
      if (!st.pending) { st.pending = true; setTimeout(() => { st.pending = false; api.requestDraw(); }, 130); }
      return st.hulls;
    }
    st.hulls = geometry(api, st); st.sig = sig; st.at = now;
  }
  return st.hulls;
}

registerOverlay({
  id: "hulls", label: "Cluster outlines", icon: "⭕",
  desc: "Draws a soft outline around each group of related notes and names it after its main topic, in any layout. Where a layout spreads a group out (like the timeline), or already draws its own groups (Cluster islands), no outline is added.",
  load: (api) => build(api),
  drawUnder(ctx, api, st) {
    if (!st || !st.cm || (api.layout && api.layout.noHulls) || st.nodesRef !== api.nodes) return;
    const P = palette(api), s = api.view.scale;
    const hulls = refresh(api, st);
    ctx.save();
    ctx.lineJoin = "round";
    for (const h of hulls) {
      roundedPath(ctx, h.hull, PAD);
      ctx.fillStyle = groupColor(h.rank, P.light, P.light ? 0.11 : 0.1); ctx.fill();
      ctx.lineWidth = 1.4 / s; ctx.strokeStyle = groupColor(h.rank, P.light, 0.5); ctx.stroke();
    }
    ctx.restore();
  },
  drawOver(ctx, api, st) {
    if (!st || !st.cm || (api.layout && api.layout.noHulls) || st.nodesRef !== api.nodes) return;
    const P = palette(api), s = api.view.scale;
    const placed = [];
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (const h of [...st.hulls].sort((a, b) => b.size - a.size)) {
      if (!h.label) continue;
      const px = Math.min(16, 11 + Math.sqrt(h.size) * 0.55);
      ctx.font = `600 ${screenPx(api, px)}px sans-serif`;
      const text = fitText(ctx, h.label, 190 / s), w = ctx.measureText(text).width, y = h.top - PAD - 5 / s, hh = px / s;
      const box = { x0: h.cx - w / 2, x1: h.cx + w / 2, y0: y - hh, y1: y + hh * 0.3 };
      if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) continue;
      placed.push(box);
      haloText(ctx, text, h.cx, y, groupColor(h.rank, P.light, 1), P.bg, 4 / s);
    }
    ctx.restore();

  },
  info(n, st) {
    if (!st || !st.cm) return "";
    const c = st.cm.list.find((g) => g.id === st.cm.communityOf.get(n.id));
    if (!c || c.size < MIN_MEMBERS || !c.topLabel) return "";
    return `<div class="small muted" style="margin-top:10px">Part of the “${esc(c.topLabel)}” group · ${c.size} items</div>`;
  },
});
