// Brain map view: the router entry. Loads the graph, owns the view state and wires the modules in static/js/graph/
// (see docs/graph-architecture.md). `graph/concept/<name>` and `graph/person/<name>` hand off to the browse view.
import { $, esc } from "../ui.js";
import { loadTypes } from "../state.js";
import * as browse from "./browse.js";
import "../graph/plugins.js";
import { prefs, hidden, loadHidden, saveHidden } from "../graph/prefs.js";
import { fetchTypes, FALLBACK_TYPES, needItems, loadGraph, applyFilters } from "../graph/data.js";
import { createGraphApi } from "../graph/engine.js";
import { installInfobox } from "../graph/infobox.js";
import { installPath } from "../graph/path.js";
import { installTimelapse } from "../graph/timelapse.js";
import { runGraphReady } from "../graph/hooks.js";
import { renderPanel } from "../graph/panel.js";

export async function render(ctx) {
  if (ctx.params[0] === "concept" || ctx.params[0] === "person") return browse.render(ctx);
  // The view state handed to the panel and to "ready" hooks (documented in docs/graph-architecture.md).
  const state = { types: FALLBACK_TYPES, hidden, prefs, data: null, api: null, panel: null };
  try { state.types = await fetchTypes(); } catch { /* keep the fallback list */ }
  loadHidden(state.types);
  const gapi = state.api = createGraphApi({ getTypes: () => state.types });
  gapi.viewState = state;
  window.__bdlGraph = gapi;   // debugging / scripted tests (scripts/graph_shot.mjs)
  installInfobox(gapi); installPath(gapi); installTimelapse(gapi);
  runGraphReady(gapi, state);

  const wantItems = () => needItems(state.types, hidden, gapi.overlays.needsItems());
  async function load() {
    try { state.data = await loadGraph(wantItems()); }
    catch (e) {
      $("#graph-wrap").innerHTML = `<div class="center">Couldn't load the graph: ${esc(e.message)}</div>`;
      state.data = null;
    }
  }

  // Rebuild the map from the current data + filters (a fresh canvas each time; the api survives).
  state.mount = () => {
    const wrap = $("#graph-wrap");
    if (!wrap || !state.data) return;
    gapi.snapshot();   // keep the current arrangement so the rebuilt map picks up where this one left off
    const total = state.data.nodes.length;
    const { nodes, edges } = applyFilters(state.data, prefs);
    state.panel?.setCount(nodes.length === total ? `${total} nodes` : `Showing ${nodes.length} of ${total} nodes`);
    wrap.innerHTML = `<canvas id="graph-canvas"></canvas><div id="graph-info" class="graph-info" style="display:none"></div><div id="graph-tl" class="graph-tl" style="display:none"></div>`;
    if (!nodes.length) {
      wrap.innerHTML = `<div class="center">Nothing to show with these filters.${state.resetFilters ? `<div style="margin-top:12px"><button class="btn ghost small" id="graph-empty-reset">Reset filters</button></div>` : ""}</div>`;
      const reset = $("#graph-empty-reset"); if (reset) reset.onclick = () => state.resetFilters();
      return;
    }
    gapi.mount($("#graph-canvas"), { nodes, edges });
    // a layout can show fewer nodes than the filters leave (the concept map hides dumps ...): say what is on screen
    const shown = gapi.nodes.length;
    if (shown !== nodes.length) state.panel?.setCount(shown === total ? `${total} nodes` : `Showing ${shown} of ${total} nodes`);
  };
  // Reload node types (after a legend edit), repaint the legend, fetch item nodes if now needed, rebuild.
  state.refresh = async () => {
    try { state.types = await fetchTypes(); } catch { /* keep the current list on a transient failure */ }
    await loadTypes();  // item-type edits from the legend also affect kindBadge() elsewhere (Review)
    state.panel?.paintLegend?.();
    if (wantItems() && !state.data?.hasItems) await load();
    state.mount();
  };
  state.toggleType = async (typeId) => {
    hidden.has(typeId) ? hidden.delete(typeId) : hidden.add(typeId);
    saveHidden();
    if (wantItems() && !state.data?.hasItems) await load();
    state.mount();
  };
  state.setFocus = (on) => {
    const sel = gapi.selectedId;   // the rebuilt map starts with nothing selected, and Focus needs a selection to mean anything
    prefs.set("focus", !!on); state.mount();
    if (sel && gapi.byId[sel]) gapi.select(sel);
  };
  gapi.on("overlaysChanged", async () => {
    if (gapi.overlays.needsItems() && !state.data?.hasItems) { await load(); state.mount(); }
  });

  ctx.setLayout("full");
  state.panel = renderPanel(ctx, state);
  await load();
  if (!state.data) return;
  if (!state.data.nodes.length) {
    $("#graph-wrap").innerHTML = `<div class="center">Nothing to map yet — make a few dumps first.</div>`;
    return;
  }
  state.mount();
}
