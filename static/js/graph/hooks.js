// "Ready" hooks: code that wants to subscribe to the engine bus (keyboard navigation, hover card, ...) registers
// a function here, and the Brain map view calls it once each time the map view is entered, with the persistent
// engine api and the view state. A hook may return a function; it is called when the view is entered again
// (i.e. before the next set of hooks runs) so a plugin can clean up window listeners it added.
//
//   import { onGraphReady } from "./hooks.js";
//   onGraphReady((api, state) => { const off = api.on("keydown", ({ e, node }) => { ... }); return off; });
const hooks = [];
let cleanups = [];

export function onGraphReady(fn) { hooks.push(fn); return fn; }

export function runGraphReady(api, state) {
  cleanups.forEach((c) => { try { c(); } catch {} });
  cleanups = [];
  hooks.forEach((fn) => {
    try { const c = fn(api, state); if (typeof c === "function") cleanups.push(c); }
    catch (e) { console.warn("graph ready hook failed", e); }
  });
}
