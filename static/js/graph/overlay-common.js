// Shared helpers for the insight overlays (Connectors, Rising & fading, Lonely dumps, Open loops, Suggested links).
// Registers nothing by itself. Colour precedence across the five overlays, so several can be on at once:
//   ring  : Open loops (solid, red when overdue) > Lonely dumps (dashed) > Connectors (solid, accent)
//           a lonely dump with overdue tasks gets a red *dashed* ring; the three never fight over the same node type
//           except loops/lonely (both dumps), which is why the dash is carried through.
//   glow  : Rising (green) > Connectors (accent)           fade: Fading dims the node instead
//   badge : Open loops (dumps) / Rising + Fading arrows (concepts, people) - always top-right, never both on one node
//   ghost edges (Suggested links) are drawn beneath the nodes and never touch node colours.
import { api as http } from "../api.js";
import { esc } from "../ui.js";

export { esc };

// ── theme colours, read once per engine mount (api.colors is rebuilt on every mount) ─────────────
const palettes = new WeakMap();
export function palette(api) {
  const key = api.colors;
  let p = palettes.get(key);
  if (p) return p;
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  p = {
    green: v("--green", "#4ade80"), red: v("--red", "#f87171"), amber: v("--amber", "#fbbf24"),
    accent: v("--accent", "#8b7cf6"), accent2: v("--accent-2", "#5ea2f7"),
    text: key.text, bg: key.bg, dim: key.edge,
  };
  palettes.set(key, p);
  return p;
}

/** Black or white, whichever reads better on the given css colour. */
const readableCache = new Map();   // called per badge per frame: remember the answer per colour
export function readableOn(css) {
  let out = readableCache.get(css);
  if (out === undefined) readableCache.set(css, out = readableOnUncached(css));
  return out;
}
function readableOnUncached(css) {
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000"; c.fillStyle = css;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.fillStyle);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
}

// ── data the overlays derive from the unfiltered dataset (so the date range / min-mentions filters don't change them) ──
export const baseData = (api) => api.viewState?.data || null;

const memos = new WeakMap();
/** Compute once per dataset object: memo(data, "bridges", () => ...). */
export function memo(data, key, fn) {
  if (!data) return null;
  let m = memos.get(data);
  if (!m) memos.set(data, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

// ── server data: one request in flight per path, reused for a minute ────────────────────────────
const fetched = new Map();
export function fetchInsight(path, { fresh = false, ttl = 60000 } = {}) {
  const hit = fetched.get(path);
  if (hit && !fresh && Date.now() - hit.t < ttl) return hit.p;
  const p = http.get(path);
  fetched.set(path, { t: Date.now(), p });
  p.catch(() => { if (fetched.get(path)?.p === p) fetched.delete(path); });
  return p;
}
export const forget = (path) => fetched.delete(path);

// ── tiny html helpers ───────────────────────────────────────────────────────────────────────────
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const key = (cls, text) => `<span class="ov-key"><i class="ov-dot ${cls}"></i>${text}</span>`;
// the panel prints the overlay's own heading above its legend, so the title is not repeated here
export const legend = (_title, ...keys) => `<span class="ov-legend">${keys.join("")}</span>`;
export const note = (text) => `<span class="ov-legend ov-note">${esc(text)}</span>`;
export const section = (icon, title, body) => `<div class="ov-sec"><div class="ov-sec-h"><span class="ov-ico">${icon}</span>${esc(title)}</div>${body}</div>`;

/** Show badges only when a node is big enough on screen for them to be legible. */
export const roomForBadge = (n, api) => api.view.scale >= 0.9 || n.r * api.view.scale >= 4;

/** Delegated clicks for buttons/links inside overlay info boxes: <button data-ov="name" data-a=.. data-b=..>. */
const actions = new Map();
export function onAction(name, fn) { actions.set(name, fn); }
let wired = false;
export function wireActions() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.("[data-ov]");
    const fn = el && actions.get(el.dataset.ov);
    if (fn) { e.preventDefault(); fn(el.dataset, el); }
  });
}
