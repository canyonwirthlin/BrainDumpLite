// Overlay registry (extra information drawn on top of the map) and the hull-painter hook list.
//
//   OVERLAYS.push({
//     id, label, icon, desc,                    // desc: user-facing sentence(s) for the control panel
//     needs?: ["items"],                        // data the overlay requires ("items" = task/idea/... nodes are fetched)
//     load?(api) -> state | Promise<state>,     // called when the overlay is switched on and after every rebuild of the map
//     nodeStyle?(node, state, api) -> { color?, ring?, glow?, scale?, alpha?, badge? } | null,
//     drawUnder?(ctx2d, api, state),            // WORLD coordinates, above edges, beneath nodes
//     drawOver?(ctx2d, api, state),             // WORLD coordinates, above nodes, beneath labels
//     legend?(state) -> html,                   // shown by the control panel next to the overlay's switch
//     info?(node, state, api) -> html,          // extra section in the selected-node info box
//   })
//
// nodeStyle fields: color (fill css color), ring (css color, or { color, width } in px), glow (css color),
// scale (radius multiplier, drawing only), alpha (multiplies the node's opacity), badge (short text/emoji at the
// node's top-right). With several overlays on, later overlays win for color/ring/glow/badge; scale and alpha multiply.
//
// The active set is stored under localStorage "bdl-graph-overlays" (JSON array of ids). Ships empty on purpose.
import { loadOverlayIds, saveOverlayIds } from "./prefs.js";
import { infoSections } from "./infobox.js";
import { isLargeMap } from "./perf.js";

export const OVERLAYS = [];
let registryVersion = 0;
/** Hull painters run between edges and nodes: fn(ctx2d, api) in WORLD coordinates (cluster outlines, island fills ...). */
export const HULL_PAINTERS = [];

export function registerOverlay(def) {
  registryVersion++;
  const at = OVERLAYS.findIndex((o) => o.id === def.id);
  if (at >= 0) OVERLAYS[at] = def; else OVERLAYS.push(def);
  return def;
}
export const registerHullPainter = (fn) => { HULL_PAINTERS.push(fn); return fn; };

const STYLE_KEYS = ["color", "ring", "glow", "badge"];
const guard = (what, fn, dflt) => { try { return fn(); } catch (e) { console.warn("graph overlay", what, e); return dflt; } };

/** The overlay runtime owned by one engine api (api.overlays). Holds per-overlay state and applies the active ones. */
export function createOverlayRuntime(api) {
  const states = new Map();   // overlay id -> state
  let ids = new Set(loadOverlayIds());
  let activeCache = null, activeFor = -1;   // the active list is read once per node per frame: cache it until the set or the registry changes
  const active = () => {
    if (activeCache && activeFor === registryVersion) return activeCache;
    activeFor = registryVersion;
    return (activeCache = OVERLAYS.filter((o) => ids.has(o.id)));
  };

  const deferred = new Map();   // overlay id -> timer of a load waiting for the first frame (large maps)
  function load(def) {
    if (!def.load) return;
    const run = () => {
      if (!ids.has(def.id)) return;   // switched off again while the deferred load was waiting
      const r = guard(def.id + ".load", () => def.load(api));
      Promise.resolve(r).then((s) => { if (ids.has(def.id)) { states.set(def.id, s); api.requestDraw(); } }, (e) => console.warn("graph overlay", def.id, e));
    };
    // A large map paints its first frame before the overlay analysis (communities, bridges ...) runs on the main thread.
    clearTimeout(deferred.get(def.id));
    if (isLargeMap(api.nodes.length)) deferred.set(def.id, setTimeout(() => { if (api.canvas && api.canvas.isConnected) run(); }, 50)); else run();
  }

  const rt = {
    list: () => OVERLAYS,
    active,
    isActive: (id) => ids.has(id),
    state: (id) => states.get(id),
    /** Does any active overlay need item nodes in the dataset? */
    needsItems: () => active().some((o) => (o.needs || []).includes("items")),
    /** Switch an overlay on/off (persisted). Emits "overlaysChanged"; the view reloads data if `needs` changed. */
    setActive(id, on) {
      const was = ids.has(id);
      if (on) ids.add(id); else { ids.delete(id); states.delete(id); }
      activeCache = null;
      saveOverlayIds([...ids]);
      if (on && !was) { const d = OVERLAYS.find((o) => o.id === id); if (d) load(d); }
      api.requestDraw();
      api.emit("overlaysChanged", { id, on });
    },
    /** (Re)load every active overlay's state - the engine calls this after each rebuild of the map. */
    reload() { states.clear(); active().forEach(load); },
    /** Merged nodeStyle for a node, or null when no active overlay styles it (the fast path). */
    nodeStyle(n) {
      let out = null;
      for (const o of active()) {
        if (!o.nodeStyle) continue;
        let s = null;
        try { s = o.nodeStyle(n, states.get(o.id), api); } catch (e) { console.warn("graph overlay", o.id + ".nodeStyle", e); }
        if (!s) continue;
        out ||= {};
        for (let k = 0; k < STYLE_KEYS.length; k++) { const key = STYLE_KEYS[k]; if (s[key] != null) out[key] = s[key]; }
        if (s.scale != null) out.scale = (out.scale ?? 1) * s.scale;
        if (s.alpha != null) out.alpha = (out.alpha ?? 1) * s.alpha;
      }
      return out;
    },
    hasStyles: () => active().some((o) => o.nodeStyle),
    under(ctx) { active().forEach((o) => o.drawUnder && guard(o.id + ".drawUnder", () => o.drawUnder(ctx, api, states.get(o.id)))); },
    over(ctx) { active().forEach((o) => o.drawOver && guard(o.id + ".drawOver", () => o.drawOver(ctx, api, states.get(o.id)))); },
    legendHtml: () => active().map((o) => (o.legend ? guard(o.id + ".legend", () => o.legend(states.get(o.id)), "") : "")).filter(Boolean).join(""),
    infoHtml: (n) => active().map((o) => (o.info ? guard(o.id + ".info", () => o.info(n, states.get(o.id), api), "") : "")).filter(Boolean).join(""),
  };
  return rt;
}

// One info-box section carries every active overlay's `info` html.
infoSections.push({ id: "overlays", order: 100, render: (node, api) => api.overlays?.infoHtml(node) || null });
