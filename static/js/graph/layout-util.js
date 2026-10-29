// Shared helpers for the layouts in layout-*.js and the cluster outlines overlay: colour maths that follows the
// theme, the dump <-> concept/person model, and the small in-canvas chrome (hint chip, "not enough data" note).
//
// Optional fields a layout may define on top of the documented contract (all read here or in engine.js):
//   locked: true            positions are computed from the data: no saved arrangement, no pins, nodes can't be dragged
//   edgeStyle(e, a, b, api) false = don't draw this link, or { alpha, width, color } multipliers (engine.js)
//   hideNode(n) -> bool     the layout draws this node itself (headers, grid labels ...): the engine skips it
//   hint: "text"            a small dismissible tip shown in the corner of the map
//   note(api) -> html|null  a friendly message in the middle of the map (too little data ...)
//   caption(api) -> html    a one-line status pill in the top-left corner ("showing the 14 busiest topics")
//   relayout(api)           called when the Spacing slider moves, to recompute positions
import { esc } from "../ui.js";
import { onGraphReady } from "./hooks.js";
import { prefs } from "./prefs.js";
import { infoSections } from "./infobox.js";

export { esc };

// ── colour ────────────────────────────────────────────────────────────────────────────────────
export function parseColor(css) {
  const s = String(css || "").trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return [128, 128, 128];
}
export const rgba = (css, a) => { const [r, g, b] = parseColor(css); return `rgba(${r},${g},${b},${a})`; };
export const luminance = (css) => { const [r, g, b] = parseColor(css); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

const cssVar = (name, fb) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch { return fb; } };
const paletteCache = new WeakMap();
/** Theme colours for drawing: { bg, text, dim, accent, line, panel, light } (cached per mount; re-read after a rebuild). */
export function palette(api) {
  const key = api.colors;
  let p = paletteCache.get(key);
  if (!p) {
    const bg = key.bg || cssVar("--bg", "#0d1017");
    p = { bg, text: key.text, dim: cssVar("--dim", key.edge), accent: cssVar("--accent", key.dump), line: cssVar("--line", key.edge), panel: cssVar("--panel", bg), light: luminance(bg) > 0.55 };
    paletteCache.set(key, p);
  }
  return p;
}
/** A well-spread, theme-aware colour for the i-th group (golden-angle hues). */
export const groupHue = (i) => (i * 137.508 + 24) % 360;
export const groupColor = (i, light, a = 1) => `hsla(${groupHue(i).toFixed(1)}, ${light ? 58 : 64}%, ${light ? 40 : 64}%, ${a})`;

// ── small numeric helpers ─────────────────────────────────────────────────────────────────────
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** `n` screen pixels expressed in world units at the current zoom (labels that stay the same on-screen size). */
export const screenPx = (api, n) => n / Math.max(0.02, api.view.scale);
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const isAlive = (api, n) => !api.timelapse || api.timelapse.alive(n);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (m) => MONTHS[m];
export const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "undated");

/** Draw text with a soft outline in the map background colour so it stays legible over lines and dots. */
export function haloText(ctx, text, x, y, fill, halo, lineW) {
  ctx.lineJoin = "round"; ctx.lineWidth = lineW; ctx.strokeStyle = halo; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}
/** Clip text to a pixel width with an ellipsis. */
export function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 1, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + "…";
}

// ── the dump <-> concept/person model ─────────────────────────────────────────────────────────
export const isHub = (n) => n.type === "concept" || n.type === "person";
/** When a dump was written (ms), falling back to the engine's `born` stamp; 0 = unknown. */
export const dumpTime = (n) => { const t = Date.parse(n.created_at || ""); return Number.isNaN(t) ? n.born || 0 : t; };

/** From a dataset: dumps, hubs (concepts + people), items, and who mentions whom. Works on prepared data or api.nodes. */
export function buildModel(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dumps = nodes.filter((n) => n.type === "dump");
  const hubs = nodes.filter(isHub);
  const items = nodes.filter((n) => n.dump);
  const hubsOf = new Map(), dumpsOf = new Map();
  const link = (d, h) => {
    (hubsOf.get(d) || hubsOf.set(d, []).get(d)).push(h);
    (dumpsOf.get(h) || dumpsOf.set(h, []).get(h)).push(d);
  };
  const seen = new Set();
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) continue;
    const [d, h] = a.type === "dump" && isHub(b) ? [a, b] : b.type === "dump" && isHub(a) ? [b, a] : [null, null];
    if (!d) continue;
    const k = d.id + "\u0001" + h.id;
    if (seen.has(k)) continue;
    seen.add(k);
    link(d.id, h.id);
  }
  return { byId, dumps, hubs, items, hubsOf, dumpsOf };
}
/** Distinct dumps mentioning a hub. */
export const mentionsOf = (model, id) => (model.dumpsOf.get(id) || []).length;

/** HTML list of dumps (newest first) for the info panel. */
export function dumpListHtml(dumps, max = 14) {
  const sorted = [...dumps].sort((a, b) => dumpTime(b) - dumpTime(a));
  return sorted.slice(0, max).map((d) => `<div style="margin-top:4px"><a href="#history/${esc(d.id)}">${esc(d.label)}</a> <span class="small muted">${esc(fmtDay(dumpTime(d)))}</span></div>`).join("")
    + (sorted.length > max ? `<div class="small muted" style="margin-top:6px">and ${sorted.length - max} more</div>` : "");
}

// ── info panel: layouts whose nodes aren't a full dump graph describe a node their own way ────
const infoFor = {};
let patched = false;
/** nodeInfo("matrix", (node, api) => html): replaces the built-in node summary while that layout is on screen. */
export function nodeInfo(layoutId, fn) {
  infoFor[layoutId] = fn;
  if (patched) return;
  const base = infoSections.find((s) => s.id === "node");
  if (!base) return;
  patched = true;
  const orig = base.render;
  base.render = (n, api) => { const f = infoFor[api.layout && api.layout.id]; return f ? f(n, api) : orig(n, api); };
}

// ── in-canvas chrome (hint chip + friendly note) and per-layout engine glue ───────────────────
const HINT_KEY = "bdl-graph-hint-";
const hintSeen = (id) => { try { return localStorage.getItem(HINT_KEY + id) === "1"; } catch { return false; } };
const hintDismiss = (id) => { try { localStorage.setItem(HINT_KEY + id, "1"); } catch { /* private mode: it just shows again */ } };

function paintChrome(api) {
  const wrap = api.wrap, L = api.layout;
  if (!wrap) return;
  wrap.querySelectorAll(".graph-hint, .graph-note, .graph-caption").forEach((e) => e.remove());
  api.setNodeVisibility(L && L.hideNode ? (n) => !L.hideNode(n) : null, "layout-hide");
  if (!L) return;
  let note = null;
  try { note = L.note ? L.note(api) : null; } catch (e) { console.warn("graph layout note failed", e); }
  if (note) wrap.insertAdjacentHTML("beforeend", `<div class="graph-note" role="status">${note}</div>`);
  let cap = null;
  try { cap = L.caption ? L.caption(api) : null; } catch (e) { console.warn("graph layout caption failed", e); }
  if (cap) wrap.insertAdjacentHTML("beforeend", `<div class="graph-caption">${cap}</div>`);
  if (L.hint && !hintSeen(L.id)) {
    wrap.insertAdjacentHTML("beforeend", `<div class="graph-hint" role="note"><span>${esc(L.hint)}</span><button type="button" aria-label="Dismiss tip" title="Got it">×</button></div>`);
    const chip = wrap.querySelector(".graph-hint");
    chip.querySelector("button").onclick = () => { hintDismiss(L.id); chip.remove(); };
  }
}

onGraphReady((api) => {
  const offs = [
    api.on("nodesChanged", () => paintChrome(api)),
    prefs.onChange((name) => { if (name === "spacing" && api.layout && api.layout.relayout) { try { api.layout.relayout(api); } catch (e) { console.warn("graph relayout failed", e); } } }),
  ];
  return () => offs.forEach((off) => off());
});

/** Months between two timestamps, for axis ticks. */
export function monthStarts(t0, t1) {
  const out = [];
  const d = new Date(t0);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
  for (let guard = 0; d.getTime() <= t1 && guard < 600; guard++) { out.push({ t: d.getTime(), m: d.getMonth(), y: d.getFullYear() }); d.setMonth(d.getMonth() + 1); }
  return out;
}
