// Brain map -> Obsidian canvas (JSON Canvas 1.0, https://jsoncanvas.org). Pure functions, no DOM: they take plain node
// and edge objects (the same ones the map holds) and return the { nodes, edges } object to serialise as a .canvas file.
import { dateStamp, noteWikilink } from "./export-common.js";

const SIZE = { dump: [270, 112] };
const CARD_H = 52;
const GRID = 300;

const mdEscape = (s) => String(s).replace(/\s+/g, " ").trim().replace(/([\\*_`[\]<>])/g, "\\$1");
const isoDay = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? "" : dateStamp(new Date(t)); };

/** Pixel size of a card: dumps are wider notes, everything else is a small label card that grows with its text. */
export function cardSize(n, text) {
  if (n.type === "dump") {
    const lines = Math.max(1, Math.ceil(mdEscape(n.label || "Untitled").length / 24));
    return [SIZE.dump[0], SIZE.dump[1] + (lines - 1) * 24 + (text.includes("[[") ? 26 : 0)];
  }
  return [Math.max(130, Math.min(300, 56 + String(text).length * 8)), CARD_H];
}

/** Text shown on a card (Markdown). */
export function cardText(n, { typeLabels = {}, wikilinks = false } = {}) {
  if (n.type === "dump") {
    const day = isoDay(n.created_at);
    const link = wikilinks ? noteWikilink(n.label, n.id) : null;
    return [`**${mdEscape(n.label || "Untitled")}**`, day, link].filter(Boolean).join("\n");
  }
  if (n.type === "concept" || n.type === "person") return `**${mdEscape(n.label)}**`;
  const kind = typeLabels[n.type];
  return kind ? `**${mdEscape(kind)}**\n${mdEscape(n.label)}` : mdEscape(n.label);
}

/** How much to stretch the map's coordinates so cards of this size mostly sit apart: based on the typical distance
 *  between nearest neighbours (a grid keeps it linear for thousands of nodes). */
export function spreadFactor(points) {
  if (points.length < 2) return 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  const cell = Math.max(2, Math.sqrt(area / points.length) * 1.5);
  const grid = new Map();
  const key = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
  for (const p of points) { const k = key(p.x, p.y); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  const nn = [];
  for (const p of points) {
    let best = Infinity;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let r = 1; r <= 6 && best === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        const list = grid.get(cx + dx + "," + (cy + dy));
        if (list) for (const q of list) if (q !== p) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
      }
    }
    if (best < Infinity) nn.push(best);
  }
  if (!nn.length) return 1;
  nn.sort((a, b) => a - b);
  const typical = Math.max(1, nn[Math.floor(nn.length * 0.25)]);
  return Math.min(40, Math.max(1.5, 230 / typical));
}

/** Nudge overlapping rectangles apart (grid-hashed, a handful of passes). rects: [{x, y, w, h}] positioned by top-left. */
export function relaxOverlaps(rects, passes = 40, gap = 16) {
  if (rects.length < 2) return rects;
  const cell = GRID;
  for (let pass = 0; pass < passes; pass++) {
    const grid = new Map();
    rects.forEach((r, i) => {
      for (let gx = Math.floor((r.x - gap) / cell); gx <= Math.floor((r.x + r.w + gap) / cell); gx++)
        for (let gy = Math.floor((r.y - gap) / cell); gy <= Math.floor((r.y + r.h + gap) / cell); gy++) {
          const k = gx + "," + gy;
          (grid.get(k) || grid.set(k, []).get(k)).push(i);
        }
    });
    let moved = 0;
    const seen = new Set();
    for (const list of grid.values()) {
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const i = list[a], j = list[b], pk = i < j ? i * 100003 + j : j * 100003 + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const A = rects[i], B = rects[j];
        const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + gap, oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + gap;
        if (ox <= 0 || oy <= 0) continue;
        const dx = A.x + A.w / 2 - (B.x + B.w / 2), dy = A.y + A.h / 2 - (B.y + B.h / 2);
        if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * ox / 2; A.x += s; B.x -= s; }
        else { const s = (dy >= 0 ? 1 : -1) * oy / 2; A.y += s; B.y -= s; }
        moved++;
      }
    }
    if (!moved) break;
  }
  return rects;
}

const side = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top"));

/** Build the JSON Canvas object.
 *  nodes: [{ id, label, type, created_at, x, y }]  edges: [{ source, target, type, score }]
 *  colors: { type: "#rrggbb" }   typeLabels: { type: "Task" }   wikilinks: add [[note]] links for dumps */
export function buildCanvas({ nodes, edges, colors = {}, typeLabels = {}, wikilinks = false }) {
  const ids = new Map();
  const cards = nodes.map((n, i) => {
    const text = cardText(n, { typeLabels, wikilinks });
    const [w, h] = cardSize(n, text);
    ids.set(n.id, i.toString(16).padStart(16, "0"));
    return { n, text, w, h };
  });
  const s = spreadFactor(nodes);
  const rects = cards.map((c) => ({ x: c.n.x * s - c.w / 2, y: c.n.y * s - c.h / 2, w: c.w, h: c.h }));
  relaxOverlaps(rects);
  const out = { nodes: [], edges: [] };
  cards.forEach((c, i) => {
    const node = { id: ids.get(c.n.id), type: "text", x: Math.round(rects[i].x), y: Math.round(rects[i].y), width: c.w, height: c.h, text: c.text };
    const col = colors[c.n.type];
    if (col) node.color = col;
    out.nodes.push(node);
  });
  const seen = new Set();
  for (const e of edges) {
    const a = ids.get(e.source), b = ids.get(e.target);
    if (!a || !b || a === b) continue;
    const k = e.type + "|" + (a < b ? a + b : b + a);
    if (seen.has(k)) continue;
    seen.add(k);
    const ai = parseInt(a, 16), bi = parseInt(b, 16);
    const ra = rects[ai], rb = rects[bi];
    const dx = rb.x + rb.w / 2 - (ra.x + ra.w / 2), dy = rb.y + rb.h / 2 - (ra.y + ra.h / 2);
    const edge = { id: (0x1000000 + out.edges.length).toString(16).padStart(16, "0"), fromNode: a, fromSide: side(dx, dy), toNode: b, toSide: side(-dx, -dy), toEnd: "none" };
    if (e.type === "similar") edge.label = "similar";
    out.edges.push(edge);
  }
  return out;
}
