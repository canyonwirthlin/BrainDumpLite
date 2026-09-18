// Force-directed brain map (canvas, no library).
import { $, $$, esc, colorCss } from "../ui.js";
import { api } from "../api.js";
import { go } from "../router.js";
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
  return { colors, text: v("--text", "#e6e9f2"), edge: v("--dim", "#8b93a8"), dump: colors.dump || v("--accent", "#8b7cf6") };
}

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
  return TYPES.map((t) =>
    `<button class="chip ${hidden.has(t.id) ? "off" : "on"}" data-type="${t.id}" title="Show/hide ${t.label.toLowerCase()}"><i class="legend-dot" style="background:${gc.colors[t.id]}"></i>${esc(t.label)}</button>`).join("")
    + `<button class="chip ${focus ? "on" : ""}" id="graph-focus" title="Dim everything more than two hops from the selected node">◎ Focus</button>`;
}

function mount() {
  const wrap = $("#graph-wrap");
  if (!wrap || !lastData) return;
  const nodes = lastData.nodes.filter((n) => !hidden.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = lastData.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  wrap.innerHTML = `<canvas id="graph-canvas"></canvas><div id="graph-info" class="graph-info" style="display:none"></div>`;
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
    <p class="sub" style="margin-bottom:10px">Every dump, concept, and person you've mentioned. Drag nodes, scroll to zoom, click to explore.</p>
    <div class="graph-wrap" id="graph-wrap"></div></div>`;
  $$(".topbar-slot .chip[data-type]").forEach((b) => b.onclick = async () => {
    const t = b.dataset.type;
    hidden.has(t) ? hidden.delete(t) : hidden.add(t);
    saveHidden();
    b.classList.toggle("off", hidden.has(t)); b.classList.toggle("on", !hidden.has(t));
    if (needItems() && !lastData?.hasItems) await load();
    mount();
  });
  $("#graph-focus").onclick = () => { focus = !focus; $("#graph-focus").classList.toggle("on", focus); mount(); };
  await load();
  if (!lastData) return;
  if (!lastData.nodes.length) {
    $("#graph-wrap").innerHTML = `<div class="center">Nothing to map yet — make a few dumps first.</div>`;
    return;
  }
  mount();
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

  const nodes = data.nodes.map((n, i) => {
    const angle = (i / data.nodes.length) * Math.PI * 2;
    return {
      ...n, vx: 0, vy: 0, fx: null, fy: null,
      x: W() / 2 + Math.cos(angle) * 120 + (Math.random() - 0.5) * 30,
      y: H() / 2 + Math.sin(angle) * 120 + (Math.random() - 0.5) * 30,
      r: (GRAPH_R[n.type] || ITEM_R) + Math.min(9, (degree[n.id] || 0) * (n.type in GRAPH_R ? 1.1 : 0.3)),
    };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId[e.source] && byId[e.target]);

  let scale = 1, panX = 0, panY = 0, alpha = 1;
  let hoverId = null, selectedId = null;
  let needsDraw = true;
  // Window-level listeners are removed when the graph view unmounts.
  const ac = new AbortController();
  const sig = { signal: ac.signal };

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

  function neighborsOf(id, hops = 1) {
    let s = new Set([id]);
    for (let h = 0; h < hops; h++) {
      const next = new Set(s);
      edges.forEach((e) => { if (s.has(e.source)) next.add(e.target); if (s.has(e.target)) next.add(e.source); });
      s = next;
    }
    return s;
  }

  function tick() {
    // View switched away → stop the loop and drop window listeners.
    if (!canvas.isConnected) { ac.abort(); return; }
    if (alpha > 0.008) {
      const k = alpha;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 4);
          const f = (2200 / d2) * k;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      edges.forEach((e) => {
        const a = byId[e.source], b = byId[e.target];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        const target = e.type === "similar" ? 150 : 95;
        const f = (d - target) * 0.02 * k;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      });
      nodes.forEach((n) => {
        n.vx += (W() / 2 - n.x) * 0.0012 * k;
        n.vy += (H() / 2 - n.y) * 0.0012 * k;
      });
      nodes.forEach((n) => {
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; return; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      });
      alpha *= 0.985;
      needsDraw = true;
    }
    // Once the physics settle, redraw only on interaction — idle cost ~0.
    if (needsDraw) { draw(); needsDraw = false; }
    requestAnimationFrame(tick);
  }

  function draw() {
    ctx.clearRect(0, 0, W(), H());
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    const activeId = hoverId || selectedId;
    const hood = activeId ? neighborsOf(activeId, focus && selectedId ? 2 : 1) : null;
    edges.forEach((e) => {
      const a = byId[e.source], b = byId[e.target];
      const dim = hood && !(hood.has(e.source) && hood.has(e.target));
      const similar = e.type === "similar";
      ctx.strokeStyle = similar ? GC.dump : e.type === "in" ? (GC.colors[byId[e.source].type] || GC.edge) : GC.edge;
      ctx.globalAlpha = similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25);
      ctx.lineWidth = similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1;
      ctx.setLineDash(similar ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    nodes.forEach((n) => {
      const dim = hood && !hood.has(n.id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = GC.colors[n.type] || "#999";
      if (n.id === hoverId) { ctx.shadowColor = GC.colors[n.type] || GC.dump; ctx.shadowBlur = 14; }
      ctx.fill();
      ctx.shadowBlur = 0;  // glow on the hovered node only — cheap for one arc
      if (n.id === selectedId) { ctx.lineWidth = 2; ctx.strokeStyle = GC.text; ctx.stroke(); }
      if (!dim && (n.r > 8 || hood)) {
        ctx.fillStyle = GC.text;
        ctx.font = "11px sans-serif";
        ctx.fillText(n.label.slice(0, 30), n.x + n.r + 4, n.y + 3);
      }
      ctx.globalAlpha = 1;
    });
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
      <div class="small muted" style="margin:6px 0">${dumpsHere.length} dump${dumpsHere.length === 1 ? "" : "s"}${browsable ? ` · <a href="#graph/${n.type}/${encodeURIComponent(n.label)}">Open ${n.type} →</a>` : n.dump ? ` · <a href="#history/${n.dump}">Open dump →</a>` : ""}</div>
      ${dumpsHere.slice(0, 8).map((d) => `<div style="margin-top:3px"><a href="#history/${d.id}">${esc(d.label)}</a></div>`).join("")}`;
  }

  let dragging = null, panning = false, lastPan = null, moved = false;
  canvas.addEventListener("mousedown", (e) => {
    moved = false;
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { dragging = n; n.fx = n.x; n.fy = n.y; alpha = Math.max(alpha, 0.3); }
    else { panning = true; lastPan = { x: e.clientX, y: e.clientY }; }
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
  window.addEventListener("mouseup", () => { dragging = null; panning = false; }, sig);
  canvas.addEventListener("dblclick", (e) => {
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { n.fx = null; n.fy = null; alpha = Math.max(alpha, 0.3); }
  });
  canvas.addEventListener("click", (e) => {
    if (moved && dragging === null) { /* was a pan, not a click */ }
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (!n) { selectedId = null; infoBox.style.display = "none"; needsDraw = true; return; }
    if (n.type === "dump") { go("history/" + n.id); return; }
    if (n.dump) { go("history/" + n.dump); return; }
    selectedId = n.id;
    needsDraw = true;
    showInfo(n);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const next = Math.min(4, Math.max(0.25, scale * factor));
    panX = mx - (mx - panX) * (next / scale);
    panY = my - (my - panY) * (next / scale);
    scale = next;
    needsDraw = true;
  }, { passive: false });

  tick();
}
