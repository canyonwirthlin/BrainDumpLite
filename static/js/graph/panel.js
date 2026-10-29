// The Brain map control panel: a slim bar above the map (Find, layout quick-switch, Fit, node count, Panel toggle)
// plus a collapsible side panel with grouped sections. views/graph.js only calls renderPanel(ctx, state).
//
// Sections are generated from the registries, so other modules appear with no change here:
//   Layout    every entry of LAYOUTS (icon, label, desc)            - layouts.js
//   Overlays  every entry of OVERLAYS, grouped by `group`           - overlays.js (the section is absent while empty)
//   Show      node types (+ rename / recolor / add), date range, minimum mentions, Reset filters, live count
//   Edges     mention links, similar links, similarity threshold    - filter-edges.js owns the prefs + the filter
//   Display   spacing, titles only on hover, Focus
//   Tools     Path, Fit, Time-lapse button, and two EMPTY mount points for other modules (see below)
// Active overlays' legend(state) is drawn in a small card at the bottom-right of the map (class .gp-legend).
//
// MOUNT POINTS: inside the Tools section the panel renders  <div id="graph-slot-timelapse"></div>, <div id="graph-slot-keys"></div>  and
//   <div id="graph-slot-export"></div> . The panel re-renders its body (for example after a node type is edited or
// filters are reset), which throws mounted content away, so after EVERY (re)render it dispatches
//   window.dispatchEvent(new CustomEvent("bdl-graph-panel-rendered"))
// Listen to it (and also mount once when the view is ready) and (re)mount into the slots; both are cheap to refill.
//
// renderPanel(ctx, state) returns { paintLegend(), setCount(text) }:
//   paintLegend()  re-renders the panel body (the view calls it after node types change)
//   setCount(text) the live "Showing X of Y nodes" text (bar + Show section)
// Other ids kept for other modules: #graph-find, #graph-find-list (find.js), #graph-tl-btn, and in the map wrap
// #graph-info, #graph-tl, #graph-canvas (created by state.mount()).
// Persisted UI state (localStorage): bdl-graph-panel-open ("1"/"0"), bdl-graph-panel-collapsed (JSON array of section ids).
import { $, $$, esc, toast } from "../ui.js";
import { openNodeEditor } from "../nodeeditor.js";
import { LAYOUTS, layoutId } from "./layouts.js";
import { RANGES, saveHidden } from "./prefs.js";
import { graphColors } from "./engine.js";
import { bindFind } from "./find.js";
import { isPathMode, togglePath } from "./path.js";
import { SIM_MIN, SIM_MAX, edgesAreDefault, resetEdgePrefs } from "./filter-edges.js";

const KEY_OPEN = "bdl-graph-panel-open", KEY_COLLAPSED = "bdl-graph-panel-collapsed";
const DEFAULT_MIN_MENTIONS = 2;   // the pref's default (prefs.js); Reset filters goes back to it
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the panel just forgets */ } },
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>'),
  fit: svg('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
  path: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17c6 0 2-10 8-10"/>'),
  play: svg('<path d="M7 5v14l12-7z" fill="currentColor"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
};

// RANGES is keyed by numbers (+ "all"), which JS iterates numerically: put "all" first, then shortest to longest.
const rangeEntries = () => Object.entries(RANGES).sort((a, b) => (a[1][1] || 0) - (b[1][1] || 0));
function rangeLabel([label, days]) { return days ? `${days} days` : label; }

export function renderPanel(ctx, state) {
  const { prefs, api } = state;
  const hidden = state.hidden;
  let lastCount = "";
  let legendKey = "";

  // ── small builders ────────────────────────────────────────────────────────────────────────
  const switchRow = ({ id, label, desc = "", checked, icon = "", attrs = "" }) => `
    <label class="gp-row" title="${esc(desc)}">
      <span class="gp-row-txt"><span class="gp-row-t">${icon ? `<span class="gp-row-ico" aria-hidden="true">${esc(icon)}</span>` : ""}${esc(label)}</span>${desc ? `<span class="gp-row-d">${esc(desc)}</span>` : ""}</span>
      <input type="checkbox" role="switch" class="gp-sw" id="${id}" ${checked ? "checked" : ""} ${attrs}><i class="gp-track" aria-hidden="true"></i>
    </label>`;
  const sliderRow = ({ id, label, min, max, step, value, out, hint = "", disabled = false }) => `
    <div class="gp-slider ${disabled ? "off" : ""}">
      <div class="gp-slider-top"><label for="${id}">${esc(label)}</label><output id="${id}-out" for="${id}">${esc(out)}</output></div>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" ${disabled ? "disabled" : ""}>
      ${hint ? `<div class="gp-hint" id="${id}-hint">${esc(hint)}</div>` : ""}
    </div>`;
  const section = (id, title, body) => {
    const open = !collapsed.has(id);
    return `<section class="gp-sec" data-sec="${id}">
      <h3><button type="button" class="gp-sec-h" aria-expanded="${open}" aria-controls="gp-body-${id}" data-sec-toggle="${id}"><span>${esc(title)}</span>${ICON.chevron}</button></h3>
      <div class="gp-sec-body" id="gp-body-${id}" ${open ? "" : "hidden"}>${body}</div>
    </section>`;
  };

  let collapsed = new Set();
  try { const v = JSON.parse(store.get(KEY_COLLAPSED) || "[]"); if (Array.isArray(v)) collapsed = new Set(v.map(String)); } catch { /* ignore */ }

  // ── sections ──────────────────────────────────────────────────────────────────────────────
  const curLayout = () => layoutId(prefs.get("layout"));
  const layoutSection = () => section("layout", "Layout", `<div class="gp-layouts" role="group" aria-label="Map layout">${LAYOUTS.map((l) => `
      <button type="button" class="gp-layout ${l.id === curLayout() ? "on" : ""}" data-layout="${esc(l.id)}" title="${esc(l.desc || "")}" aria-pressed="${l.id === curLayout()}">
        <span class="gp-layout-ico" aria-hidden="true">${esc(l.icon || "◇")}</span>
        <span class="gp-layout-txt"><b>${esc(l.label)}</b><span>${esc(l.desc || "")}</span></span>
      </button>`).join("")}</div>`);

  const overlaySection = () => {
    const list = api.overlays.list();
    if (!list.length) return "";
    const groups = [];
    list.forEach((o) => {
      const g = o.group || "";
      let slot = groups.find((x) => x.name === g);
      if (!slot) groups.push(slot = { name: g, items: [] });
      slot.items.push(o);
    });
    groups.sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0));   // ungrouped overlays first, groups keep registration order
    const body = groups.map((g) => `
      ${g.name ? `<div class="gp-group">${esc(g.name)}</div>` : ""}
      ${g.items.map((o) => switchRow({ id: `gp-ov-${o.id}`, label: o.label, desc: o.desc, icon: o.icon, checked: api.overlays.isActive(o.id), attrs: `data-overlay="${esc(o.id)}"` })).join("")}`).join("");
    return section("overlays", "Overlays", body);
  };

  const defaultHidden = () => state.types.filter((t) => !t.builtin).map((t) => t.id);
  const filtersAreDefault = () => {
    const want = new Set(defaultHidden());
    const sameTypes = state.types.every((t) => want.has(t.id) === hidden.has(t.id));
    return sameTypes && prefs.get("range") === "all" && prefs.get("minMentions") === DEFAULT_MIN_MENTIONS && edgesAreDefault(prefs);
  };

  const showSection = () => {
    const gc = graphColors(state.types);
    const range = prefs.get("range"), min = prefs.get("minMentions");
    return section("show", "Show", `
      <div class="gp-count-line" id="gp-count-line" aria-live="polite">${esc(lastCount)}</div>
      <div class="gp-label">Node types</div>
      <div class="gp-types">${state.types.map((t) => `
        <span class="gp-type ${hidden.has(t.id) ? "off" : ""}">
          <button type="button" class="gp-chip" data-type="${esc(t.id)}" aria-pressed="${!hidden.has(t.id)}" title="Show or hide ${esc(t.label.toLowerCase())}"><i class="gp-dot" style="background:${gc.colors[t.id] || "var(--dim)"}"></i>${esc(t.label)}</button>
          <button type="button" class="gp-edit" data-edit="${esc(t.id)}" title="Rename or recolor" aria-label="Rename or recolor ${esc(t.label)}">${ICON.pencil}</button>
        </span>`).join("")}
        <button type="button" class="gp-chip gp-add" id="graph-add-type" title="Add a new node type">+ Node type</button>
      </div>
      <div class="gp-label">Date range</div>
      <div class="gp-seg gp-seg-full" role="group" aria-label="Date range">${rangeEntries().map(([k, r]) => `
        <button type="button" data-range="${k}" aria-pressed="${k === range}" class="${k === range ? "on" : ""}">${esc(rangeLabel(r))}</button>`).join("")}</div>
      ${sliderRow({ id: "graph-min", label: "Minimum mentions", min: 1, max: 6, step: 1, value: min, out: String(min), hint: minHint(min) })}
      <button type="button" class="gp-btn gp-reset" id="graph-reset" ${filtersAreDefault() ? "disabled" : ""} title="Back to the default node types, date range, minimum mentions and links">${ICON.reset}<span>Reset filters</span></button>`);
  };
  const minHint = (v) => (v <= 1 ? "Showing every concept and person." : `Hiding concepts and people mentioned in fewer than ${v} dumps.`);

  const simHint = (on, v) => (!on ? "Similar links are switched off." : v <= SIM_MIN ? "Showing every similar link." : `Only links between dumps at least ${Math.round(v * 100)}% alike.`);
  const edgesSection = () => {
    const similarOn = prefs.get("edgeSimilar"), thr = Math.max(SIM_MIN, Math.min(SIM_MAX, prefs.get("edgeMinSimilar")));
    return section("edges", "Links", `
      ${switchRow({ id: "graph-edge-mention", label: "Mention links", desc: "Solid lines from a dump to the concepts and people in it.", checked: prefs.get("edgeMention") })}
      ${switchRow({ id: "graph-edge-similar", label: "Similar links", desc: "Dashed lines between dumps that read alike.", checked: similarOn })}
      ${sliderRow({ id: "graph-edge-thr", label: "How alike", min: SIM_MIN, max: SIM_MAX, step: 0.01, value: thr, out: thr <= SIM_MIN ? "Any" : `${Math.round(thr * 100)}%`, hint: simHint(similarOn, thr), disabled: !similarOn })}`);
  };

  const displaySection = () => {
    const spacing = prefs.get("spacing");
    return section("display", "Display", `
      ${sliderRow({ id: "graph-spacing", label: "Spacing", min: 0.5, max: 3, step: 0.05, value: spacing, out: spacing.toFixed(1) + "×", hint: "How far apart the nodes sit." })}
      ${switchRow({ id: "graph-hovertitles", label: "Titles only on hover", desc: "Otherwise the busiest nodes show a title, and more as you zoom in.", checked: prefs.get("hoverTitles") })}
      ${switchRow({ id: "graph-focus", label: "Focus", desc: "Dim everything more than two hops from the selected node.", checked: prefs.get("focus") })}`);
  };

  const toolsSection = () => section("tools", "Tools", `
    <div class="gp-tools">
      <button type="button" class="gp-btn" id="graph-path" aria-pressed="${isPathMode()}" title="Click two nodes to see how they connect through your dumps">${ICON.path}<span>Path</span></button>
      <button type="button" class="gp-btn" id="graph-fit-2" title="Zoom to show everything">${ICON.fit}<span>Fit to screen</span></button>
      <button type="button" class="gp-btn" id="graph-tl-btn" aria-pressed="${!!api.timelapse?.playing}" title="Watch your map grow, dump by dump">${tlInner(!!api.timelapse?.playing)}</button>
    </div>
    <div id="graph-slot-timelapse" class="gp-slot"></div>
    <div id="graph-slot-export" class="gp-slot"></div>
    <div id="graph-slot-keys" class="gp-slot"></div>`);
  const tlInner = (on) => `${on ? ICON.stop : ICON.play}<span>${on ? "Stop" : "Time-lapse"}</span>`;

  // ── bar + shell markup ────────────────────────────────────────────────────────────────────
  const panelOpen = () => $("#graph-main")?.dataset.panel === "open";
  const startOpen = (() => { const s = store.get(KEY_OPEN); return s === "1" ? true : s === "0" ? false : window.innerWidth >= 1150; })();

  ctx.setTitle("Brain map", "");
  $("#view").innerHTML = `<div class="wide gp">
    <div class="graph-bar gp-bar">
      <div class="graph-find gp-find"><span class="gp-find-ico">${ICON.search}</span><input type="search" id="graph-find" placeholder="Find a node…" autocomplete="off" aria-label="Find a node"><div id="graph-find-list" class="graph-find-list" style="display:none"></div></div>
      <div class="gp-seg" role="group" aria-label="Layout" id="gp-layout-bar">${LAYOUTS.map((l) => `
        <button type="button" data-layout="${esc(l.id)}" class="${l.id === curLayout() ? "on" : ""}" aria-pressed="${l.id === curLayout()}" aria-label="${esc(l.label)} layout" title="${esc(l.label)}: ${esc(l.desc || "")}"><span aria-hidden="true">${esc(l.icon || "◇")}</span></button>`).join("")}</div>
      <button type="button" class="gp-btn" id="graph-fit" title="Zoom to show everything">${ICON.fit}<span class="gp-fit-t">Fit</span></button>
      <span class="gp-spacer"></span>
      <span class="gp-count" id="graph-count" aria-live="polite"></span>
      <button type="button" class="gp-btn gp-panel-btn" id="graph-panel-toggle" aria-expanded="${startOpen}" aria-controls="graph-panel" title="Show or hide the map controls">${ICON.panel}<span>Panel</span></button>
    </div>
    <div class="gp-main" id="graph-main" data-panel="${startOpen ? "open" : "closed"}">
      <div class="graph-wrap" id="graph-wrap"></div>
      <aside class="gp-side" id="graph-panel" aria-label="Map controls"></aside>
    </div></div>`;
  const side = $("#graph-panel");

  // ── behaviour ─────────────────────────────────────────────────────────────────────────────
  const remount = debounce(() => state.mount(), 110);
  const syncReset = () => { const b = $("#graph-reset"); if (b) b.disabled = filtersAreDefault(); };
  const paintRange = (el) => { el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min) * 100).toFixed(1) + "%"); };
  const setSection = (id, open) => {
    open ? collapsed.delete(id) : collapsed.add(id);
    store.set(KEY_COLLAPSED, JSON.stringify([...collapsed]));
  };

  function chooseLayout(id) {
    if (id === curLayout()) return;
    prefs.set("layout", id);
    syncLayout();
    state.mount();
  }
  function syncLayout() {
    const cur = curLayout();
    $$("[data-layout]").forEach((b) => { const on = b.dataset.layout === cur; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  }

  function togglePanel(open = !panelOpen()) {
    const wrap = $("#graph-wrap"), before = wrap.clientWidth;
    $("#graph-main").dataset.panel = open ? "open" : "closed";
    $("#graph-panel-toggle").setAttribute("aria-expanded", String(open));
    store.set(KEY_OPEN, open ? "1" : "0");
    const delta = wrap.clientWidth - before;
    window.dispatchEvent(new Event("resize"));   // the engine resizes its canvas on window resize
    if (delta && api.nodes.length) api.view.panX += delta / 2;   // keep the map centred while the canvas grows or shrinks
  }

  function resetFilters() {
    prefs.set("range", "all"); prefs.set("minMentions", DEFAULT_MIN_MENTIONS); resetEdgePrefs(prefs);
    hidden.clear(); defaultHidden().forEach((id) => hidden.add(id)); saveHidden();
    paintBody();
    state.refresh();   // reloads types, loads item nodes if they are needed again, rebuilds the map
  }
  state.resetFilters = resetFilters;   // the map's empty state offers it as a button

  function paintBody() {
    if (!side.isConnected) return;
    side.innerHTML = [layoutSection(), overlaySection(), showSection(), edgesSection(), displaySection(), toolsSection()].join("");
    bindBody();
    $$("input[type=range]", side).forEach(paintRange);
    window.dispatchEvent(new CustomEvent("bdl-graph-panel-rendered"));
  }

  function bindBody() {
    $$("[data-sec-toggle]", side).forEach((b) => b.onclick = () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      $("#gp-body-" + b.dataset.secToggle, side).hidden = !open;
      setSection(b.dataset.secToggle, open);
    });
    $$("[data-layout]", side).forEach((b) => b.onclick = () => chooseLayout(b.dataset.layout));

    $$("[data-overlay]", side).forEach((i) => i.onchange = () => api.overlays.setActive(i.dataset.overlay, i.checked));

    $$(".gp-chip[data-type]", side).forEach((b) => b.onclick = () => {
      const id = b.dataset.type;
      state.toggleType(id);
      const off = hidden.has(id);
      b.setAttribute("aria-pressed", String(!off));
      b.closest(".gp-type").classList.toggle("off", off);
      syncReset();
    });
    $$(".gp-edit", side).forEach((b) => b.onclick = () => {
      const t = state.types.find((x) => x.id === b.dataset.edit);
      if (t) openNodeEditor(t, () => state.refresh());
    });
    $("#graph-add-type", side).onclick = () => openNodeEditor(null, () => { toast("Node type added — the AI looks for it from the next dump on."); state.refresh(); });
    $$("[data-range]", side).forEach((b) => b.onclick = () => {
      prefs.set("range", b.dataset.range);
      $$("[data-range]", side).forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
      state.mount(); syncReset();
    });
    const min = $("#graph-min", side);
    min.oninput = () => {
      const v = parseInt(min.value, 10);
      prefs.set("minMentions", v);
      $("#graph-min-out", side).textContent = String(v);
      $("#graph-min-hint", side).textContent = minHint(v);
      paintRange(min); remount(); syncReset();
    };
    $("#graph-reset", side).onclick = resetFilters;

    // links
    const edgeToggle = (id, pref) => { $(id, side).onchange = (e) => { prefs.set(pref, e.target.checked); refreshSimilarUi(); state.mount(); syncReset(); }; };
    edgeToggle("#graph-edge-mention", "edgeMention");
    edgeToggle("#graph-edge-similar", "edgeSimilar");
    const thr = $("#graph-edge-thr", side);
    function refreshSimilarUi() {
      const on = prefs.get("edgeSimilar"), v = parseFloat(thr.value);
      thr.disabled = !on;
      thr.closest(".gp-slider").classList.toggle("off", !on);
      $("#graph-edge-thr-out", side).textContent = v <= SIM_MIN ? "Any" : `${Math.round(v * 100)}%`;
      $("#graph-edge-thr-hint", side).textContent = simHint(on, v);
    }
    thr.oninput = () => { prefs.set("edgeMinSimilar", parseFloat(thr.value)); refreshSimilarUi(); paintRange(thr); remount(); syncReset(); };

    // display
    const sp = $("#graph-spacing", side);
    sp.oninput = () => {
      const v = parseFloat(sp.value);
      prefs.set("spacing", v);
      $("#graph-spacing-out", side).textContent = v.toFixed(1) + "×";
      paintRange(sp);
      api.reheat();
    };
    $("#graph-hovertitles", side).onchange = (e) => { prefs.set("hoverTitles", e.target.checked); api.requestDraw(); };
    $("#graph-focus", side).onchange = (e) => state.setFocus(e.target.checked);

    // tools
    $("#graph-path", side).onclick = (e) => e.currentTarget.setAttribute("aria-pressed", String(togglePath(api)));
    $("#graph-fit-2", side).onclick = () => api.fit();
    $("#graph-tl-btn", side).onclick = () => api.timelapse?.toggle();
  }

  // the bar
  $("#graph-fit").onclick = () => api.fit();
  $("#graph-panel-toggle").onclick = () => togglePanel();
  $$("#gp-layout-bar [data-layout]").forEach((b) => b.onclick = () => chooseLayout(b.dataset.layout));
  bindFind(state);

  // ── keep the panel in step with things other modules can change ──────────────────────────
  const syncSwitch = (id, on) => { const i = $(id); if (i && i.checked !== on) i.checked = on; };
  const syncTools = () => {
    const p = $("#graph-path"); if (p) p.setAttribute("aria-pressed", String(isPathMode()));
    syncSwitch("#graph-focus", !!prefs.get("focus"));
  };
  api.on("overlaysChanged", () => $$("[data-overlay]", side).forEach((i) => { i.checked = api.overlays.isActive(i.dataset.overlay); }));
  api.on("click", syncTools);
  api.on("keydown", syncTools);
  api.timelapse?.onChange((on) => {
    const b = $("#graph-tl-btn"); if (!b) return;
    b.innerHTML = tlInner(on); b.setAttribute("aria-pressed", String(on));
  });

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
  api.on("nodesChanged", () => { legendKey = ""; paintMapLegend(); syncTools(); });
  api.on("overlaysChanged", paintMapLegend);
  api.on("afterDraw", () => {   // overlay state arrives asynchronously after load() and ends with a redraw: check shortly after it
    if (legendTimer || (!api.overlays.active().length && !legendKey)) return;
    legendTimer = setTimeout(() => { legendTimer = 0; paintMapLegend(); }, 250);
  });

  paintBody();
  return {
    paintLegend: paintBody,
    setCount(text) {
      lastCount = text;
      const c = $("#graph-count"); if (c) c.textContent = text;
      const l = $("#gp-count-line"); if (l) l.textContent = text;
    },
  };
}
