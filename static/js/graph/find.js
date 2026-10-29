// "Find a node": type a name, pick a match, and the map centres on it and dims everything else.
// Expects the markup #graph-find (input) and #graph-find-list (results dropdown) to exist - the panel provides it.
// `state` is the Brain map view state: state.data (full unfiltered dataset), state.types, state.api.
import { $, $$, esc, toast } from "../ui.js";
import { graphColors } from "./engine.js";

export function bindFind(state) {
  const input = $("#graph-find"), list = $("#graph-find-list");
  if (!input || !list) return;
  const close = () => { list.style.display = "none"; list.innerHTML = ""; };
  const pick = (id) => {
    close(); input.value = "";
    input.blur(); state.api.canvas?.focus?.({ preventScroll: true });   // hand the keyboard back to the map (arrows, Enter, P ...)
    if (!state.api.focusOn(id)) toast("That node is hidden by your filters - lower Min mentions or widen the date range.");
  };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !state.data) return close();
    const hits = state.data.nodes.filter((n) => (n.label || "").toLowerCase().includes(q))
      .sort((a, b) => (a.label.toLowerCase().startsWith(q) ? 0 : 1) - (b.label.toLowerCase().startsWith(q) ? 0 : 1) || a.label.length - b.label.length).slice(0, 8);
    list.style.display = "block";
    list.innerHTML = hits.length
      ? hits.map((n) => `<button type="button" data-id="${esc(n.id)}"><i class="legend-dot" style="background:${graphColors(state.types).colors[n.type] || "#999"}"></i>${esc(n.label.slice(0, 48))}<span class="small muted">${esc(state.types.find((t) => t.id === n.type)?.label || n.type)}</span></button>`).join("")
      : `<div class="small muted" style="padding:8px 10px">No node matches.</div>`;
    $$("button", list).forEach((b) => b.onmousedown = (e) => { e.preventDefault(); pick(b.dataset.id); });
  };
  input.oninput = paint;
  input.onkeydown = (e) => {
    if (e.key === "Enter") { const b = $("button", list); if (b) pick(b.dataset.id); }
    else if (e.key === "Escape") { input.value = ""; close(); }
  };
  input.onblur = () => setTimeout(close, 120);
}
