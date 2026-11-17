// Brain map toolbar registry: the contract between the ribbon UI and every feature that wants a button on it.
// This file is DATA ONLY (no DOM). The ribbon (graph/ribbon.js, owner: graph-shell) reads it and draws the tabs;
// feature modules call registerTool() from their own file and never touch the ribbon.
//
//   registerTool({ tab, id, label, icon, tip, help, kind, run, isActive, isEnabled, mount, order })
//     tab        one of the tab ids below
//     id         unique across all tools, e.g. "link", "merge", "undo"
//     label      short text under/next to the icon
//     icon       an inline <svg> string (see ICON in graph/panel.js for the style) or a short emoji
//     tip        hover tooltip, ONE sentence, plain English ("Drag from one note to another to link them")
//     help       longer text shown in the tab's "?" panel (1-3 sentences, plain English)
//     kind       "button"  run() fires once
//                "toggle"  run() flips a setting; isActive() says whether it is on
//                "mode"    exclusive tool like Studio's Select/Move: run() is NOT used, setMode(id) is
//                "custom"  mount(el, { api, state }) fills the slot itself (sliders, dropdowns, find box)
//     isActive() / isEnabled()   optional, re-read after every notifyToolbar()
//     order      optional number; lower first, default 100
//
// Modes: exactly one mode is active ("select" by default). A mode tool owns the canvas pointer while active
// (blueprint "link" draws wires, "merge" merges on drop). Listen with onModeChange(fn); never assume you are
// the active mode: check getMode() === "<yourid>" before acting on a drag/click.
export const TAB_IDS = ["view", "layout", "overlays", "filter", "edit", "tools"];
export const TABS = [
  { id: "view",     label: "View",    help: "Move around the map: fit it to the screen, find a note, focus on one, change how labels and spacing look." },
  { id: "layout",   label: "Layout",  help: "Choose how the map is arranged." },
  { id: "overlays", label: "Overlays", help: "Switch on extra layers that point things out, such as clusters, bridges and trends." },
  { id: "filter",   label: "Filter",  help: "Decide what shows: note types, date range, minimum mentions and which kinds of links." },
  { id: "edit",     label: "Edit",    help: "Change your map: draw links between notes, merge nodes, undo and redo." },
  { id: "tools",    label: "Tools",   help: "Trace a path between two notes, replay your map over time, export it." },
];
export const TOOLS = [];

const listeners = new Set();
let mode = "select";
const modeListeners = new Set();

export function registerTool(t) {
  if (!t || !TAB_IDS.includes(t.tab)) throw new Error(`registerTool: unknown tab "${t && t.tab}"`);
  if (!t.id || TOOLS.some((x) => x.id === t.id)) throw new Error(`registerTool: missing or duplicate id "${t && t.id}"`);
  TOOLS.push({ kind: "button", order: 100, ...t });
  notifyToolbar();
}
export const toolsFor = (tab) => TOOLS.filter((t) => t.tab === tab).sort((a, b) => a.order - b.order);

/** Ask the ribbon to re-read isActive/isEnabled (call after any state change that affects a button). */
export function notifyToolbar() { for (const f of listeners) f(); }
export function onToolbarChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const getMode = () => mode;
export function setMode(id) {
  if (id === mode) return;
  const prev = mode; mode = id;
  for (const f of modeListeners) f(mode, prev);
  notifyToolbar();
}
export function onModeChange(fn) { modeListeners.add(fn); return () => modeListeners.delete(fn); }
