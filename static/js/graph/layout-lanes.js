// Topic timeline: time runs left to right, one horizontal lane per top concept or person (busiest first, at most 14).
// Every dump is a dot in the lane of its strongest topic, at the date it was written; a thin vertical thread links it
// to the other lanes it touches. A soft bar along each lane shows when that topic was alive.
import { registerLayout } from "./layouts.js";
import { hash01 } from "./physics.js";
import {
  buildModel, dumpTime, isHub, palette, rgba, groupColor, screenPx, haloText, fitText, clamp, cmp, isAlive,
  monthStarts, monthName,
} from "./layout-util.js";

const MAX_LANES = 14, OTHER = "Everything else";
// Geometry of the current map, rebuilt by prepare() (topics) and place() (pixels).
const G = { lanes: [], laneOf: new Map(), others: new Map(), hidden: 0, nDumps: 0, hasOther: false, x0: 0, x1: 0, t0: 0, t1: 0, gutter: 0, top: 0, bottom: 0, left: 0, laneTop: [], laneH: [], span: [], lineCache: null };

let measure = null;
function textWidth(text, font) {
  try { measure ||= document.createElement("canvas").getContext("2d"); measure.font = font; return measure.measureText(text).width; } catch { return text.length * 7; }
}

function prepare(data) {
  const m = buildModel(data.nodes, data.edges);
  const ranked = m.hubs.filter((h) => (m.dumpsOf.get(h.id) || []).length)
    .map((h) => ({ n: h, c: m.dumpsOf.get(h.id).length }))
    .sort((a, b) => b.c - a.c || cmp(a.n.label.toLowerCase(), b.n.label.toLowerCase()) || cmp(a.n.id, b.n.id));
  const lanes = ranked.slice(0, MAX_LANES).map((r, i) => ({ id: r.n.id, label: r.n.label, type: r.n.type, mentions: r.c, idx: i }));
  const idx = new Map(lanes.map((l) => [l.id, l.idx]));
  const laneOf = new Map(), others = new Map();
  let hasOther = false;
  for (const d of m.dumps) {
    const mine = (m.hubsOf.get(d.id) || []).map((h) => idx.get(h)).filter((i) => i != null).sort((a, b) => a - b);
    if (!mine.length) { laneOf.set(d.id, lanes.length); hasOther = true; continue; }
    laneOf.set(d.id, mine[0]);
    if (mine.length > 1) others.set(d.id, mine.slice(1));
  }
  if (hasOther) lanes.push({ id: "~other", label: OTHER, type: "other", mentions: [...laneOf.values()].filter((i) => i === lanes.length).length, idx: lanes.length });
  Object.assign(G, { lanes, laneOf, others, hasOther, hidden: ranked.length - Math.min(ranked.length, MAX_LANES), nDumps: m.dumps.length, model: m });
  const keepHubs = new Set(lanes.map((l) => l.id));
  const dumpIds = new Set(m.dumps.map((d) => d.id));
  const nodes = data.nodes.filter((n) => (isHub(n) ? keepHubs.has(n.id) : n.dump ? dumpIds.has(n.dump) : true));
  return { nodes, edges: data.edges };
}

/** x for a time; the data's date range stretched over `width`. */
const xAt = (t) => G.x0 + ((t - G.t0) / (G.t1 - G.t0)) * (G.x1 - G.x0);

function place(api) {
  const { W, H, spacing } = api.env();
  const dumps = api.nodes.filter((n) => n.type === "dump");
  const times = dumps.map(dumpTime).filter((t) => t > 0);
  let t0 = Math.min(...times), t1 = Math.max(...times);
  if (!times.length) { t1 = Date.now(); t0 = t1 - 30 * 864e5; }
  if (t1 - t0 < 20 * 864e5) { const mid = (t0 + t1) / 2; t0 = mid - 10 * 864e5; t1 = mid + 10 * 864e5; }
  const pad = (t1 - t0) * 0.025;
  G.t0 = t0 - pad; G.t1 = t1 + pad;
  const width = (640 + Math.min(2600, dumps.length * 7)) * spacing;
  G.x0 = 0; G.x1 = width;

  // dots: smaller than in the other layouts, since a lane can be crowded (and smaller still for a very big history)
  const dens = dumps.length > 400 ? clamp(Math.sqrt(400 / dumps.length), 0.45, 1) : 1;
  for (const n of api.nodes) {
    if (isHub(n)) n.r = 8;
    else if (n.type === "dump") n.r = clamp(n.r * 0.6 * dens, 2, 8.5);
    else n.r = Math.min(n.r, 3.2);
  }
  // beeswarm per lane: dots keep their date on x and nudge vertically only as far as needed not to overlap
  const nl = G.lanes.length;
  const perLane = Array.from({ length: nl }, () => []);
  for (const d of dumps) { const li = G.laneOf.get(d.id); if (li != null && perLane[li]) perLane[li].push({ n: d, x: xAt(dumpTime(d) || G.t0), y: 0 }); }
  const extent = new Array(nl).fill(0);
  perLane.forEach((list, li) => {
    list.sort((a, b) => a.x - b.x || cmp(a.n.id, b.n.id));
    const placed = [];
    let start = 0;
    const maxR = list.reduce((m, c) => Math.max(m, c.n.r), 0);
    for (const c of list) {
      while (start < placed.length && placed[start].x < c.x - maxR * 2 - 3) start++;
      let y = 0;
      for (let k = 0; k < 600; k++) {
        y = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 3;
        let ok = true;
        for (let j = start; j < placed.length; j++) {
          const q = placed[j], dx = q.x - c.x, dy = q.y - y, need = q.n.r + c.n.r + 1.5;
          if (dx * dx + dy * dy < need * need) { ok = false; break; }
        }
        if (ok) break;
      }
      c.y = y; placed.push(c);
      extent[li] = Math.max(extent[li], Math.abs(y) + c.n.r);
    }
  });
  // lane heights follow how crowded each lane is; the gutter holds the labels
  const minH = 44 * spacing;
  G.laneH = extent.map((e) => clamp(2 * e + 16 * spacing, minH, 3000));
  G.laneTop = []; let y = 0;
  G.laneH.forEach((h) => { G.laneTop.push(y); y += h; });
  G.top = 0; G.bottom = y;
  const labelPx = Math.min(190, Math.max(60, ...G.lanes.map((l) => textWidth(l.label, "600 12px sans-serif")))) + 34;
  const bw = width, bh = Math.max(60, y);
  const s = Math.min((W - 110 - labelPx) / bw, (H - 130) / bh, 1.6);   // the zoom the engine's fit() will land on, so the gutter fits the labels
  G.gutter = labelPx / clamp(s, 0.05, 1.6);
  G.left = -G.gutter;
  const cy = (li) => G.laneTop[li] + G.laneH[li] / 2;
  perLane.forEach((list, li) => list.forEach((c) => { c.n.x = c.n.tx = c.x; c.n.y = c.n.ty = cy(li) + c.y; }));
  const hubLane = new Map(G.lanes.map((l) => [l.id, l.idx]));
  for (const n of api.nodes) {
    if (isHub(n)) { const li = hubLane.get(n.id); n.x = n.tx = G.left; n.y = n.ty = li != null ? cy(li) : 0; }
    else if (n.dump) {
      const d = api.byId[n.dump], a = hash01(n.id) * Math.PI * 2;
      const bx = d ? d.x : 0, by = d ? d.y : 0;
      n.x = n.tx = bx + Math.cos(a) * ((d ? d.r : 6) + 4); n.y = n.ty = by + Math.sin(a) * ((d ? d.r : 6) + 4);
    }
  }
  // lane life spans
  G.span = G.lanes.map((l, i) => {
    let lo = Infinity, hi = -Infinity;
    const ids = l.id === "~other" ? [] : G.model.dumpsOf.get(l.id) || [];
    for (const id of ids) { const d = api.byId[id]; if (!d) continue; if (d.x < lo) lo = d.x; if (d.x > hi) hi = d.x; }
    return lo <= hi ? [lo, hi] : null;
  });
  G.lineCache = null;
}

const laneY = (li) => G.laneTop[li] + G.laneH[li] / 2;

function drawUnder(ctx, api) {
  if (!G.lanes.length || !G.laneTop.length) return;
  const P = palette(api), s = api.view.scale, light = P.light;
  const left = G.left - 12 / s, right = G.x1 + 16 / s;
  const sel = api.selectedId, hov = api.hoverId;
  const focusHub = [hov, sel].map((id) => id && api.byId[id]).find((n) => n && isHub(n));
  const focusLane = focusHub ? G.lanes.findIndex((l) => l.id === focusHub.id) : -1;
  const focusDump = [hov, sel].map((id) => id && api.byId[id]).find((n) => n && n.type === "dump");
  ctx.save();
  ctx.lineCap = "round";
  // lane bands
  G.lanes.forEach((l, i) => {
    const top = G.laneTop[i], h = G.laneH[i];
    ctx.fillStyle = rgba(P.text, i % 2 ? 0.03 : 0.012);
    ctx.fillRect(left, top, right - left, h);
    if (i === focusLane) { ctx.fillStyle = groupColor(i, light, 0.13); ctx.fillRect(left, top, right - left, h); }
  });
  ctx.strokeStyle = rgba(P.text, 0.08); ctx.lineWidth = 1 / s;
  ctx.beginPath();
  G.laneTop.forEach((t, i) => { ctx.moveTo(left, t); ctx.lineTo(right, t); if (i === G.laneTop.length - 1) { ctx.moveTo(left, t + G.laneH[i]); ctx.lineTo(right, t + G.laneH[i]); } });
  ctx.stroke();

  // time grid + axis (ticks adapt to the zoom: months, quarters or years)
  const months = monthStarts(G.t0, G.t1);
  const monthPx = months.length > 1 ? ((xAt(months[months.length - 1].t) - xAt(months[0].t)) / (months.length - 1)) * s : 100;
  const every = monthPx >= 46 ? 1 : monthPx >= 17 ? 3 : 12;
  const fs = screenPx(api, 11);
  ctx.font = `${fs}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const topY = G.top - 7 * fs / 11, botY = G.bottom + 15 * fs / 11;
  const showBottom = G.lanes.length > 5;
  months.forEach((mo) => {
    const x = xAt(mo.t), yearStart = mo.m === 0;
    if (mo.m % every !== 0 && !(yearStart && every === 12)) return;
    ctx.strokeStyle = rgba(P.text, yearStart ? 0.16 : 0.06); ctx.lineWidth = (yearStart ? 1.2 : 1) / s;
    ctx.beginPath(); ctx.moveTo(x, G.top); ctx.lineTo(x, G.bottom); ctx.stroke();
    const label = yearStart ? String(mo.y) : monthName(mo.m);
    ctx.font = `${yearStart ? "600 " : ""}${fs}px sans-serif`;
    const col = rgba(P.text, yearStart ? 0.8 : 0.5);
    haloText(ctx, label, x, topY, col, P.bg, 3 / s);
    if (showBottom) haloText(ctx, label, x, botY, col, P.bg, 3 / s);
  });

  // when each topic was alive: a soft bar along the lane
  G.span.forEach((sp, i) => {
    if (!sp) return;
    const y = laneY(i), h = Math.min(10, G.laneH[i] * 0.22);
    ctx.fillStyle = groupColor(i, light, i === focusLane ? 0.3 : 0.15);
    ctx.beginPath(); ctx.roundRect(sp[0] - 6, y - h / 2, sp[1] - sp[0] + 12, h, h / 2); ctx.fill();
  });

  // threads: each dump touches the lanes of its other topics
  const hl = api.highlight;
  const alive = (n) => isAlive(api, n);
  const lineA = focusDump || focusHub || hl ? 0.1 : 0.2;
  ctx.lineWidth = 1 / s;
  ctx.strokeStyle = rgba(P.text, lineA);
  ctx.beginPath();
  const marks = G.lanes.map(() => []);
  for (const [id, list] of G.others) {
    const d = api.byId[id];
    if (!d || !alive(d)) continue;
    const ys = list.map(laneY), y0 = Math.min(d.y, ...ys), y1 = Math.max(d.y, ...ys);
    ctx.moveTo(d.x, y0); ctx.lineTo(d.x, y1);
    list.forEach((li) => marks[li].push(d.x));
  }
  ctx.stroke();
  const mr = clamp(2.2 / Math.sqrt(s), 1.4, 3.4);
  G.lanes.forEach((l, i) => {
    if (!marks[i].length) return;
    ctx.fillStyle = groupColor(i, light, 0.7);
    ctx.beginPath();
    const y = laneY(i);
    for (const x of marks[i]) { ctx.moveTo(x + mr, y); ctx.arc(x, y, mr, 0, Math.PI * 2); }
    ctx.fill();
  });

  // emphasis: threads of the hovered/selected dump or topic, and of a Path
  const bright = (d, lanes, col, w) => {
    ctx.strokeStyle = col; ctx.lineWidth = w / s;
    ctx.beginPath();
    for (const li of lanes) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x, laneY(li)); }
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    for (const li of lanes) { ctx.moveTo(d.x + 3.4, laneY(li)); ctx.arc(d.x, laneY(li), 3.4, 0, Math.PI * 2); }
    ctx.fill();
  };
  const lanesOfDump = (id) => [G.laneOf.get(id), ...(G.others.get(id) || [])].filter((v) => v != null);
  if (focusDump) bright(focusDump, lanesOfDump(focusDump.id), P.accent, 1.8);
  if (focusHub && focusLane >= 0) {
    for (const id of G.model.dumpsOf.get(focusHub.id) || []) { const d = api.byId[id]; if (d && alive(d)) bright(d, [focusLane], groupColor(focusLane, light, 0.9), 1.2); }
  }
  if (hl) {
    const byHub = new Map();
    for (const e of api.edges) {
      if (!hl.edges.has(api.edgeKey(e.source, e.target))) continue;
      const a = api.byId[e.source], b = api.byId[e.target];
      const [d, h] = a.type === "dump" ? [a, b] : [b, a];
      if (d.type !== "dump" || !isHub(h)) continue;
      const li = G.lanes.findIndex((l) => l.id === h.id);
      if (li < 0) continue;
      bright(d, [li], P.text, 2.2);
      (byHub.get(li) || byHub.set(li, []).get(li)).push(d.x);
    }
    ctx.strokeStyle = P.text; ctx.lineWidth = 3 / s;
    for (const [li, xs] of byHub) { ctx.beginPath(); ctx.moveTo(Math.min(...xs), laneY(li)); ctx.lineTo(Math.max(...xs), laneY(li)); ctx.stroke(); }
  }

  // lane headers: a dot (the topic's own node, so click / Find / Path work on it) and its name
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const lfs = screenPx(api, 12);
  G.lanes.forEach((l, i) => {
    const node = api.byId[l.id];
    const y = laneY(i), x = G.left;
    const on = node ? alive(node) : true;
    const active = (node && (node.id === sel || node.id === hov)) || (hl && node && hl.nodes.has(node.id));
    const pitch = G.laneH[i] * s, tight = pitch < 30, skip = !active && i % Math.max(1, Math.ceil(14 / Math.max(1, pitch))) !== 0;   // zoomed far out: fewer, single-line labels
    ctx.globalAlpha = on ? 1 : 0.3;
    ctx.beginPath(); ctx.arc(x, y, active ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = l.type === "other" ? rgba(P.text, 0.35) : api.colors.colors[l.type] || P.accent; ctx.fill();
    if (active) { ctx.lineWidth = 2 / s; ctx.strokeStyle = P.text; ctx.stroke(); }
    if (skip) { ctx.globalAlpha = 1; return; }
    ctx.font = `600 ${lfs}px sans-serif`;
    const label = fitText(ctx, l.label, Math.max(40 / s, G.gutter - 16 / s));
    haloText(ctx, label, x + 10 / s * 1.0 + (active ? 2 / s : 0), y - (l.type === "other" || tight ? 0 : 5 / s), active ? P.text : rgba(P.text, 0.88), P.bg, 3 / s);
    ctx.font = `${screenPx(api, 10.5)}px sans-serif`;
    if (l.type !== "other" && !tight) haloText(ctx, `${l.mentions} dump${l.mentions === 1 ? "" : "s"}`, x + 10 / s, y + 8 / s, P.dim, P.bg, 3 / s);
    ctx.globalAlpha = 1;
  });
  // status line under the lanes: how many topics are left out
  if (G.hidden > 0) {
    const shown = G.lanes.filter((l) => l.type !== "other").length;
    ctx.font = `${screenPx(api, 11.5)}px sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    haloText(ctx, `Showing the ${shown} busiest topics · ${G.hidden} more ${G.hidden === 1 ? "is" : "are"} left out`, G.left - 6 / s, G.bottom + (showBottom ? 40 : 24) / s, P.dim, P.bg, 3 / s);
  }
  ctx.restore();
}

registerLayout({
  id: "lanes", label: "Topic timeline", icon: "🛤️",
  desc: "Time runs left to right with one lane for each of your busiest topics and people, so you can see when each one was alive. Every dump sits in the lane of its strongest topic, with a thin thread to the other topics it mentions.",
  fixed: true, locked: true,
  hint: "Read it like a calendar: each dot is a dump, placed on the day it was written. Small marks in other lanes show the other topics it touches. Click a topic name to light up its dumps.",
  hideNode: (n) => isHub(n),
  // "Similar" links would criss-cross every lane; they appear only for the dump you hover or select.
  edgeStyle: (e, a, b, api) => {
    if (e.type !== "similar") return null;
    const h = api.hoverId || api.selectedId;
    return h && (a.id === h || b.id === h) ? { alpha: 1.4 } : false;
  },
  prepare, place, drawUnder,
  relayout(api) { place(api); api.fit(); api.requestDraw(); },
  note: (api) => {
    if (!api.nodes.length || !G.nDumps) return "No dumps to put on a timeline yet.";
    if (G.lanes.length === 1 && G.hasOther) return "<b>No topics yet.</b><br>Once your dumps mention concepts or people, each one gets its own lane here.";
    if (G.nDumps < 3) return "<b>Just getting started.</b><br>A few more dumps and the lanes will show how your topics come and go over time.";
    return null;
  },
});
