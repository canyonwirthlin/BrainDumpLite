// Force-directed brain map (canvas, no library).
import { $, $$, esc, colorCss, toast } from "../ui.js";
import { api } from "../api.js";
import { loadTypes } from "../state.js";
import { go } from "../router.js";
import { openNodeEditor } from "../nodeeditor.js";
import * as browse from "./browse.js";

const GRAPH_R = { dump: 7, concept: 5, person: 5 };
const ITEM_R = 3.5;

// Node/label colors follow the active theme; item-type colors come from /graph/types.
let TYPES = [];
function resolveColor(c) {
  const css = colorCss(c);
  if (css.startsWith("var(")) return getComputedStyle(document.documentElement).getPropertyValue(css.slice(4, -1)).trim() || "#999";
  return css;
}
function graphColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  const colors = {};
  for (const t of TYPES) colors[t.id] = resolveColor(t.color);
  return { colors, bg: v("--bg", "#0b0e14"), text: v("--text", "#e6e9f2"), edge: v("--dim", "#8b93a8"), dump: colors.dump || v("--accent", "#8b7cf6") };
}

// Node spacing (the slider above the graph): scales repulsion and edge length together.
const SPACING_KEY = "bdl-graph-spacing";
let spacing = 1, reheat = null, refit = null, redraw = null;   // reheat(): set by the running simulation so the slider can wake it up
try { const v = parseFloat(localStorage.getItem(SPACING_KEY)); if (v >= 0.5 && v <= 3) spacing = v; } catch {}

const LAYOUT_KEY = "bdl-graph-layout", MIN_ZOOM = 0.04;
const HOVER_KEY = "bdl-graph-hover-titles";
let hoverTitles = false;   // off by default: titles show as usual; on: a title appears only while hovering its node
try { hoverTitles = localStorage.getItem(HOVER_KEY) === "1"; } catch {}
let layout = "organic";   // organic: force-directed clusters · galaxy: your history laid out as a time-ordered spiral
try { const v = localStorage.getItem(LAYOUT_KEY); if (v === "organic" || v === "galaxy") layout = v; } catch {}

// Declutter filters (persisted per device). minMentions hides concepts/people that appear in fewer
// dumps than this - the one-off leaves are most of the clutter; range limits the map to recent dumps.
const MIN_KEY = "bdl-graph-min", RANGE_KEY = "bdl-graph-range";
const RANGES = { all: ["All time", 0], 7: ["Last 7 days", 7], 30: ["Last 30 days", 30], 90: ["Last 90 days", 90] };
let minMentions = 2, range = "all", jumpTo = null;
try { const v = parseInt(localStorage.getItem(MIN_KEY), 10); if (v >= 1 && v <= 6) minMentions = v; } catch {}
try { const v = localStorage.getItem(RANGE_KEY); if (v in RANGES) range = v; } catch {}

// Remembered between visits (this session): where every node sat and the pan/zoom, per layout, so coming
// back to the map doesn't re-scramble it. Pins (nodes you dragged and dropped) also survive restarts.
const savedLayouts = new Map();
let snapshotHook = null, timelapseHook = null, pathMode = false, pathReset = null;
const PINS_KEY = "bdl-graph-pins";
const loadPins = () => { try { const v = JSON.parse(localStorage.getItem(PINS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const savePins = (p) => { try { localStorage.setItem(PINS_KEY, JSON.stringify(p)); } catch {} };

const hidden = new Set();  // node types toggled off in the legend (persisted per device)
let lastData = null, focus = false, hiddenLoaded = false;

function loadHidden() {
  if (hiddenLoaded) return;
  hiddenLoaded = true;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("bdl-graph-types") || "null"); } catch {}
  if (saved) saved.forEach((t) => hidden.add(t));
  else TYPES.filter((t) => !t.builtin).forEach((t) => hidden.add(t.id));   // item nodes off by default
}
const saveHidden = () => { try { localStorage.setItem("bdl-graph-types", JSON.stringify([...hidden])); } catch {} };

function legendHtml() {
  const gc = graphColors();
  return `<span class="legend-types">` + TYPES.map((t) => `
    <span class="legend-item">
      <button class="chip ${hidden.has(t.id) ? "off" : "on"}" data-type="${t.id}" title="Show/hide ${t.label.toLowerCase()}"><i class="legend-dot" style="background:${gc.colors[t.id]}"></i>${esc(t.label)}</button>
      <button class="legend-edit" data-edit="${t.id}" title="Rename or recolor">✎</button>
    </span>`).join("") + `</span>`
    + `<button class="chip" id="graph-add-type" title="Add a new node type">+ Node type</button>`
    + `<button class="chip ${focus ? "on" : ""}" id="graph-focus" title="Dim everything more than two hops from the selected node">◎ Focus</button>`;
}

function bindLegendEditors(ctx) {
  $$(".legend-edit").forEach((b) => b.onclick = () => {
    const t = TYPES.find((x) => x.id === b.dataset.edit);
    if (t) openNodeEditor(t, () => refresh(ctx));
  });
  const add = $("#graph-add-type");
  if (add) add.onclick = () => openNodeEditor(null, () => { toast("Node type added — the AI looks for it from the next dump on."); refresh(ctx); });
}

async function refresh(ctx) {
  try { TYPES = await api.get("/graph/types"); } catch { /* keep the current list on a transient failure */ }
  await loadTypes();  // item-type edits from the legend also affect kindBadge() elsewhere (Review)
  ctx.setTitle("Brain map", legendHtml());
  bindLegendEditors(ctx);
  $$(".topbar-slot .chip[data-type]").forEach((b) => b.onclick = () => toggleType(ctx, b));
  $("#graph-focus").onclick = () => { focus = !focus; $("#graph-focus").classList.toggle("on", focus); mount(); };
  if (needItems() && !lastData?.hasItems) await load();
  mount();
}

async function toggleType(ctx, b) {
  const t = b.dataset.type;
  hidden.has(t) ? hidden.delete(t) : hidden.add(t);
  saveHidden();
  b.classList.toggle("off", hidden.has(t)); b.classList.toggle("on", !hidden.has(t));
  if (needItems() && !lastData?.hasItems) await load();
  mount();
}

function mount() {
  const wrap = $("#graph-wrap");
  if (!wrap || !lastData) return;
  snapshotHook?.();   // keep the current arrangement so the rebuilt map picks up where this one left off
  const total = lastData.nodes.length;
  // 1. type toggles + date range (a dump outside the range takes its items with it)
  const cutoff = RANGES[range][1] ? new Date(Date.now() - RANGES[range][1] * 864e5).toISOString() : "";
  const outOfRange = new Set(lastData.nodes.filter((n) => n.type === "dump" && cutoff && (n.created_at || "") < cutoff).map((n) => n.id));
  let nodes = lastData.nodes.filter((n) => !hidden.has(n.type) && !outOfRange.has(n.id) && !(n.dump && outOfRange.has(n.dump)));
  let ids = new Set(nodes.map((n) => n.id));
  let edges = lastData.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  // 2. concepts/people mentioned in fewer than minMentions of the remaining dumps drop out. Always runs
  // (threshold at least 1) so a concept/person whose dumps were all filtered out by the date range goes too.
  {
    const dumpIds = new Set(nodes.filter((n) => n.type === "dump").map((n) => n.id));
    const seen = {};
    edges.forEach((e) => {
      if (dumpIds.has(e.source)) (seen[e.target] ||= new Set()).add(e.source);
      if (dumpIds.has(e.target)) (seen[e.source] ||= new Set()).add(e.target);
    });
    nodes = nodes.filter((n) => (n.type !== "concept" && n.type !== "person") || (seen[n.id]?.size || 0) >= Math.max(1, minMentions));
    ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }
  const cnt = $("#graph-count");
  if (cnt) cnt.textContent = nodes.length === total ? `${total} nodes` : `Showing ${nodes.length} of ${total} nodes`;
  wrap.innerHTML = `<canvas id="graph-canvas"></canvas><div id="graph-info" class="graph-info" style="display:none"></div><div id="graph-tl" class="graph-tl" style="display:none"></div>`;
  if (!nodes.length) { wrap.innerHTML = `<div class="center">Nothing to show — turn a node type back on.</div>`; return; }
  mountForceGraph($("#graph-canvas"), { nodes, edges });
}

export async function render(ctx) {
  if (ctx.params[0] === "concept" || ctx.params[0] === "person") return browse.render(ctx);
  try { TYPES = await api.get("/graph/types"); } catch { TYPES = [{ id: "dump", label: "Dumps", color: "accent", builtin: true }, { id: "concept", label: "Concepts", color: "amber", builtin: true }, { id: "person", label: "People", color: "blue", builtin: true }]; }
  loadHidden();
  ctx.setTitle("Brain map", legendHtml());
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="wide">
    <div class="graph-bar">
      <p class="sub">Every dump, concept, and person you've mentioned. Drag nodes, scroll to zoom, click to explore.</p>
      <div class="graph-tools">
        <label class="graph-spacing" title="Organic: clusters form around shared topics. Galaxy: every dump gets a slot on a spiral, oldest in the middle, newest on the rim."><span>Layout</span>
          <select id="graph-layout" aria-label="Graph layout"><option value="organic" ${layout === "organic" ? "selected" : ""}>Organic</option><option value="galaxy" ${layout === "galaxy" ? "selected" : ""}>Galaxy (by time)</option></select></label>
        <label class="graph-spacing" title="How far apart the nodes sit"><span>Spacing</span>
          <input type="range" id="graph-spacing" min="0.5" max="3" step="0.05" value="${spacing}" aria-label="Node spacing">
          <output id="spacing-val">${spacing.toFixed(1)}×</output></label>
        <label class="sw graph-spacing" title="Off: titles show on the busiest nodes and as you zoom. On: a title only appears while you hover over its node."><span>Titles only on hover</span>
          <input type="checkbox" id="graph-hovertitles" ${hoverTitles ? "checked" : ""} aria-label="Show node titles only on hover"><i></i></label>
        <button class="btn ghost small" id="graph-fit" title="Zoom to show everything">⤢ Fit to screen</button>
      </div>
      <div class="graph-tools">
        <span class="graph-find"><input type="search" id="graph-find" placeholder="Find a node…" autocomplete="off" aria-label="Find a node"><div id="graph-find-list" class="graph-find-list" style="display:none"></div></span>
        <label class="graph-spacing" title="Hide concepts and people that appear in fewer dumps than this. 1 shows everything."><span>Min mentions</span>
          <input type="range" id="graph-min" min="1" max="6" step="1" value="${minMentions}" aria-label="Minimum mentions">
          <output id="min-val">${minMentions}</output></label>
        <label class="graph-spacing" title="Only show dumps from this period"><span>Show</span>
          <select id="graph-range" aria-label="Date range">${Object.entries(RANGES).map(([k, [l]]) => `<option value="${k}" ${k === range ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <button class="btn ghost small ${pathMode ? "on" : ""}" id="graph-path" title="Click two nodes to see how they connect through your dumps">🧭 Path</button>
        <button class="btn ghost small" id="graph-tl-btn" title="Watch your map grow, dump by dump">▶ Time-lapse</button>
        <span class="small muted" id="graph-count"></span>
      </div>
    </div>
    <div class="graph-wrap" id="graph-wrap"></div></div>`;
  $("#graph-spacing").oninput = (e) => {
    spacing = parseFloat(e.target.value);
    $("#spacing-val").textContent = spacing.toFixed(1) + "×";
    try { localStorage.setItem(SPACING_KEY, String(spacing)); } catch {}
    reheat?.();
  };
  $("#graph-hovertitles").onchange = (e) => { hoverTitles = e.target.checked; try { localStorage.setItem(HOVER_KEY, hoverTitles ? "1" : "0"); } catch {} redraw?.(); };
  $("#graph-layout").onchange = (e) => { layout = e.target.value; try { localStorage.setItem(LAYOUT_KEY, layout); } catch {} mount(); };
  $("#graph-fit").onclick = () => refit?.();
  $("#graph-min").oninput = (e) => {
    minMentions = parseInt(e.target.value, 10);
    $("#min-val").textContent = minMentions;
    try { localStorage.setItem(MIN_KEY, String(minMentions)); } catch {}
    mount();
  };
  $("#graph-range").onchange = (e) => { range = e.target.value; try { localStorage.setItem(RANGE_KEY, range); } catch {} mount(); };
  bindFind();
  $("#graph-path").onclick = (e) => { pathMode = !pathMode; e.currentTarget.classList.toggle("on", pathMode); pathReset?.(); if (pathMode) toast("Path: click one node, then another"); };
  $("#graph-tl-btn").onclick = () => timelapseHook?.();
  bindLegendEditors(ctx);
  $$(".topbar-slot .chip[data-type]").forEach((b) => b.onclick = () => toggleType(ctx, b));
  $("#graph-focus").onclick = () => { focus = !focus; $("#graph-focus").classList.toggle("on", focus); mount(); };
  await load();
  if (!lastData) return;
  if (!lastData.nodes.length) {
    $("#graph-wrap").innerHTML = `<div class="center">Nothing to map yet — make a few dumps first.</div>`;
    return;
  }
  mount();
}

// "Find a node": type a name, pick a match, and the map centres on it and dims everything else.
function bindFind() {
  const input = $("#graph-find"), list = $("#graph-find-list");
  const close = () => { list.style.display = "none"; list.innerHTML = ""; };
  const pick = (id) => { close(); input.value = ""; if (!jumpTo?.(id)) toast("That node is hidden by your filters - lower Min mentions or widen the date range."); };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !lastData) return close();
    const hits = lastData.nodes.filter((n) => (n.label || "").toLowerCase().includes(q))
      .sort((a, b) => (a.label.toLowerCase().startsWith(q) ? 0 : 1) - (b.label.toLowerCase().startsWith(q) ? 0 : 1) || a.label.length - b.label.length).slice(0, 8);
    list.style.display = "block";
    list.innerHTML = hits.length
      ? hits.map((n) => `<button type="button" data-id="${esc(n.id)}"><i class="legend-dot" style="background:${graphColors().colors[n.type] || "#999"}"></i>${esc(n.label.slice(0, 48))}<span class="small muted">${esc(TYPES.find((t) => t.id === n.type)?.label || n.type)}</span></button>`).join("")
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

const needItems = () => TYPES.some((t) => !t.builtin && !hidden.has(t.id));

async function load() {
  try {
    lastData = await api.get("/graph" + (needItems() ? "?items=1" : ""));
    lastData.hasItems = needItems();
  } catch (e) {
    $("#graph-wrap").innerHTML = `<div class="center">Couldn't load the graph: ${esc(e.message)}</div>`;
    lastData = null;
  }
}

function mountForceGraph(canvas, data) {
  const wrap = canvas.parentElement;
  const infoBox = $("#graph-info");
  const ctx = canvas.getContext("2d");
  const GC = graphColors();
  const H = () => wrap.clientHeight;
  const W = () => wrap.clientWidth;

  const degree = {};
  data.edges.forEach((e) => { degree[e.source] = (degree[e.source] || 0) + 1; degree[e.target] = (degree[e.target] || 0) + 1; });

  const nodes = data.nodes.map((n) => ({
    ...n, vx: 0, vy: 0, fx: null, fy: null, x: 0, y: 0, tx: null, ty: null, deg: degree[n.id] || 0,
    r: (GRAPH_R[n.type] || ITEM_R) + Math.min(9, (degree[n.id] || 0) * (n.type in GRAPH_R ? 1.1 : 0.3)),
  }));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId[e.source] && byId[e.target]);
  const N = nodes.length;
  nodes.forEach((n) => { n.w = 1 + 0.45 * Math.sqrt(n.deg); });   // mass: a dump with a dozen leaves claims more room
  const decay = Math.pow(0.001, 1 / (N > 400 ? 600 : N > 120 ? 450 : 320));   // bigger graphs cool slower so they finish untangling
  // When each node "appears" in the time-lapse: a dump when it was written, a concept/person/item when the
  // first dump that mentions it was written.
  const nbrIds = {};
  edges.forEach((e) => { (nbrIds[e.source] ||= []).push(e.target); (nbrIds[e.target] ||= []).push(e.source); });
  const stamp = (n) => (n.type === "dump" ? Date.parse(n.created_at || "") : NaN);
  nodes.forEach((n) => {
    let t = stamp(n);
    if (Number.isNaN(t)) for (const id of nbrIds[n.id] || []) { const m = byId[id], v = m && stamp(m); if (v && (Number.isNaN(t) || v < t)) t = v; }
    n.born = Number.isNaN(t) ? 0 : t;
  });
  const GOLDEN = 2.399963;
  const hash01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };

  // Starting positions. Never a random pile: a sunflower (phyllotaxis) spiral with the best-connected
  // nodes in the middle, so the simulation begins already spread out and just has to relax.
  // "Galaxy" goes further: every dump gets a fixed slot on a time-ordered sunflower (oldest at the
  // centre, newest on the rim), concepts/people sit at the centre of the dumps that mention them,
  // and items orbit their dump. The pattern you see is your own history.
  let restored = null;   // the remembered arrangement, when this map is a rebuild of one already seen
  function place() {
    placeFresh();
    const snap = savedLayouts.get(layout);
    if (snap) {
      let hit = 0;
      nodes.forEach((n) => { const q = snap.pos.get(n.id); if (q) { n.x = q.x; n.y = q.y; hit++; } });
      if (hit >= Math.max(1, nodes.length * 0.5)) {
        restored = snap;
        nodes.forEach((n) => {   // anything new starts beside a node that was already there
          if (snap.pos.has(n.id)) return;
          const near = (nbrIds[n.id] || []).map((id) => snap.pos.get(id)).filter(Boolean)[0];
          if (near) { n.x = near.x + (hash01(n.id) - 0.5) * 70; n.y = near.y + (hash01(n.id + "y") - 0.5) * 70; }
        });
      }
    }
    const pins = loadPins();
    nodes.forEach((n) => { const q = pins[n.id]; if (q) { n.fx = n.x = q.x; n.fy = n.y = q.y; } });
  }
  function placeFresh() {
    const cx = W() / 2, cy = H() / 2;
    if (layout === "galaxy") {
      const dumps = nodes.filter((n) => n.type === "dump").sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      // Slot spacing shrinks as the history grows, but never below 30px; with few dumps the spiral is
      // widened to a minimum radius so a young map isn't one tight clump.
      const step = Math.max(30, 230 / Math.sqrt(dumps.length + 2)) * spacing;
      dumps.forEach((n, i) => { const r = step * Math.sqrt(i + 2), th = i * GOLDEN; n.tx = cx + r * Math.cos(th); n.ty = cy + r * Math.sin(th); });
      const rim = step * Math.sqrt(dumps.length + 2);
      const nbrs = {};
      edges.forEach((e) => { (nbrs[e.source] ||= []).push(e.target); (nbrs[e.target] ||= []).push(e.source); });
      nodes.filter((n) => n.type !== "dump" && !n.dump).forEach((n) => {   // hubs: concepts, people
        const ds = (nbrs[n.id] || []).map((id) => byId[id]).filter((m) => m && m.type === "dump" && m.tx != null);
        if (ds.length) {   // centre of its dumps, nudged along a per-node angle so hubs sharing the same dumps don't stack
          const a = hash01(n.id) * Math.PI * 2, off = step * 0.7;
          n.tx = ds.reduce((s, m) => s + m.tx, 0) / ds.length + Math.cos(a) * off;
          n.ty = ds.reduce((s, m) => s + m.ty, 0) / ds.length + Math.sin(a) * off;
        }
        else { const a = hash01(n.id) * Math.PI * 2; n.tx = cx + Math.cos(a) * rim * 1.1; n.ty = cy + Math.sin(a) * rim * 1.1; }
      });
      nodes.filter((n) => n.dump).forEach((n) => {   // items orbit their dump
        const d = byId[n.dump], a = hash01(n.id) * Math.PI * 2;
        const bx = d && d.tx != null ? d.tx : cx, by = d && d.ty != null ? d.ty : cy;
        n.tx = bx + Math.cos(a) * 16; n.ty = by + Math.sin(a) * 16;
      });
      nodes.forEach((n) => { n.x = n.tx + (Math.random() - 0.5) * 4; n.y = n.ty + (Math.random() - 0.5) * 4; });
      return;
    }
    // Hubs (anything with 2+ links) go on the sunflower, best-connected in the middle; the
    // one-link leaves then start fanned out evenly around their hub instead of scattered, so the
    // map doesn't open as a tangle of long crossing lines that has to untangle itself.
    const nbr = {};
    edges.forEach((e) => { (nbr[e.source] ||= []).push(e.target); (nbr[e.target] ||= []).push(e.source); });
    const hubs = nodes.filter((n) => n.deg > 1 || !(nbr[n.id] || []).length).sort((a, b) => b.deg - a.deg);
    const c = 62 * spacing;
    hubs.forEach((n, i) => {
      const r = c * Math.sqrt(i + 0.5), th = i * GOLDEN;
      n.x = cx + r * Math.cos(th); n.y = cy + r * Math.sin(th);
    });
    const fanned = {};
    nodes.filter((n) => n.deg === 1 && (nbr[n.id] || []).length).forEach((n) => {
      const h = byId[nbr[n.id][0]];
      const k = fanned[h.id] = (fanned[h.id] || 0) + 1;
      const a = k * GOLDEN + hash01(h.id) * 6.28, r = (60 + 9 * Math.sqrt(k)) * spacing;
      n.x = (h.x ?? cx) + r * Math.cos(a); n.y = (h.y ?? cy) + r * Math.sin(a);
    });
  }

  let scale = 1, panX = 0, panY = 0, alpha = 1;
  let hoverId = null, selectedId = null;
  let needsDraw = true, userMoved = false;
  // Window-level listeners are removed when the graph view unmounts.
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  redraw = () => { needsDraw = true; };
  reheat = () => { alpha = 1; userMoved = false; needsDraw = true; };
  refit = () => { userMoved = false; fit(); };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = W() + "px";
    canvas.style.height = H() + "px";
    canvas.width = W() * dpr;
    canvas.height = H() * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }
  resize();
  window.addEventListener("resize", resize, sig);

  // Zoom/pan so every node is in view — the first thing a big graph needs.
  function fit() {
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach((n) => { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); });
    const pad = 50, bw = Math.max(x1 - x0, 60), bh = Math.max(y1 - y0, 60);
    scale = Math.min(1.6, Math.max(MIN_ZOOM, Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh)));
    panX = W() / 2 - scale * (x0 + x1) / 2;
    panY = H() / 2 - scale * (y0 + y1) / 2;
    needsDraw = true;
  }

  function neighborsOf(id, hops = 1) {
    let s = new Set([id]);
    for (let h = 0; h < hops; h++) {
      const next = new Set(s);
      edges.forEach((e) => { if (s.has(e.source)) next.add(e.target); if (s.has(e.target)) next.add(e.source); });
      s = next;
    }
    return s;
  }

  // One physics step. Repulsion falls off as 1/distance (not 1/d²) and reaches across the map, so
  // clusters push each other apart instead of collapsing into one blob; a spatial grid keeps it
  // fast. Links are weaker on hubs (a hub with 40 links isn't crushed into a point), nodes can't
  // overlap, and a gentle pull to the middle stops separate clusters drifting away.
  const galaxy = () => layout === "galaxy";
  function step() {
    const k = alpha;
    const reach = (galaxy() ? 60 : 380) * spacing, cell = reach;
    const grid = new Map();
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const key = Math.floor(n.x / cell) * 100003 + Math.floor(n.y / cell);
      (grid.get(key) || grid.set(key, []).get(key)).push(i);
    }
    const charge = 1500 * spacing * spacing * (N > 250 ? 1 + Math.log10(N / 250) : 1);
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get((gx + ox) * 100003 + (gy + oy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
          const d = Math.sqrt(d2);
          if (d > reach) continue;
          let f = galaxy() ? 0 : (charge / d) * k * 0.05 * Math.sqrt(a.w * b.w);
          const gap = a.r + b.r + 10;
          if (d < gap) f += (gap - d) * 0.35;           // collision: overlapping nodes shove apart
          if (!f) continue;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
    }
    const pull = galaxy() ? 0.25 : 1;
    edges.forEach((e) => {
      const a = byId[e.source], b = byId[e.target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const target = (e.type === "similar" ? 130 : e.type === "in" ? 34 : 80) * spacing * (1 + 0.1 * Math.sqrt(Math.max(a.deg, b.deg)));   // busy hubs get longer spokes so their neighbours fit around them
      const strength = 1 / Math.sqrt(Math.max(1, Math.min(a.deg, b.deg)));
      const f = (d - target) * 0.06 * strength * pull * k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    const gcx = W() / 2, gcy = H() / 2;
    nodes.forEach((n) => {
      if (galaxy() && n.tx != null) { const g = n.type === "dump" || n.dump ? 0.12 : 0.03; n.vx += (n.tx - n.x) * g; n.vy += (n.ty - n.y) * g; }   // hubs are held loosely so they fan out instead of stacking
      else { n.vx += (gcx - n.x) * 0.007 * k; n.vy += (gcy - n.y) * 0.007 * k; }
    });
    nodes.forEach((n) => {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; return; }
      n.vx *= 0.72; n.vy *= 0.72;
      n.x += Math.max(-40, Math.min(40, n.vx)); n.y += Math.max(-40, Math.min(40, n.vy));
    });
    alpha *= decay;
  }

  place();
  if (restored) {
    // Same map as last time: keep it exactly as it was, and only let physics run (briefly) if there are
    // new nodes that need to find their spot - re-heating a settled layout would shuffle everything.
    const fresh = nodes.some((n) => !restored.pos.has(n.id));
    alpha = fresh ? 0.15 : 0.012;
    if (fresh) for (let i = 0; i < 90 && alpha > 0.06; i++) step();
    if (restored.userMoved) { scale = restored.scale; panX = restored.panX; panY = restored.panY; userMoved = true; } else fit();
  } else {
    // Settle most of the way before the first frame so the map opens already laid out, not exploding.
    for (let i = 0; i < 420 && alpha > 0.07; i++) step();
    fit();
  }
  const myLayout = layout;
  const snapshot = () => savedLayouts.set(myLayout, { pos: new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }])), scale, panX, panY, userMoved });
  snapshotHook = snapshot;

  // Time-lapse: the finished layout stays put while nodes fade in as their first dump is reached.
  const tlBox = $("#graph-tl");
  const tl = { on: false, cur: 0, from: 0, to: 0, t0: 0, ms: 0, holdUntil: 0 };
  const myTl = timelapseHook = () => {
    const btn = $("#graph-tl-btn");
    if (tl.on) { tl.on = false; tlBox.style.display = "none"; if (btn) btn.textContent = "▶ Time-lapse"; needsDraw = true; return; }
    const times = nodes.filter((n) => n.type === "dump" && n.born).map((n) => n.born).sort((a, b) => a - b);
    if (times.length < 2) { toast("Needs at least two dumps to play back."); return; }
    Object.assign(tl, { on: true, from: times[0] - 864e5, to: times[times.length - 1], t0: performance.now(), ms: Math.min(14000, 3500 + times.length * 350), holdUntil: 0 });
    tl.cur = tl.from;
    selectedId = null; infoBox.style.display = "none";
    if (btn) btn.textContent = "■ Stop";
  };
  const alive = (n) => !tl.on || n.born <= tl.cur;

  // Path between two nodes: breadth-first over the visible links.
  let pathA = null, path = null;   // path = { ids: [..], nodes: Set, edges: Set("a|b") }
  const ek = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  pathReset = () => { pathA = null; path = null; if (infoBox) infoBox.style.display = "none"; needsDraw = true; };
  function findPath(from, to) {
    const prev = { [from]: null }, queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (cur === to) break;
      for (const nx of nbrIds[cur] || []) if (!(nx in prev)) { prev[nx] = cur; queue.push(nx); }
    }
    if (!(to in prev)) return null;
    const ids = [];
    for (let c = to; c != null; c = prev[c]) ids.unshift(c);
    return { ids, nodes: new Set(ids), edges: new Set(ids.slice(1).map((id, i) => ek(ids[i], id))) };
  }
  function pathClick(n) {
    if (!pathA || path) { pathA = n.id; path = null; selectedId = n.id; infoBox.style.display = "block"; infoBox.innerHTML = `<b>🧭 From ${esc(n.label)}</b><div class="small muted" style="margin-top:6px">Now click the node you want to reach.</div>`; needsDraw = true; return; }
    if (n.id === pathA) return;
    path = findPath(pathA, n.id);
    selectedId = null;
    infoBox.style.display = "block";
    infoBox.innerHTML = path
      ? `<b>🧭 ${path.ids.length - 1} step${path.ids.length === 2 ? "" : "s"}</b><div class="small" style="margin-top:8px">${path.ids.map((id, i) => `<div style="margin:3px 0 3px ${Math.min(i, 6) * 6}px">${i ? "↳ " : ""}<span style="color:${GC.colors[byId[id].type] || GC.dump}">●</span> ${esc(byId[id].label)}</div>`).join("")}</div><div class="small muted" style="margin-top:8px">Click any node to start another path.</div>`
      : `<b>🧭 No connection</b><div class="small muted" style="margin-top:6px">${esc(byId[pathA].label)} and ${esc(n.label)} aren't linked through any dump you're showing. Try lowering Min mentions or widening the date range.</div>`;
    needsDraw = true;
  }

  let ticks = 0;
  function tick() {
    // View switched away → stop the loop and drop window listeners.
    if (!canvas.isConnected) { if (snapshotHook === snapshot) { snapshot(); snapshotHook = null; } ac.abort(); return; }
    if (tl.on) {
      tl.cur = tl.from + (tl.to - tl.from) * Math.min(1, (performance.now() - tl.t0) / tl.ms);
      const shown = nodes.filter((n) => n.type === "dump" && n.born <= tl.cur).length;
      tlBox.style.display = "block";
      tlBox.textContent = `${new Date(tl.cur).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · ${shown} dump${shown === 1 ? "" : "s"}`;
      if (tl.cur >= tl.to) { tl.on = false; tl.holdUntil = performance.now() + 1800; $("#graph-tl-btn") && ($("#graph-tl-btn").textContent = "▶ Time-lapse"); }
      needsDraw = true;
    } else if (tl.holdUntil && performance.now() > tl.holdUntil) { tl.holdUntil = 0; tlBox.style.display = "none"; needsDraw = true; }
    if (alpha > 0.01) {
      step();
      if (!userMoved && ++ticks % 6 === 0) fit();   // keep everything framed until the user takes over
      needsDraw = true;
    }
    // Once the physics settle, redraw only on interaction — idle cost ~0.
    if (needsDraw) { draw(); needsDraw = false; }
    requestAnimationFrame(tick);
  }

  const labelled = new Set([...nodes].sort((a, b) => b.deg - a.deg).slice(0, Math.max(6, Math.min(30, Math.ceil(N * 0.06)))).map((n) => n.id));
  function draw() {
    ctx.clearRect(0, 0, W(), H());
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    const activeId = hoverId || selectedId;
    const hood = activeId ? neighborsOf(activeId, focus && selectedId ? 2 : 1) : null;
    const thin = Math.min(1, Math.max(0.35, 220 / (edges.length + 1)));   // many edges -> fainter lines, so a dense map stays readable
    edges.forEach((e) => {
      const a = byId[e.source], b = byId[e.target];
      if (!alive(a) || !alive(b)) return;
      const onPath = path && path.edges.has(ek(e.source, e.target));
      const dim = (hood && !(hood.has(e.source) && hood.has(e.target))) || (path && !onPath);
      if (dim && focus && selectedId) return;
      if (onPath) { ctx.globalAlpha = 1; ctx.strokeStyle = GC.text; ctx.lineWidth = 2.5 / Math.max(1, scale); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return; }
      const similar = e.type === "similar";
      ctx.strokeStyle = similar ? GC.dump : e.type === "in" ? (GC.colors[byId[e.source].type] || GC.edge) : GC.edge;
      ctx.globalAlpha = (similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25)) * (dim ? 1 : thin);
      ctx.lineWidth = (similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1) / Math.max(1, scale);
      ctx.setLineDash(similar ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const focusing = focus && selectedId;   // Focus mode: everything beyond two hops of the selection is hidden, not just dimmed
    nodes.forEach((n) => {
      if (!alive(n)) return;
      const dim = (hood && !hood.has(n.id)) || (path && !path.nodes.has(n.id));
      if (dim && focusing) return;
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = GC.colors[n.type] || "#999";
      if (n.id === hoverId) { ctx.shadowColor = GC.colors[n.type] || GC.dump; ctx.shadowBlur = 14; }
      ctx.fill();
      ctx.shadowBlur = 0;  // glow on the hovered node only — cheap for one arc
      if (n.id === selectedId || (path && path.nodes.has(n.id))) { ctx.lineWidth = 2; ctx.strokeStyle = GC.text; ctx.stroke(); }
      if (n.fx != null && !dim) {   // pinned: a dashed ring (double-click to release)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 / scale + 1, 0, Math.PI * 2);
        ctx.setLineDash([2 / scale, 2 / scale]); ctx.lineWidth = 1 / scale; ctx.strokeStyle = GC.edge; ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    });
    // Labels: the busiest hubs always, more as you zoom in, always for hover/selection neighbours.
    // Drawn in a second pass, most important first, and skipped if they would overlap one already placed.
    const px = 12 / scale;   // constant on-screen size whatever the zoom
    ctx.font = `${px}px sans-serif`;
    ctx.lineJoin = "round";
    const wanted = nodes.filter((n) => {
      if (!alive(n)) return false;
      const dim = (hood && !hood.has(n.id)) || (path && !path.nodes.has(n.id));
      if (dim && focusing) return false;
      if (path && path.nodes.has(n.id)) return true;
      return hoverTitles ? n.id === hoverId : !dim && (hood || labelled.has(n.id) || n.r * scale > 9 || (scale > 1.3 && n.deg >= 2) || scale > 2.6);
    }).sort((a, b) => (b.id === hoverId) - (a.id === hoverId) || (b.id === selectedId) - (a.id === selectedId) || b.deg - a.deg);
    const placed = [];
    wanted.forEach((n) => {
      const text = n.label.slice(0, 30), w = ctx.measureText(text).width, x = n.x + n.r + 4 / scale, y = n.y + 4 / scale;
      const box = { x0: x, x1: x + w, y0: y - px, y1: y + px * 0.3 };
      const force = n.id === hoverId || n.id === selectedId;
      if (!force && placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) return;
      placed.push(box);
      ctx.globalAlpha = (hood && !hood.has(n.id)) || (path && !path.nodes.has(n.id)) ? 0.2 : 1;
      ctx.lineWidth = 3 / scale; ctx.strokeStyle = GC.bg;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = GC.text;
      ctx.fillText(text, x, y);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function toWorld(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    return { x: (cx - rect.left - panX) / scale, y: (cy - rect.top - panY) / scale };
  }
  function nodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
    }
    return null;
  }
  function showInfo(n) {
    const hood = neighborsOf(n.id);
    const dumpsHere = nodes.filter((x) => x.type === "dump" && hood.has(x.id));
    infoBox.style.display = "block";
    const browsable = n.type === "concept" || n.type === "person";
    infoBox.innerHTML = `<b>${n.type === "concept" ? "💡" : n.type === "person" ? "🧑" : "•"} ${esc(n.label)}</b>
      <div class="small muted" style="margin:6px 0">${n.type === "dump" ? `<a href="#history/${n.id}">Open dump →</a>` : `${dumpsHere.length} dump${dumpsHere.length === 1 ? "" : "s"}`}${browsable ? ` · <a href="#graph/${n.type}/${encodeURIComponent(n.label)}">Open ${n.type} →</a>` : n.dump ? ` · <a href="#history/${n.dump}">Open dump →</a>` : ""}</div>
      ${dumpsHere.slice(0, 8).map((d) => `<div style="margin-top:3px"><a href="#history/${d.id}">${esc(d.label)}</a></div>`).join("")}`;
  }

  let dragging = null, panning = false, lastPan = null, moved = false, downAt = null, wasPinned = false;
  canvas.addEventListener("mousedown", (e) => {
    moved = false;
    downAt = { x: e.clientX, y: e.clientY };
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { dragging = n; wasPinned = n.fx != null; n.fx = n.x; n.fy = n.y; alpha = Math.max(alpha, 0.3); userMoved = true; }
    else { panning = true; userMoved = true; lastPan = { x: e.clientX, y: e.clientY }; }
  });
  window.addEventListener("mousemove", (e) => {
    moved = true;
    if (dragging) {
      const p = toWorld(e.clientX, e.clientY);
      dragging.fx = p.x; dragging.fy = p.y;
      alpha = Math.max(alpha, 0.3);
    } else if (panning) {
      panX += e.clientX - lastPan.x; panY += e.clientY - lastPan.y;
      lastPan = { x: e.clientX, y: e.clientY };
      needsDraw = true;
    } else {
      const rect = canvas.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      const n = inside ? nodeAt(toWorld(e.clientX, e.clientY).x, toWorld(e.clientX, e.clientY).y) : null;
      const next = n ? n.id : null;
      if (next !== hoverId) { hoverId = next; needsDraw = true; }
      if (inside) canvas.style.cursor = n ? "pointer" : "grab";
    }
  }, sig);
  window.addEventListener("mouseup", (e) => {
    if (dragging) {
      const dragged = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
      const pins = loadPins();
      if (dragged) { pins[dragging.id] = { x: dragging.fx, y: dragging.fy }; savePins(pins); }   // dropped = pinned
      else if (!wasPinned) { dragging.fx = null; dragging.fy = null; }                           // a plain click doesn't pin
    }
    dragging = null; panning = false;
  }, sig);
  canvas.addEventListener("dblclick", (e) => {
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { n.fx = null; n.fy = null; alpha = Math.max(alpha, 0.3); const pins = loadPins(); delete pins[n.id]; savePins(pins); needsDraw = true; }
  });
  canvas.addEventListener("click", (e) => {
    if (moved && dragging === null) { /* was a pan, not a click */ }
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (!n) { selectedId = null; pathA = null; path = null; infoBox.style.display = "none"; needsDraw = true; return; }
    if (pathMode) { pathClick(n); return; }
    if (!(focus || selectedId === n.id)) {   // first click on a dump/item opens it; in Focus mode (or a second click) it selects instead
      if (n.type === "dump") { go("history/" + n.id); return; }
      if (n.dump) { go("history/" + n.dump); return; }
    }
    selectedId = n.id;
    needsDraw = true;
    showInfo(n);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    userMoved = true;
    const next = Math.min(4, Math.max(MIN_ZOOM, scale * factor));
    panX = mx - (mx - panX) * (next / scale);
    panY = my - (my - panY) * (next / scale);
    scale = next;
    needsDraw = true;
  }, { passive: false });

  // Used by "Find a node": select it, zoom in on it and show its neighbourhood.
  const mine = (id) => {
    const n = byId[id];
    if (!n) return false;
    selectedId = id; userMoved = true;
    scale = Math.max(scale, 1.4);
    panX = W() / 2 - scale * n.x; panY = H() / 2 - scale * n.y;
    showInfo(n); needsDraw = true;
    return true;
  };
  jumpTo = mine;
  ac.signal.addEventListener("abort", () => { if (jumpTo === mine) jumpTo = null; });
  ac.signal.addEventListener("abort", () => { if (timelapseHook === myTl) timelapseHook = null; });   // a newer graph may already own it

  tick();
}
