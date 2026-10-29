// Cluster islands: the map is split into communities of notes, people and topics that belong together; each gets its
// own round island (bigger island = more members) labelled with its main topic, and the members are laid out inside it.
// The few links that cross between islands are drawn faintly. Island shapes come from community.js, so they are
// stable: the same data always gives the same islands in the same places.
import { registerLayout } from "./layouts.js";
import { GOLDEN, hash01 } from "./physics.js";
import { communities } from "./community.js";
import { isHub, palette, groupColor, rgba, screenPx, haloText, fitText, clamp, cmp } from "./layout-util.js";

const MAX_ISLANDS = 30, MIN_MEMBERS = 3, CROSS_BUDGET = 600;
const LOOSE = "Loose notes";
let isl = { list: [], of: new Map(), cross: null };

/** Pack circles (already sorted big to small) close together without overlap: each goes to the nearest free spot to the middle. */
function pack(radii, gap) {
  const out = [];
  radii.forEach((r, i) => {
    if (!i) { out.push({ x: 0, y: 0 }); return; }
    const phase = hash01("pack" + i) * Math.PI * 2;
    for (let d = radii[0] * 0.5; ; d += 6) {
      const steps = Math.max(12, Math.round((2 * Math.PI * d) / 18));
      let best = null;
      for (let k = 0; k < steps; k++) {
        const a = phase + (k / steps) * Math.PI * 2, x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (out.every((q, j) => Math.hypot(q.x - x, q.y - y) >= radii[j] + r + gap)) { best = { x, y }; break; }
      }
      if (best) { out.push(best); return; }
    }
  });
  return out;
}

function build(api) {
  const { W, H, spacing } = api.env();
  const nodes = api.nodes;
  const cm = communities(nodes, api.edges);
  // tiny communities (and anything past the cap) share one "Loose notes" island so the map isn't dust
  const big = cm.list.filter((c) => c.size >= MIN_MEMBERS).slice(0, MAX_ISLANDS);
  const bigIds = new Set(big.map((c) => c.id));
  const groups = big.map((c) => ({ id: c.id, label: c.topLabel || "Notes", ids: c.nodeIds.slice() }));
  const loose = [];
  cm.list.forEach((c) => { if (!bigIds.has(c.id)) loose.push(...c.nodeIds); });
  if (loose.length) groups.push({ id: "loose", label: LOOSE, ids: loose, loose: true });

  if (!groups.length) { isl = { list: [], of: new Map(), keep: new Set(), crossTotal: 0 }; return; }
  const avgR = nodes.reduce((s, n) => s + n.r, 0) / Math.max(1, nodes.length);
  const step = clamp(2 * avgR + 12, 24, 38) * spacing, c = step / 1.9;
  groups.forEach((g, i) => {
    g.rank = i;
    g.members = g.ids.map((id) => api.byId[id]).filter(Boolean);
    g.R = c * Math.sqrt(g.members.length + 0.5) + step * 0.9;
  });
  const centres = pack(groups.map((g) => g.R), 30 * spacing);
  const x0 = Math.min(...groups.map((g, i) => centres[i].x - g.R)), x1 = Math.max(...groups.map((g, i) => centres[i].x + g.R));
  const y0 = Math.min(...groups.map((g, i) => centres[i].y - g.R)), y1 = Math.max(...groups.map((g, i) => centres[i].y + g.R));
  const ox = W / 2 - (x0 + x1) / 2, oy = H / 2 - (y0 + y1) / 2;
  const of = new Map();
  groups.forEach((g, i) => {
    g.cx = centres[i].x + ox; g.cy = centres[i].y + oy;
    g.members.forEach((n) => of.set(n.id, g));
    // hubs in the middle (busiest first), then the rest by how connected they are; items ride beside their dump
    const core = g.members.filter((n) => !n.dump).sort((a, b) => (isHub(b) - isHub(a)) || b.deg - a.deg || cmp(a.id, b.id));
    const phase = hash01(g.id) * Math.PI * 2;
    core.forEach((n, k) => { const r = c * Math.sqrt(k + 0.5), th = phase + k * GOLDEN; n.tx = g.cx + r * Math.cos(th); n.ty = g.cy + r * Math.sin(th); });
    g.members.filter((n) => n.dump).forEach((n) => {
      const d = api.byId[n.dump], a = hash01(n.id) * Math.PI * 2;
      n.tx = (d && d.tx != null ? d.tx : g.cx) + Math.cos(a) * 15; n.ty = (d && d.ty != null ? d.ty : g.cy) + Math.sin(a) * 15;
    });
  });
  // a deterministic, bounded sample of the links that cross between islands
  const cross = api.edges.filter((e) => of.get(e.source) !== of.get(e.target)).map((e) => ({ e, k: hash01(e.source + e.target) }));
  cross.sort((a, b) => a.k - b.k);
  const keep = new Set(cross.slice(0, CROSS_BUDGET).map((x) => x.e));
  isl = { list: groups, of, keep, crossTotal: cross.length };
}

function place(api) {
  build(api);
  for (const n of api.nodes) { if (n.tx != null) { n.x = n.tx + (hash01(n.id) - 0.5) * 6; n.y = n.ty + (hash01(n.id + "y") - 0.5) * 6; } }
}

registerLayout({
  id: "islands", label: "Cluster islands", icon: "🏝️",
  desc: "Finds the groups of notes, people and topics that belong together and gives each its own island, labelled with its main topic. Bigger islands hold more of your thinking, and the faint lines between them are the bridges between different parts of your life.",
  noHulls: true,   // the islands already are the outlines: the Cluster outlines overlay would draw a second set on top
  forces: { repulsion: 0.35, reach: 90, linkPull: 0.3, centerPull: 0, anchor: 0.1 },
  hint: "Each island is one group of related notes, people and topics, named after its main topic. Faint lines between islands are the few links that connect different groups.",
  note: (api) => (api.nodes.length < 4 ? "Islands need a few more dumps to form. Keep capturing and your notes will start to cluster into groups here." : null),
  place,
  relayout(api) {
    build(api);
    api.reheat();
  },
  edgeStyle(e) {
    const a = isl.of.get(e.source), b = isl.of.get(e.target);
    if (a && a === b) return { alpha: 1.4 };
    return isl.keep && isl.keep.has(e) ? { alpha: 0.5, width: 0.9 } : false;
  },
  drawUnder(ctx, api) {
    if (!isl.list.length) return;
    const P = palette(api), s = api.view.scale;
    ctx.save();
    isl.list.forEach((g) => {
      const fill = g.loose ? rgba(P.text, 0.035) : groupColor(g.rank, P.light, P.light ? 0.1 : 0.085);
      const edge = g.loose ? rgba(P.text, 0.2) : groupColor(g.rank, P.light, 0.5);
      ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5 / s; ctx.strokeStyle = edge; ctx.setLineDash(g.loose ? [6 / s, 5 / s] : []); ctx.stroke(); ctx.setLineDash([]);
    });
    // names sit on each island's rim, sized by island, always readable on screen
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    isl.list.forEach((g) => {
      if (g.R * s < 24) return;
      const px = clamp(g.R * s * 0.19, 11.5, 18), subPx = Math.max(10.5, px * 0.78);
      const dumps = g.members.filter((n) => n.type === "dump").length;
      const sub = String(dumps || g.members.length);
      ctx.font = `600 ${px / s}px sans-serif`;
      const name = fitText(ctx, g.label, Math.max(70 / s, g.R * 1.9));
      const nw = ctx.measureText(name).width;
      ctx.font = `${subPx / s}px sans-serif`;
      const sw = ctx.measureText(sub).width, gap = 6 / s, x = g.cx - (nw + gap + sw) / 2, y = g.cy - g.R;
      ctx.font = `600 ${px / s}px sans-serif`;
      haloText(ctx, name, x, y, g.loose ? P.dim : groupColor(g.rank, P.light, 1), P.bg, 5 / s);
      ctx.font = `${subPx / s}px sans-serif`;
      haloText(ctx, sub, x + nw + gap, y + 0.5 / s, P.dim, P.bg, 4 / s);
    });
    ctx.restore();
  },
});
