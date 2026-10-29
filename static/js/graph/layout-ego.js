// Ego rings: one node in the middle, everything it touches on rings around it.
// Ring 1 = direct links, ring 2 = links of those, ring 3 = one step further; anything beyond (or not connected at
// all) sits on an outer "further away" ring. Inside a ring nodes run clockwise from 12 o'clock, oldest first.
// Selecting another node re-centres the picture with a short animation.
import { registerLayout } from "./layouts.js";
import { onGraphReady } from "./hooks.js";
import { palette, rgba, clamp, lerp, easeInOut, screenPx, cmp } from "./layout-util.js";

const MAX_HOPS = 3;
const CAPTIONS = ["", "1 step away", "2 steps away", "3 steps away", "Further away"];
const st = { centre: null, cur: null, tween: null, touched: false, fitScale: 1 };

const bornKey = (n) => (n.born > 0 ? n.born : Infinity);

/** Ring positions for a given centre: { pos: Map(id -> {x, y}), rings: [{ k, r0, r1, count }], cx, cy }. */
function compute(api, centreId) {
  const { W, H, spacing } = api.env();
  const cx = W / 2, cy = H / 2;
  const nbr = api.nbrIds;
  const level = new Map([[centreId, 0]]);
  const queue = [centreId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i], lv = level.get(cur);
    for (const nx of nbr[cur] || []) if (!level.has(nx)) { level.set(nx, lv + 1); queue.push(nx); }
  }
  const groups = [[], [], [], [], []];
  for (const n of api.nodes) {
    if (n.id === centreId) continue;
    const lv = level.get(n.id);
    groups[lv == null || lv > MAX_HOPS ? 4 : lv].push(n);
  }
  const pos = new Map([[centreId, { x: cx, y: cy }]]);
  const rings = [];
  let outer = 0;
  for (let k = 1; k <= 4; k++) {
    const list = groups[k];
    if (!list.length) continue;
    list.sort((a, b) => bornKey(a) - bornKey(b) || cmp(a.id, b.id));
    const m = list.length;
    const meanR = list.reduce((s, n) => s + n.r, 0) / m;
    const gap = (2 * meanR + 6) * spacing, track = gap * 0.92, between = (46 + meanR * 2) * spacing;   // room scales with the dots and the Spacing slider
    const rMin = rings.length ? outer + between : (80 + 4 * meanR) * spacing;
    let tracks = 1;
    while (tracks < 60 && (tracks * 2 * Math.PI * (rMin + ((tracks - 1) * track) / 2)) / gap < m) tracks++;
    const notch = clamp(50 / rMin, 0.05, 0.6);   // a gap at 12 o'clock for the ring's caption
    list.forEach((n, i) => {
      const a = -Math.PI / 2 + notch + (i / m) * (Math.PI * 2 - 2 * notch), r = rMin + (i % tracks) * track;
      pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    });
    outer = rMin + (tracks - 1) * track;
    rings.push({ k, r0: rMin - track * 0.8, r1: outer + track * 0.8, count: m });
  }
  return { pos, rings, cx, cy, centreId };
}

function pickCentre(api) {
  if (st.centre && api.byId[st.centre]) return st.centre;
  if (api.selectedId && api.byId[api.selectedId]) return api.selectedId;
  let best = null;
  for (const n of api.nodes) if (!best || n.deg > best.deg || (n.deg === best.deg && n.id < best.id)) best = n;
  return best ? best.id : null;
}

function apply(api, res) {
  for (const n of api.nodes) { const p = res.pos.get(n.id); if (p) { n.x = n.tx = p.x; n.y = n.ty = p.y; } }
}
/** Smaller dots (so rings stay legible and fewer titles compete), a bigger one in the middle. Base radius kept in meta. */
function setRadii(api, centreId) {
  for (const n of api.nodes) {
    if (n.meta.r0 == null) n.meta.r0 = n.r;
    n.r = n.id === centreId ? Math.max(11, n.meta.r0 * 1.4) : Math.max(3.5, n.meta.r0 * 0.7);
  }
}

const reduceMotion = () => document.documentElement.dataset.motion === "reduce" || (document.documentElement.dataset.motion !== "auto" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

/** Move to a new arrangement: animated, or instantly when the user asked for less motion. */
function glideTo(api, next) {
  const prev = st.cur;
  st.cur = next;
  if (reduceMotion() || !api.nodes.length) { apply(api, next); st.tween = null; reframe(api); api.requestDraw(); return; }
  const from = new Map(api.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  st.tween = { t0: performance.now(), dur: 650, from, to: next.pos, ringsFrom: prev ? prev.rings : [], ringsTo: next.rings };
  api.requestDraw();
}

/** After a re-centre: refit when the user hasn't zoomed, otherwise just keep the new centre in the middle of the screen. */
function reframe(api) {
  if (!st.touched && Math.abs(api.view.scale - st.fitScale) < 1e-6) { api.fit(); st.fitScale = api.view.scale; return; }
  const { W, H } = api.env();
  api.view.panX = W / 2 - api.view.scale * st.cur.cx;
  api.view.panY = H / 2 - api.view.scale * st.cur.cy;
  api.requestDraw();
}

function ringsNow(api) {
  const tw = st.tween;
  if (!tw) return st.cur ? st.cur.rings : [];
  const t = easeInOut(clamp((performance.now() - tw.t0) / tw.dur, 0, 1));
  return tw.ringsTo.map((r, i) => { const f = tw.ringsFrom[i] || { r0: r.r0, r1: r.r1 }; return { ...r, r0: lerp(f.r0, r.r0, t), r1: lerp(f.r1, r.r1, t) }; });
}

onGraphReady((api) => {
  const offs = [];
  offs.push(api.on("nodesChanged", () => {
    st.tween = null; st.touched = false; st.fitScale = api.view.scale;
    const c = api.canvas;
    if (c) { const touch = () => { st.touched = true; }; c.addEventListener("wheel", touch, { passive: true }); c.addEventListener("mousedown", touch); }
  }));
  offs.push(api.on("select", ({ id, node }) => {
    if (!api.layout || api.layout.id !== "ego" || !id || !node || id === st.centre) return;
    st.centre = id;
    setRadii(api, id);
    glideTo(api, compute(api, id));
  }));
  offs.push(api.on("click", (ev) => {   // a click re-centres; the centre itself keeps the usual click behaviour (open / select)
    if (ev.handled || !ev.node || !api.layout || api.layout.id !== "ego" || ev.node.id === st.centre) return;
    ev.handled = true;
    api.select(ev.node.id);
  }));
  offs.push(api.on("afterDraw", ({ ctx }) => {
    const res = st.cur;
    if (!res || !api.layout || api.layout.id !== "ego") return;
    const P = palette(api), s = api.view.scale, px = screenPx(api, 10.5);
    ctx.save();
    ctx.font = `${px}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const r of ringsNow(api)) {   // a small badge on each ring's 12 o'clock line, the same size at any zoom
      if (r.r1 * s < 40) continue;
      const text = `${CAPTIONS[r.k]} · ${r.count}`, w = ctx.measureText(text).width + 14 / s, h = 18 / s, x = res.cx - w / 2, y = res.cy - r.r1 - h / 2;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2);
      ctx.fillStyle = P.panel; ctx.fill();
      ctx.lineWidth = 1 / s; ctx.strokeStyle = rgba(P.text, 0.25); ctx.stroke();
      ctx.fillStyle = P.dim; ctx.fillText(text, res.cx, y + h / 2 + 0.5 / s);
    }
    ctx.restore();
  }));
  offs.push(api.on("tick", () => {
    const tw = st.tween;
    if (!tw || !api.layout || api.layout.id !== "ego") return;
    const t = clamp((performance.now() - tw.t0) / tw.dur, 0, 1), e = easeInOut(t);
    for (const n of api.nodes) {
      const a = tw.from.get(n.id), b = tw.to.get(n.id);
      if (a && b) { n.x = n.tx = lerp(a.x, b.x, e); n.y = n.ty = lerp(a.y, b.y, e); }
    }
    if (t >= 1) { st.tween = null; reframe(api); }
    api.requestDraw();
  }));
  return () => offs.forEach((off) => off());
});

registerLayout({
  id: "ego", label: "Ego rings", icon: "🎯",
  desc: "Puts one idea in the middle and arranges everything around it by how many steps away it is: direct connections on the inner ring, their connections on the next, and so on, oldest to newest clockwise. Use it to explore how one topic or person reaches the rest of your thinking, then click anything to re-centre.",
  fixed: true, locked: true,
  hint: "Click any dot to put it in the middle. Each ring is one step further away, and inside a ring time runs clockwise from the top (oldest first).",
  note: (api) => (api.nodes.length < 3 ? "Not much to ring yet. Add a few more dumps and your most connected idea will gain rings of related people, topics and notes." : null),
  place(api) {
    const c = pickCentre(api);
    st.centre = c; st.tween = null;
    if (!c) { st.cur = null; return; }
    setRadii(api, c);
    st.cur = compute(api, c);
    apply(api, st.cur);
  },
  relayout(api) {
    if (!st.centre || !api.byId[st.centre]) return;
    glideTo(api, compute(api, st.centre));
    st.touched = false;
  },
  drawUnder(ctx, api) {
    const res = st.cur;
    if (!res) return;
    const P = palette(api), s = api.view.scale;
    const rings = ringsNow(api);
    const cx = res.cx, cy = res.cy;
    ctx.save();
    // faint concentric bands, one per step
    rings.forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r.r1, 0, Math.PI * 2);
      ctx.arc(cx, cy, Math.max(0, r.r0), 0, Math.PI * 2, true);
      ctx.fillStyle = rgba(P.text, r.k === 4 ? 0.02 : 0.035 + (i % 2) * 0.015);
      ctx.fill("evenodd");
      ctx.beginPath(); ctx.arc(cx, cy, r.r1, 0, Math.PI * 2);
      ctx.lineWidth = 1 / s; ctx.strokeStyle = rgba(P.text, r.k === 4 ? 0.16 : 0.12);
      ctx.setLineDash(r.k === 4 ? [6 / s, 5 / s] : []); ctx.stroke(); ctx.setLineDash([]);
    });
    // the centre: a soft halo so the eye lands on it
    const c = api.byId[res.centreId];
    if (c) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, c.r + 34);
      g.addColorStop(0, rgba(P.accent, 0.35)); g.addColorStop(1, rgba(P.accent, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, c.r + 34, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
});
