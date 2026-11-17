// Edit tab, undo half: the Undo / Redo buttons, the keyboard binding, and the small helpers every undoable edit shares.
// (The Merge tool lives in drag-merge.js; the Link tool in blueprint.js.) Contract: toolbar.js, undo.js. Owner: graph-undo.
//
//   exports  reloadMap(api, state, { select })   re-fetch the graph and rebuild the map; the viewport and the selection stay
//                                                 put (state.mount() snapshots the arrangement), `select` picks a node instead
//            postJson(path, body)                POST /api<path>; throws an Error with .status; on 404/409 the error is
//                                                 .permanent (the undo stack drops such an entry instead of retrying for ever)
//            undoToast(message, { onUndo })      a toast with an inline Undo button (the shared toast() has no button)
import { esc } from "../ui.js";
import { registerTool, notifyToolbar, getMode, setMode } from "./toolbar.js";
import { undo, redo, canUndo, canRedo, peekLabels, onUndoChange, installUndoKeys, clearUndo } from "./undo.js";
import { onGraphReady } from "./hooks.js";
import { loadGraph } from "./data.js";
import { selectAndReveal } from "./keyboard.js";

/** POST JSON to the backend. Keeps the HTTP status on the error so callers can tell "try again" from "never". */
export async function postJson(path, body) {
  let r;
  try { r = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new Error("Couldn't reach the app."); }
  let data = null;
  try { data = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) {
    const d = data && data.detail;
    const err = new Error(typeof d === "string" ? d : r.statusText || "Request failed");
    err.status = r.status;
    if (r.status === 404 || r.status === 409 || r.status === 400) err.permanent = true;   // it will not start working on a retry
    throw err;
  }
  return data;
}

/** Re-fetch the graph and rebuild the map in place. Selection: `select` (a node id) if given, else whatever was selected. */
export async function reloadMap(api, state, { select } = {}) {
  const sel = select !== undefined ? select : api.selectedId;
  state.data = await loadGraph(!!(state.data && state.data.hasItems));
  state.mount();                                   // snapshots the current arrangement first, so the viewport does not jump
  if (sel && api.byId[sel]) selectAndReveal(api, sel);
}

let toastEl = null, toastTimer = 0;
/** A toast with an inline "Undo" button. Replaces the previous one; goes away after ~7 s. */
export function undoToast(message, { onUndo, ms = 7000 } = {}) {
  if (toastEl) { toastEl.remove(); toastEl = null; }
  clearTimeout(toastTimer);
  const t = toastEl = document.createElement("div");
  t.className = "toast bdl-undo-toast";
  t.setAttribute("role", "status");
  t.innerHTML = `<span class="ut-msg">${esc(message)}</span>${onUndo ? `<button type="button" class="ut-btn">Undo</button>` : ""}`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 20);
  const close = () => { t.classList.remove("show"); setTimeout(() => { t.remove(); if (toastEl === t) toastEl = null; }, 300); };
  const btn = t.querySelector(".ut-btn");
  if (btn) btn.onclick = () => { close(); onUndo(); };
  toastTimer = setTimeout(close, ms);
  return close;
}

const SVG = (inner) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_UNDO = SVG(`<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`);
const ICON_REDO = SVG(`<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`);

// The ribbon reads `tip` once, so the buttons also carry update(el): it keeps the tooltip and aria-label on "Undo: <what>".
const tipOf = (which) => {
  const l = peekLabels()[which];
  const name = which === "undo" ? "Undo" : "Redo";
  const key = which === "undo" ? "Ctrl+Z" : "Ctrl+Shift+Z";
  return l ? `${name}: ${l} (${key})` : `Nothing to ${name.toLowerCase()} (${key})`;
};
const refresh = (which) => (el) => { if (el) { const t = tipOf(which); el.title = t; el.setAttribute("aria-label", t); } };

registerTool({
  tab: "edit", id: "undo", label: "Undo", icon: ICON_UNDO, kind: "button", order: 40, group: "history", key: "Ctrl+Z",
  tip: "Undo your last change to the map (Ctrl+Z).",
  help: "Takes back the last thing you changed on the map, such as a merge or a link. Press it again to go further back. Ctrl+Z does the same while the map is on screen.",
  run: () => { undo(); },
  isEnabled: () => canUndo(),
  update: refresh("undo"),
});
registerTool({
  tab: "edit", id: "redo", label: "Redo", icon: ICON_REDO, kind: "button", order: 41, group: "history", key: "Ctrl+Shift+Z",
  tip: "Do again the change you just undid (Ctrl+Shift+Z).",
  help: "Puts back what you just undid. Making a new change clears what could be redone. Ctrl+Shift+Z or Ctrl+Y does the same.",
  run: () => { redo(); },
  isEnabled: () => canRedo(),
  update: refresh("redo"),
});

onUndoChange(() => notifyToolbar());

// Every visit to the map starts with an empty stack (entries refer to nodes of the map that was just left).
onGraphReady(() => {
  installUndoKeys();      // idempotent: one document listener for the life of the page
  clearUndo();
  if (getMode() === "merge") setMode("select");
  notifyToolbar();
});
