// The Brain map chrome: the ribbon on top (ribbon.js draws it from the tool registry in toolbar.js) and the map wrap
// below it. views/graph.js only calls renderPanel(ctx, state).
//
// renderPanel(ctx, state) calls ctx.setTitle(...), writes the ribbon host and an empty
// <div class="graph-wrap" id="graph-wrap"></div> into #view, and returns { paintLegend(), setCount(text) }:
//   paintLegend()  rebuilds the ribbon's tool row (the view calls it after node types change)
//   setCount(text) the live "Showing X of Y nodes" text in the ribbon's status area (#graph-count)
// It also sets state.resetFilters (the map's empty state offers it as a button) and draws the overlay legend card: the
// active overlays' legend(state) html in a small card at the bottom-right of the map (.gp-legend), rebuilt on
// nodesChanged / overlaysChanged because the map wrap is replaced on every mount.
// Ids kept for other modules: #graph-find, #graph-find-list (find.js), #graph-tl-btn, #graph-slot-export,
// #graph-slot-keys, #graph-count, window event "bdl-graph-panel-rendered", and in the map wrap #graph-info, #graph-tl,
// #graph-canvas (created by state.mount()).
import { $, esc } from "../ui.js";
import { mountRibbon } from "./ribbon.js";
import { bindToolContext } from "./ribbon-tools.js";
import { resetFilters } from "./ribbon-filters.js";

export function renderPanel(ctx, state) {
  const { api } = state;
  let legendKey = "";

  ctx.setTitle("Brain map", "");
  $("#view").innerHTML = `<div class="wide gp">
    <div id="graph-ribbon-host" class="gr-host"></div>
    <div class="gp-main" id="graph-main"><div class="graph-wrap" id="graph-wrap"></div></div></div>`;

  bindToolContext(api, state);
  const ribbon = mountRibbon($("#graph-ribbon-host"), { api, state });
  state.resetFilters = () => resetFilters(state);

  // overlay legends: a small card on the map. The map wrap is rebuilt on every mount, so (re)create it on nodesChanged.
  function paintMapLegend() {
    const wrap = $("#graph-wrap");
    if (!wrap) return;
    const rows = api.overlays.active().map((o) => {
      let html = "";
      try { html = o.legend ? o.legend(api.overlays.state(o.id)) || "" : ""; } catch (e) { console.warn("graph overlay", o.id, "legend", e); }
      return html ? `<div class="gp-legend-row"><span class="gp-legend-t">${o.icon ? esc(o.icon) + " " : ""}${esc(o.label)}</span><div class="gp-legend-body">${html}</div></div>` : "";
    }).filter(Boolean).join("");
    let box = $(".gp-legend", wrap);
    if (!rows) { box?.remove(); legendKey = ""; return; }
    if (box && legendKey === rows) return;
    if (!box) { box = document.createElement("div"); box.className = "gp-legend"; wrap.appendChild(box); }
    box.innerHTML = rows; legendKey = rows;
  }
  let legendTimer = 0;
  api.on("nodesChanged", () => { legendKey = ""; paintMapLegend(); });
  api.on("overlaysChanged", paintMapLegend);
  api.on("afterDraw", () => {   // overlay state arrives asynchronously after load() and ends with a redraw: check shortly after it
    if (legendTimer || (!api.overlays.active().length && !legendKey)) return;
    legendTimer = setTimeout(() => { legendTimer = 0; paintMapLegend(); }, 250);
  });

  return {
    paintLegend: () => ribbon.rerender(),
    setCount: (text) => ribbon.setStatus(text),
  };
}
