// Path mode: click two nodes and see how they connect through your dumps (breadth-first over the visible links).
// The mode flag survives rebuilds of the map (it belongs to the toolbar button); a half-made or finished path does not.
import { esc, toast } from "../ui.js";
import { showHtml, hide } from "./infobox.js";

const st = { mode: false, a: null, path: null };   // path = { ids: [..], nodes: Set, edges: Set(edgeKey) }

export const isPathMode = () => st.mode;

function findPath(api, from, to) {
  const nbrIds = api.nbrIds;
  const prev = { [from]: null }, queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === to) break;
    for (const nx of nbrIds[cur] || []) if (!(nx in prev)) { prev[nx] = cur; queue.push(nx); }
  }
  if (!(to in prev)) return null;
  const ids = [];
  for (let c = to; c != null; c = prev[c]) ids.unshift(c);
  return { ids, nodes: new Set(ids), edges: new Set(ids.slice(1).map((id, i) => api.edgeKey(ids[i], id))) };
}

function reset(api) { st.a = null; st.path = null; api.setHighlight(null); }

function pathClick(api, n) {
  const GC = api.colors, byId = api.byId;
  if (!st.a || st.path) {
    st.a = n.id; st.path = null; api.setHighlight(null);
    api.select(n.id);
    showHtml(`<b>🧭 From ${esc(n.label)}</b><div class="small muted" style="margin-top:6px">Now click the node you want to reach.</div>`);
    api.requestDraw();
    return;
  }
  if (n.id === st.a) return;
  st.path = findPath(api, st.a, n.id);
  api.setHighlight(st.path);
  api.select(null);
  showHtml(st.path
    ? `<b>🧭 ${st.path.ids.length - 1} step${st.path.ids.length === 2 ? "" : "s"}</b><div class="small" style="margin-top:8px">${st.path.ids.map((id, i) => `<div style="margin:3px 0 3px ${Math.min(i, 6) * 6}px">${i ? "↳ " : ""}<span style="color:${GC.colors[byId[id].type] || GC.dump}">●</span> ${esc(byId[id].label)}</div>`).join("")}</div><div class="small muted" style="margin-top:8px">Click any node to start another path.</div>`
    : `<b>🧭 No connection</b><div class="small muted" style="margin-top:6px">${esc(byId[st.a].label)} and ${esc(n.label)} aren't linked through any dump you're showing. Try lowering Min mentions or widening the date range.</div>`);
  api.requestDraw();
}

/** Toolbar button handler: switch Path mode on/off. Returns the new state. */
export function togglePath(api) {
  st.mode = !st.mode;
  reset(api);
  hide();
  api.requestDraw();
  if (st.mode) toast("Path: click one node, then another");
  return st.mode;
}

/** Wire path mode into the engine's click event. Called once per api. */
export function installPath(api) {
  api.on("nodesChanged", () => { st.a = null; st.path = null; });   // a rebuilt map starts without a path
  api.on("click", (ev) => {
    if (!ev.node) { st.a = null; st.path = null; api.setHighlight(null); return; }   // any click on empty space clears the path
    if (st.mode) { ev.handled = true; pathClick(api, ev.node); }
  });
}
