// People x concepts grid: a heat-map. Rows are your most-mentioned people, columns your most-mentioned concepts, and a
// cell is as bright as the number of dumps where both come up. Related rows and columns are sorted next to each other
// so groups show up as bright blocks. Hover to follow a row and column; click a cell to list its dumps.
import { registerLayout } from "./layouts.js";
import { showHtml } from "./infobox.js";
import {
  buildModel, dumpListHtml, dumpTime, palette, rgba, clamp, cmp, fitText, screenPx, nodeInfo, esc,
} from "./layout-util.js";
import { onGraphReady } from "./hooks.js";

const MAX_ROWS = 25, MAX_COLS = 25;
const M = { rows: [], cols: [], cells: new Map(), max: 1, cs: 24, gx: 0, gy: 0, font: 11, extraRows: 0, extraCols: 0, hover: null, sel: null, totalDumps: 0 };
const key = (r, c) => r * 1000 + c;

let measure = null;
const mctx = () => (measure ||= document.createElement("canvas").getContext("2d"));

/** Reorder so related rows/columns sit together: alternate sorting each side by the average position of what it touches. */
function seriate(rows, cols, count) {
  let rOrder = rows.map((_, i) => i), cOrder = cols.map((_, i) => i);
  const bary = (idxs, other, otherPos, get) => {
    const score = new Map();
    for (const i of idxs) {
      let sw = 0, sp = 0;
      for (const j of other) { const w = get(i, j); if (w) { sw += w; sp += w * otherPos.get(j); } }
      score.set(i, sw ? sp / sw : null);
    }
    return score;
  };
  for (let round = 0; round < 6; round++) {
    const rPos = new Map(rOrder.map((r, p) => [r, p]));
    const cs = bary(cOrder, rOrder, rPos, (c, r) => count(r, c));
    cOrder = [...cOrder].sort((a, b) => (cs.get(a) ?? 1e9) - (cs.get(b) ?? 1e9) || cmp(cols[a].id, cols[b].id));
    const rs = bary(rOrder, cOrder, new Map(cOrder.map((c, p) => [c, p])), (r, c) => count(r, c));
    rOrder = [...rOrder].sort((a, b) => (rs.get(a) ?? 1e9) - (rs.get(b) ?? 1e9) || cmp(rows[a].id, rows[b].id));

  }
  return { rOrder, cOrder };
}

function prepare(data) {
  const m = buildModel(data.nodes, data.edges);
  const rank = (type) => m.hubs.filter((h) => h.type === type && (m.dumpsOf.get(h.id) || []).length)
    .map((h) => ({ n: h, c: m.dumpsOf.get(h.id).length }))
    .sort((a, b) => b.c - a.c || cmp(a.n.label.toLowerCase(), b.n.label.toLowerCase()) || cmp(a.n.id, b.n.id));
  const people = rank("person"), concepts = rank("concept");
  let rows = people.slice(0, MAX_ROWS).map((x) => ({ ...x.n, mentions: x.c }));
  const cols = concepts.slice(0, MAX_COLS).map((x) => ({ ...x.n, mentions: x.c }));
  const colIdx = new Map(cols.map((c, i) => [c.id, i]));
  // a person who never meets a shown concept would be an empty row; leave them out
  const rowIdx0 = new Map(rows.map((r, i) => [r.id, i]));
  const raw = new Map();
  for (const d of m.dumps) {
    const hs = m.hubsOf.get(d.id) || [];
    const rs = hs.map((h) => rowIdx0.get(h)).filter((v) => v != null), cs = hs.map((h) => colIdx.get(h)).filter((v) => v != null);
    for (const r of rs) for (const c of cs) { const k = key(r, c); (raw.get(k) || raw.set(k, []).get(k)).push(d); }
  }
  const used = new Set([...raw.keys()].map((k) => Math.floor(k / 1000)));
  rows = rows.filter((_, i) => used.has(i));
  const rowIdx = new Map(rows.map((r, i) => [r.id, i]));
  const cells0 = new Map();
  for (const [k, ds] of raw) {
    const r0 = Math.floor(k / 1000), c = k % 1000, id = people[r0].n.id;
    if (rowIdx.has(id)) cells0.set(key(rowIdx.get(id), c), ds);
  }
  const { rOrder, cOrder } = seriate(rows, cols, (r, c) => (cells0.get(key(r, c)) || []).length);
  const rowsO = rOrder.map((i) => rows[i]), colsO = cOrder.map((i) => cols[i]);
  const rPos = new Map(rOrder.map((r, p) => [r, p])), cPos = new Map(cOrder.map((c, p) => [c, p]));
  const cells = new Map();
  let max = 1;
  for (const [k, ds] of cells0) {
    const r = Math.floor(k / 1000), c = k % 1000;
    ds.sort((a, b) => cmp(b.created_at || "", a.created_at || ""));
    cells.set(key(rPos.get(r), cPos.get(c)), ds);
    max = Math.max(max, ds.length);
  }
  Object.assign(M, { rows: rowsO, cols: colsO, cells, max, extraRows: people.length - rowsO.length, extraCols: concepts.length - colsO.length, hover: null, sel: null, totalDumps: m.dumps.length });
  const edges = [];
  for (const [k, ds] of cells) edges.push({ source: rowsO[Math.floor(k / 1000)].id, target: colsO[k % 1000].id, type: "co", weight: ds.length });
  const nodes = [...rowsO, ...colsO].map((h) => { const { mentions, ...rest } = h; return { ...rest, meta: { ...(rest.meta || {}), mentions } }; });
  return { nodes, edges };
}

function place(api) {
  const { spacing } = api.env();
  const cs = Math.round(24 * clamp(spacing, 0.7, 1.8));
  const font = clamp(cs * 0.5, 9, 14);
  const ctx = mctx();
  ctx.font = `${font}px sans-serif`;
  const fit = (list) => list.forEach((h) => { h.text = fitText(ctx, h.label, 170); h.w = ctx.measureText(h.text).width; });
  fit(M.rows); fit(M.cols);
  Object.assign(M, { cs, font, gx: 0, gy: 0 });
  M.rows.forEach((h, i) => { const n = api.byId[h.id]; if (n) { n.r = 5; n.x = n.tx = M.gx - 8 - h.w - 10; n.y = n.ty = M.gy + i * cs + cs / 2; } });
  M.cols.forEach((h, j) => { const n = api.byId[h.id]; if (n) { n.r = 5; n.x = n.tx = M.gx + j * cs + cs / 2; n.y = n.ty = M.gy - 8 - h.w - 10; } });
}

const cellAt = (x, y) => {
  const c = Math.floor((x - M.gx) / M.cs), r = Math.floor((y - M.gy) / M.cs);
  return r >= 0 && c >= 0 && r < M.rows.length && c < M.cols.length ? { r, c } : null;
};

function cellHtml(r, c) {
  const ds = M.cells.get(key(r, c)) || [];
  return `<b>🧑 ${esc(M.rows[r].label)} × 💡 ${esc(M.cols[c].label)}</b>
    <div class="small muted" style="margin:6px 0">${ds.length} dump${ds.length === 1 ? "" : "s"} mention both</div>${dumpListHtml(ds, 12)}`;
}

nodeInfo("matrix", (n, api) => {
  const isRow = n.type === "person", list = isRow ? M.cols : M.rows;
  const idx = (isRow ? M.rows : M.cols).findIndex((h) => h.id === n.id);
  const mine = [];
  list.forEach((h, j) => { const c = M.cells.get(isRow ? key(idx, j) : key(j, idx)); if (c) mine.push({ h, c: c.length }); });
  mine.sort((a, b) => b.c - a.c || cmp(a.h.label, b.h.label));
  const mentions = (n.meta && n.meta.mentions) || 0;
  return `<b>${n.type === "concept" ? "💡" : "🧑"} ${esc(n.label)}</b>
    <div class="small muted" style="margin:6px 0">${mentions} dump${mentions === 1 ? "" : "s"} · <a href="#graph/${n.type}/${encodeURIComponent(n.label)}">Open ${n.type} →</a></div>
    <div class="small muted" style="margin-top:8px">${isRow ? "Topics" : "People"} it shows up with</div>
    ${mine.slice(0, 8).map((p) => `<div style="margin-top:3px">${esc(p.h.label)} <span class="small muted">· ${p.c}</span></div>`).join("") || `<div class="small muted">None in this grid.</div>`}`;
});

onGraphReady((api) => {
  const offs = [];
  offs.push(api.on("nodesChanged", () => {
    const c = api.canvas;
    if (!c || !api.layout || api.layout.id !== "matrix") return;
    c.addEventListener("mousemove", (e) => {
      const p = api.view.toWorld(e.clientX, e.clientY), cell = cellAt(p.x, p.y);
      if ((cell && M.hover && cell.r === M.hover.r && cell.c === M.hover.c) || (!cell && !M.hover)) return;
      M.hover = cell; api.requestDraw();
    });
    c.addEventListener("mouseleave", () => { if (M.hover) { M.hover = null; api.requestDraw(); } });
  }));
  offs.push(api.on("select", () => { if (api.layout && api.layout.id === "matrix" && M.sel) { M.sel = null; api.requestDraw(); } }));
  return () => offs.forEach((off) => off());
});

function drawUnder(ctx, api) {
  if (!M.rows.length || !M.cols.length) return;
  const P = palette(api), s = api.view.scale, { cs, gx, gy, font } = M;
  const R = M.rows.length, C = M.cols.length, gw = C * cs, gh = R * cs;
  const sel = api.byId[api.selectedId], hovNode = api.byId[api.hoverId];
  const focusNode = hovNode || sel;
  const hr = M.hover ? M.hover.r : focusNode && focusNode.type === "person" ? M.rows.findIndex((h) => h.id === focusNode.id) : -1;
  const hc = M.hover ? M.hover.c : focusNode && focusNode.type === "concept" ? M.cols.findIndex((h) => h.id === focusNode.id) : -1;
  ctx.save();
  // hover bands
  if (hr >= 0) { ctx.fillStyle = rgba(P.text, 0.07); ctx.fillRect(gx - 4, gy + hr * cs, gw + 8, cs); }
  if (hc >= 0) { ctx.fillStyle = rgba(P.text, 0.07); ctx.fillRect(gx + hc * cs, gy - 4, cs, gh + 8); }
  // cells
  const pad = Math.max(1, cs * 0.06), rad = cs * 0.18;
  // while a time-lapse is open a square only counts the dumps written so far (and is empty before the first one)
  const tl = api.timelapse, cur = tl && tl.active ? tl.state.cur : null;
  const live = new Map();
  for (const [k, ds] of M.cells) { const n = cur == null ? ds.length : ds.reduce((a, d) => a + (dumpTime(d) <= cur ? 1 : 0), 0); if (n) live.set(k, n); }
  ctx.fillStyle = rgba(P.text, 0.05);
  ctx.beginPath();
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (!live.has(key(r, c))) ctx.roundRect(gx + c * cs + pad, gy + r * cs + pad, cs - 2 * pad, cs - 2 * pad, rad);
  ctx.fill();
  const showNums = cs * s >= 15;
  ctx.font = `600 ${cs * 0.4}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const [k, count] of live) {
    const r = Math.floor(k / 1000), c = k % 1000, a = 0.2 + 0.8 * Math.pow(count / M.max, 0.65);
    ctx.fillStyle = rgba(P.accent, a);
    ctx.beginPath(); ctx.roundRect(gx + c * cs + pad, gy + r * cs + pad, cs - 2 * pad, cs - 2 * pad, rad); ctx.fill();
    if (showNums && (count > 1 || M.max <= 3)) { ctx.fillStyle = a > 0.6 ? "#fff" : P.text; ctx.fillText(String(count), gx + c * cs + cs / 2, gy + r * cs + cs / 2 + 0.5); }
  }
  // the clicked cell, and a Path's cells
  const outline = (r, c, col, w) => { ctx.lineWidth = w / s; ctx.strokeStyle = col; ctx.beginPath(); ctx.roundRect(gx + c * cs + 0.5, gy + r * cs + 0.5, cs - 1, cs - 1, rad); ctx.stroke(); };
  if (M.sel) outline(M.sel.r, M.sel.c, P.text, 2);
  if (M.hover && M.cells.has(key(M.hover.r, M.hover.c))) outline(M.hover.r, M.hover.c, rgba(P.text, 0.85), 1.5);
  const hl = api.highlight;
  if (hl) for (const e of api.edges) {
    if (!hl.edges.has(api.edgeKey(e.source, e.target))) continue;
    const r = M.rows.findIndex((h) => h.id === e.source || h.id === e.target), c = M.cols.findIndex((h) => h.id === e.source || h.id === e.target);
    if (r >= 0 && c >= 0) outline(r, c, P.text, 2.5);
  }

  // labels: row names on the left, column names standing up above the grid, a dot beside each (the dot is the node itself)
  ctx.font = `${font}px sans-serif`; ctx.textBaseline = "middle";
  const dotCol = (h) => api.colors.colors[h.type] || P.accent;
  const isOn = (h, hot, idx) => idx === hot || (hl && hl.nodes.has(h.id)) || (focusNode && focusNode.id === h.id);
  M.rows.forEach((h, i) => {
    const on = isOn(h, hr, i), y = gy + i * cs + cs / 2;
    ctx.fillStyle = dotCol(h); ctx.beginPath(); ctx.arc(gx - 8 - h.w - 10, y, on ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${on ? "600 " : ""}${font}px sans-serif`; ctx.textAlign = "right";
    ctx.fillStyle = on ? P.text : rgba(P.text, 0.78); ctx.fillText(h.text, gx - 8, y + 0.5);
  });
  M.cols.forEach((h, j) => {
    const on = isOn(h, hc, j), x = gx + j * cs + cs / 2;
    ctx.fillStyle = dotCol(h); ctx.beginPath(); ctx.arc(x, gy - 8 - h.w - 10, on ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, gy - 8); ctx.rotate(-Math.PI / 2);
    ctx.font = `${on ? "600 " : ""}${font}px sans-serif`; ctx.textAlign = "left";
    ctx.fillStyle = on ? P.text : rgba(P.text, 0.78); ctx.fillText(h.text, 0, 0.5);
    ctx.restore();
  });

  // tooltip for the hovered cell (same size at every zoom)
  if (M.hover) {
    const ds = M.cells.get(key(M.hover.r, M.hover.c)) || [];
    const text = `${M.rows[M.hover.r].label} × ${M.cols[M.hover.c].label}: ${ds.length ? ds.length + " dump" + (ds.length === 1 ? "" : "s") : "none together"}`;
    const px = screenPx(api, 12);
    ctx.font = `${px}px sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 16 / s, h = 24 / s;
    let x = gx + (M.hover.c + 1) * cs + 8 / s;
    if (x + w > gx + gw + 40 / s && M.hover.c > C / 2) x = gx + M.hover.c * cs - w - 8 / s;
    const y = gy + M.hover.r * cs + cs / 2 - h / 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6 / s); ctx.fillStyle = P.panel; ctx.fill();
    ctx.lineWidth = 1 / s; ctx.strokeStyle = rgba(P.text, 0.3); ctx.stroke();
    ctx.fillStyle = P.text; ctx.fillText(text, x + 8 / s, y + h / 2 + 0.5 / s);
  }
  ctx.restore();

}

registerLayout({
  id: "matrix", label: "People × concepts grid", icon: "🔲",
  desc: "A grid of your most-mentioned people (rows) against your most-mentioned concepts (columns); the brighter a square, the more dumps mention both. Related rows and columns are sorted together, so use it to spot who you associate with which topics.",
  fixed: true, locked: true,
  hint: "Brighter squares mean more dumps mention both. Hover to follow a row and column, and click a square to list its dumps.",
  hideNode: () => true,
  prepare, place, drawUnder,
  relayout(api) { place(api); api.fit(); api.requestDraw(); },
  hitTest: (x, y) => { const c = cellAt(x, y); return c && M.cells.has(key(c.r, c.c)) ? c : null; },
  onClick(hit, api) {
    M.sel = hit; api.select(null);
    M.sel = hit;   // select(null) clears it through the "select" event; set it again afterwards
    showHtml(cellHtml(hit.r, hit.c));
    api.requestDraw();
  },
  caption: (api) => {
    if (!M.rows.length || !M.cols.length) return null;
    const bits = [];
    if (M.extraRows > 0) bits.push(`${M.extraRows} more ${M.extraRows === 1 ? "person" : "people"}`);
    if (M.extraCols > 0) bits.push(`${M.extraCols} more concept${M.extraCols === 1 ? "" : "s"}`);
    return `Top ${M.rows.length} ${M.rows.length === 1 ? "person" : "people"} × top ${M.cols.length} concept${M.cols.length === 1 ? "" : "s"}${bits.length ? " · " + bits.join(" and ") + " not shown" : ""}`;
  },
  note: (api) => {
    const hasPeople = api.nodes.some((n) => n.type === "person"), hasConcepts = api.nodes.some((n) => n.type === "concept");
    if (!M.totalDumps && !api.nodes.length) return "<b>Nothing to grid yet.</b><br>This view compares the people you mention with the topics they come up in.";
    if (M.rows.length && M.cols.length) return null;
    if (!hasPeople) return "<b>No people to show.</b><br>This grid lines up the people in your dumps against your topics. Mention a few people, or switch People back on in the key above.";
    if (!hasConcepts) return "<b>No concepts to show.</b><br>This grid needs some concepts to compare people with. Switch Concepts back on in the key above.";
    return "<b>Nobody shares a dump with a topic yet.</b><br>As your dumps mention people alongside concepts, the grid fills in.";
  },
});
