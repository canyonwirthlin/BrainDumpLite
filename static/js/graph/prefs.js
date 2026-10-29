// Every persisted brain-map preference lives here, under the same localStorage keys the map has
// always used (so a user's saved settings survive the refactor). Reads are lazy and cached; writes go
// straight to localStorage and notify onChange listeners.
//
// Add your own pref with prefs.define(name, { key, def, parse, serialize }) - see docs/graph-architecture.md.

export const RANGES = { all: ["All time", 0], 7: ["Last 7 days", 7], 30: ["Last 30 days", 30], 90: ["Last 90 days", 90] };
export const MIN_ZOOM = 0.04;

const KEYS = {
  spacing: "bdl-graph-spacing", layout: "bdl-graph-layout", hoverTitles: "bdl-graph-hover-titles",
  minMentions: "bdl-graph-min", range: "bdl-graph-range", types: "bdl-graph-types", pins: "bdl-graph-pins",
  view: "bdl-graph-view-", overlays: "bdl-graph-overlays",
};

const defs = new Map();     // name -> { key, def, parse, serialize }
const cache = new Map();    // name -> current value
const listeners = new Set();

const readRaw = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeRaw = (key, v) => { try { localStorage.setItem(key, v); } catch {} };

/** Register a pref. key: localStorage key (null = lives for this page session only); def: default value;
 *  parse(raw string) -> value, or undefined to reject (the default is used); serialize(value) -> string. */
function define(name, { key = null, def, parse = (raw) => raw, serialize = (v) => String(v) }) {
  defs.set(name, { key, def, parse, serialize });
}

function get(name) {
  if (cache.has(name)) return cache.get(name);
  const d = defs.get(name);
  if (!d) throw new Error("unknown graph pref: " + name);
  let v = typeof d.def === "function" ? d.def() : d.def;
  if (d.key) {
    const raw = readRaw(d.key);
    if (raw !== null) { const p = d.parse(raw); if (p !== undefined) v = p; }
  }
  cache.set(name, v);
  return v;
}

function set(name, value) {
  const d = defs.get(name);
  if (!d) throw new Error("unknown graph pref: " + name);
  const old = get(name);
  cache.set(name, value);
  if (d.key) writeRaw(d.key, d.serialize(value));
  listeners.forEach((fn) => fn(name, value, old));
}

/** onChange(fn(name, value, oldValue)) -> unsubscribe */
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── built-in prefs ────────────────────────────────────────────────────────────────────────────
// Node spacing (slider): scales repulsion and edge length together.
define("spacing", { key: KEYS.spacing, def: 1, parse: (raw) => { const v = parseFloat(raw); return v >= 0.5 && v <= 3 ? v : undefined; } });
// Active layout id. Any registered layout id is accepted; layouts.js falls back to "organic" for unknown ids.
define("layout", { key: KEYS.layout, def: "organic", parse: (raw) => raw || undefined });
// Off: titles show as usual. On: a title appears only while hovering its node.
define("hoverTitles", { key: KEYS.hoverTitles, def: false, parse: (raw) => raw === "1", serialize: (v) => (v ? "1" : "0") });
// Declutter filters: concepts/people in fewer dumps than this are hidden; range limits the map to recent dumps.
define("minMentions", { key: KEYS.minMentions, def: 2, parse: (raw) => { const v = parseInt(raw, 10); return v >= 1 && v <= 6 ? v : undefined; } });
define("range", { key: KEYS.range, def: "all", parse: (raw) => (raw in RANGES ? raw : undefined) });
// Focus mode (dim everything beyond two hops of the selection): a session toggle, never persisted.
define("focus", { key: null, def: false });

export const prefs = { get, set, onChange, define, keys: KEYS };

// ── node types toggled off in the legend (persisted per device) ───────────────────────────────
export const hidden = new Set();
prefs.hidden = hidden;
let hiddenLoaded = false;
export function loadHidden(types) {
  if (hiddenLoaded) return;
  hiddenLoaded = true;
  let saved = null;
  try { saved = JSON.parse(readRaw(KEYS.types) || "null"); } catch {}
  if (Array.isArray(saved)) saved.forEach((t) => hidden.add(t));
  else types.filter((t) => !t.builtin).forEach((t) => hidden.add(t.id));   // item nodes off by default
}
export const saveHidden = () => writeRaw(KEYS.types, JSON.stringify([...hidden]));

// ── pins: nodes the user dragged and dropped, which survive restarts ──────────────────────────
export const loadPins = () => { try { const v = JSON.parse(readRaw(KEYS.pins) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
export const savePins = (p) => writeRaw(KEYS.pins, JSON.stringify(p));

// ── remembered arrangement per layout id: node positions + pan/zoom ───────────────────────────
// In memory for this session, and mirrored to localStorage so it survives an app restart.
const savedLayouts = new Map();
export const sessionViews = savedLayouts;
export function loadView(layoutId) {
  if (savedLayouts.has(layoutId)) return savedLayouts.get(layoutId);
  try {
    const v = JSON.parse(readRaw(KEYS.view + layoutId) || "null");
    if (!v || !v.pos || ![v.scale, v.panX, v.panY].every(Number.isFinite)) return null;
    const snap = { pos: new Map(Object.entries(v.pos).map(([id, q]) => [id, { x: q[0], y: q[1] }])), scale: v.scale, panX: v.panX, panY: v.panY, userMoved: !!v.userMoved };
    savedLayouts.set(layoutId, snap);
    return snap;
  } catch { return null; }
}
export function storeView(layoutId, snap) {
  if (snap.pos.size > 3000) return;
  const pos = {};
  snap.pos.forEach((q, id) => { pos[id] = [Math.round(q.x), Math.round(q.y)]; });
  writeRaw(KEYS.view + layoutId, JSON.stringify({ pos, scale: snap.scale, panX: snap.panX, panY: snap.panY, userMoved: snap.userMoved }));
}

// ── overlays switched on (JSON array of overlay ids) ──────────────────────────────────────────
export function loadOverlayIds() { try { const v = JSON.parse(readRaw(KEYS.overlays) || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
export const saveOverlayIds = (ids) => writeRaw(KEYS.overlays, JSON.stringify(ids));
