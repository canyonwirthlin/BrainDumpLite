// Brain map export: one "Export" dropdown that saves the map as a PNG, an SVG, or an Obsidian canvas.
//
// The control mounts into <div id="graph-slot-export"> when the control panel provides it (and again after each
// "bdl-graph-panel-rendered" event, idempotently); with the older toolbar it is appended to the last .graph-tools row.
// Everything is built client-side from what the map is showing right now (after filters, Focus, time-lapse), so
// trashed and private dumps - which never reach the client - cannot appear. Also reachable from code as `api.exporter`:
//   exporter.png({ transparent }) -> Promise<Blob>      exporter.svg({ transparent }) -> string
//   exporter.canvas({ selection }) -> Promise<object>    (JSON Canvas data)
//   exporter.save(kind, opts)     -> Promise<bool>       kind: "png" | "svg" | "canvas" | "canvas-selection"
import { toast } from "../ui.js";
import { api as http } from "../api.js";
import { onGraphReady } from "./hooks.js";
import { buildSvg } from "./export-svg.js";
import { buildCanvas } from "./export-canvas.js";
import { dateStamp, slugify, visibleNodes, edgesAmong } from "./export-common.js";
import { saveBlob } from "./export-save.js";

const KEY_TRANSPARENT = "bdl-graph-export-transparent";
const readFlag = () => { try { return localStorage.getItem(KEY_TRANSPARENT) === "1"; } catch { return false; } };
const writeFlag = (v) => { try { localStorage.setItem(KEY_TRANSPARENT, v ? "1" : "0"); } catch {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const themeBg = (api) => {
  try { const c = getComputedStyle(api.wrap).backgroundColor; if (c && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c; } catch {}
  return api.colors.bg;
};

/** Any CSS colour -> "#rrggbb" (what JSON Canvas wants); null when it can't be read. */
function toHex(css) {
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000000";
  c.fillStyle = css;
  const v = String(c.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  return m ? "#" + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, "0")).join("") : null;
}

/** The current view as a PNG blob at `scale`x resolution: the live canvas is drawn once at that size and copied. */
export async function renderPng(api, { transparent = false, scale = 2 } = {}) {
  const canvas = api.canvas;
  if (!canvas) throw new Error("There is nothing on the map to export yet.");
  const ctx = canvas.getContext("2d");
  const W = api.width, H = api.height;
  const k = Math.max(1, Math.min(scale, 8192 / Math.max(W, H, 1)));
  const prev = { w: canvas.width, h: canvas.height };
  let out = null;
  const off = api.on("afterDraw", () => {
    if (out) return;
    out = document.createElement("canvas");
    out.width = canvas.width; out.height = canvas.height;
    const o = out.getContext("2d");
    if (!transparent) { o.fillStyle = themeBg(api); o.fillRect(0, 0, out.width, out.height); }
    o.drawImage(canvas, 0, 0);
  });
  try {
    canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    api.requestDraw();
    for (let i = 0; i < 120 && !out; i++) await sleep(16);
  } finally {
    off();
    canvas.width = prev.w; canvas.height = prev.h;
    ctx.setTransform(prev.w / W, 0, 0, prev.h / H, 0, 0);
    api.requestDraw();
  }
  if (!out) throw new Error("The map did not finish drawing. Try again in a moment.");
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("The browser could not make the image"))), "image/png"));
}

/** The nodes a canvas export contains: what is visible, plus the nodes a layout draws itself (lane headers, grid rows
 *  and columns), which the engine does not count as visible but which belong in the file. */
function canvasNodes(api) {
  const nodes = visibleNodes(api), L = api.layout;
  if (!L || !L.hideNode) return nodes;
  const have = new Set(nodes.map((n) => n.id));
  return nodes.concat(api.nodes.filter((n) => !have.has(n.id) && L.hideNode(n) && (!api.timelapse || api.timelapse.alive(n))));
}

/** JSON Canvas data for what is visible (or, with `selection`, the selected node and its neighbours). */
async function canvasData(api, { selection = false } = {}) {
  let nodes = canvasNodes(api);
  if (selection) {
    if (!api.selectedId) throw new Error("Select a node first.");
    const hood = api.neighborsOf(api.selectedId, 1);
    nodes = nodes.filter((n) => hood.has(n.id));
  }
  if (!nodes.length) throw new Error("There is nothing on the map to export yet.");
  const ids = new Set(nodes.map((n) => n.id));
  let wikilinks = false;
  try { wikilinks = !!(await http.get("/obsidian")).enabled; } catch { /* no mirror info: plain cards */ }
  const types = api.viewState?.types || [];
  const colors = {}, typeLabels = {};
  for (const t of types) { const hex = toHex(api.colors.colors[t.id] || ""); if (hex) colors[t.id] = hex; if (!t.builtin) typeLabels[t.id] = t.label; }
  return buildCanvas({ nodes, edges: edgesAmong(api, ids), colors, typeLabels, wikilinks });
}

function makeExporter(api) {
  const ex = {
    png: (opts) => renderPng(api, opts),
    svg: (opts) => buildSvg(api, { background: themeBg(api), ...opts }),
    canvas: (opts) => canvasData(api, opts),
    async save(kind, opts = {}) {
      try {
        if (!api.canvas || !api.nodes.length) { toast("Nothing on the map to export yet."); return false; }
        const day = dateStamp();
        if (kind === "png") {
          return saveBlob(await ex.png(opts), { name: `brain-map-${day}.png`, ext: "png", label: "image" });
        }
        if (kind === "svg") {
          return saveBlob(new Blob([ex.svg(opts)], { type: "image/svg+xml" }), { name: `brain-map-${day}.svg`, ext: "svg", label: "vector image" });
        }
        const selection = kind === "canvas-selection";
        const data = await ex.canvas({ selection });
        const sel = selection ? api.byId[api.selectedId] : null;
        const name = `brain-map-${selection && sel ? slugify(sel.label) + "-" : ""}${day}.canvas`;
        return saveBlob(new Blob([JSON.stringify(data, null, "\t")], { type: "application/json" }), { name, ext: "canvas", label: "Obsidian canvas" });
      } catch (e) {
        console.warn("graph export failed", e);
        toast(`Couldn't export: ${e.message || e}`, true);
        return false;
      }
    },
  };
  return ex;
}

// ── the dropdown ─────────────────────────────────────────────────────────────────────────────────
function menuHtml(api) {
  const vis = canvasNodes(api);
  const sel = api.selectedId ? api.byId[api.selectedId] : null;
  const hood = sel ? canvasNodes(api).filter((n) => api.neighborsOf(sel.id, 1).has(n.id)).length : 0;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `
    <button type="button" role="menuitem" class="gx-item" data-kind="png"><span class="gx-title">Image (PNG)</span><span class="gx-desc">The map as you see it, at twice the resolution. Good for slides and chats.</span></button>
    <label class="gx-opt"><input type="checkbox" id="gx-transparent" ${readFlag() ? "checked" : ""}> Transparent background</label>
    <button type="button" role="menuitem" class="gx-item" data-kind="svg"><span class="gx-title">Vector image (SVG)</span><span class="gx-desc">Stays sharp at any size. Opens in browsers, Inkscape and Illustrator.</span></button>
    <hr class="gx-sep">
    <button type="button" role="menuitem" class="gx-item" data-kind="canvas"><span class="gx-title">Obsidian canvas</span><span class="gx-desc">Everything shown on the map (${vis.length} card${vis.length === 1 ? "" : "s"}) as a .canvas file to open in Obsidian.</span></button>
    ${sel ? `<button type="button" role="menuitem" class="gx-item" data-kind="canvas-selection"><span class="gx-title">Obsidian canvas: selection and neighbours</span><span class="gx-desc">&ldquo;${esc(sel.label.slice(0, 40))}&rdquo; and the ${Math.max(0, hood - 1)} node${hood === 2 ? "" : "s"} next to it.</span></button>` : ""}`;
}

function mountExport(api) {
  const slot = document.getElementById("graph-slot-export");
  let host = slot;
  if (!host) {
    if (document.getElementById("graph-export")) return;
    const rows = document.querySelectorAll(".graph-bar .graph-tools");
    host = rows[rows.length - 1];
  }
  if (!host || host.querySelector("#graph-export")) return;
  const root = document.createElement("span");
  root.className = "graph-export";
  root.id = "graph-export";
  root.innerHTML = `<button type="button" class="btn ghost small" id="graph-export-btn" aria-haspopup="menu" aria-expanded="false" title="Save the map as an image, a vector file or an Obsidian canvas">⬇ Export ▾</button>
    <div class="graph-export-menu" role="menu" aria-label="Export the map" hidden></div>`;
  host.appendChild(root);
  const btn = root.querySelector("#graph-export-btn"), menu = root.querySelector(".graph-export-menu");

  const onDoc = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...menu.querySelectorAll(".gx-item")], i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  function close() {
    if (menu.hidden) return;
    menu.hidden = true; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function open() {
    menu.innerHTML = menuHtml(api);
    menu.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    menu.querySelector(".gx-item")?.focus();
  }
  btn.onclick = () => (menu.hidden ? open() : close());
  menu.addEventListener("change", (e) => { if (e.target.id === "gx-transparent") writeFlag(e.target.checked); });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".gx-item");
    if (!item) return;
    const kind = item.dataset.kind, transparent = !!menu.querySelector("#gx-transparent")?.checked;
    close();
    btn.disabled = true;
    api.exporter.save(kind, { transparent }).finally(() => { btn.disabled = false; });
  });
}

onGraphReady((api) => {
  api.exporter = makeExporter(api);
  const again = () => mountExport(api);
  window.addEventListener("bdl-graph-panel-rendered", again);
  const t = setTimeout(again, 0);   // the older toolbar has no event: its markup exists as soon as this tick ends
  return () => { clearTimeout(t); window.removeEventListener("bdl-graph-panel-rendered", again); };
});
