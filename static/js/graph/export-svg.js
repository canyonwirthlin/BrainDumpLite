// Brain map -> SVG. The map is drawn with the Canvas 2D api, so the export re-runs the same drawing steps against a
// recording context that writes SVG elements instead of pixels. That way plugin layers (layout drawUnder, cluster hulls,
// overlay under/over painters, beforeDraw/afterDraw handlers) come out too, best effort, without knowing about SVG.
//
// buildSvg(api, { transparent }) -> string. Colours are literal values (theme variables are already resolved in
// api.colors), the view is the current pan/zoom, and only what is currently visible is written.
import { HULL_PAINTERS } from "./overlays.js";

const f = (n) => { const r = Math.round(n * 100) / 100; return Object.is(r, -0) || !Number.isFinite(r) ? 0 : r; };
const xmlText = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (s) => xmlText(s).replace(/"/g, "&quot;");
const TAU = Math.PI * 2;
const STYLE_KEYS = ["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "font", "textAlign", "textBaseline", "lineJoin", "lineCap"];

class Gradient {
  constructor(kind, args) { this.kind = kind; this.args = args; this.stops = []; }
  addColorStop(o, c) { this.stops.push([o, c]); }
}

/** A stand-in for CanvasRenderingContext2D that records drawing as SVG. Wrap with recordingContext() so unknown
 *  methods (shadows, filters, image drawing ...) quietly do nothing instead of throwing. */
class SvgRecorder {
  constructor(canvas, base, measure) {
    this.canvas = canvas;
    this.base = base;                       // [a,b,c,d,e,f]: the matrix the layer groups carry
    this.measure = measure;                 // a real 2d context, for measureText and colour parsing
    this.m = base.slice();
    this.fillStyle = "#000000"; this.strokeStyle = "#000000"; this.lineWidth = 1; this.globalAlpha = 1;
    this.font = "10px sans-serif"; this.textAlign = "start"; this.textBaseline = "alphabetic"; this.lineJoin = "miter"; this.lineCap = "butt";
    this.dash = [];
    this.stack = [];
    this.p = [];
    this.out = [];
    this.layers = [];
    this.defs = [];
    this.colorCache = new Map();
    this.lastStrokeText = null;
    const [a, b, c, d, e, g] = base, det = a * d - b * c || 1;
    this.inv = [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det];
  }

  // ── state ──
  save() { const s = { m: this.m.slice(), dash: this.dash.slice() }; for (const k of STYLE_KEYS) s[k] = this[k]; this.stack.push(s); }
  restore() { const s = this.stack.pop(); if (!s) return; this.m = s.m; this.dash = s.dash; for (const k of STYLE_KEYS) this[k] = s[k]; }
  setLineDash(d) { this.dash = Array.isArray(d) ? d.slice() : []; }
  getLineDash() { return this.dash.slice(); }
  translate(x, y) { const m = this.m; m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; }
  scale(x, y) { const m = this.m; m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y; }
  rotate(t) {
    const m = this.m, c = Math.cos(t), s = Math.sin(t), [a, b, cc, d] = m;
    m[0] = a * c + cc * s; m[1] = b * c + d * s; m[2] = -a * s + cc * c; m[3] = -b * s + d * c;
  }
  transform(a, b, c, d, e, g) {
    const m = this.m, [m0, m1, m2, m3, m4, m5] = m;
    m[0] = m0 * a + m2 * b; m[1] = m1 * a + m3 * b; m[2] = m0 * c + m2 * d; m[3] = m1 * c + m3 * d;
    m[4] = m0 * e + m2 * g + m4; m[5] = m1 * e + m3 * g + m5;
  }
  setTransform(a, b, c, d, e, g) { if (typeof a === "object" && a) { this.m = [a.a, a.b, a.c, a.d, a.e, a.f]; } else this.m = [a, b, c, d, e, g]; }
  resetTransform() { this.m = [1, 0, 0, 1, 0, 0]; }
  getTransform() { const m = this.m; return typeof DOMMatrix !== "undefined" ? new DOMMatrix(m) : { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; }
  createLinearGradient(...a) { return new Gradient("linear", a); }
  createRadialGradient(...a) { return new Gradient("radial", a); }
  measureText(t) { this.measure.font = this.font; return this.measure.measureText(t); }

  // ── layers ──
  layer(id, fn) {
    this.out = [];
    try { fn(); } catch (e) { console.error(`SVG export layer "${id}" failed:`, e); }
    if (this.out.length) this.layers.push(`<g id="${id}">${this.out.join("")}</g>`);
    this.out = [];
    this.m = this.base.slice(); this.stack = []; this.p = [];
  }

  // ── paths ──
  beginPath() { this.p = []; }
  moveTo(x, y) { this.p.push({ t: "M", x, y }); }
  lineTo(x, y) { this.p.push({ t: this.p.length ? "L" : "M", x, y }); }
  closePath() { this.p.push({ t: "Z" }); }
  quadraticCurveTo(cx, cy, x, y) { this.p.push({ t: "Q", cx, cy, x, y }); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this.p.push({ t: "C", c1x, c1y, c2x, c2y, x, y }); }
  rect(x, y, w, h) { this.p.push({ t: "R", x, y, w, h }); }
  roundRect(x, y, w, h, r = 0) { this.p.push({ t: "R", x, y, w, h, r: Math.max(0, Math.min(Array.isArray(r) ? +r[0] || 0 : +r || 0, Math.abs(w) / 2, Math.abs(h) / 2)) }); }
  arc(x, y, r, a0, a1, ccw = false) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
    if (!(rx >= 0 && ry >= 0)) return;
    const full = Math.abs(a1 - a0) >= TAU - 1e-6;
    this.p.push({ t: "E", x, y, rx, ry, rot, a0, a1, ccw, full });
  }
  fillRect(x, y, w, h) { const keep = this.p; this.p = [{ t: "R", x, y, w, h }]; this.fill(); this.p = keep; }
  strokeRect(x, y, w, h) { const keep = this.p; this.p = [{ t: "R", x, y, w, h }]; this.stroke(); this.p = keep; }
  clearRect() {}
  clip() {}
  drawImage() {}

  _d() {
    const out = [];
    let cur = false;
    for (const s of this.p) {
      switch (s.t) {
        case "M": out.push(`M${f(s.x)} ${f(s.y)}`); cur = true; break;
        case "L": out.push(`L${f(s.x)} ${f(s.y)}`); break;
        case "Q": out.push(`Q${f(s.cx)} ${f(s.cy)} ${f(s.x)} ${f(s.y)}`); break;
        case "C": out.push(`C${f(s.c1x)} ${f(s.c1y)} ${f(s.c2x)} ${f(s.c2y)} ${f(s.x)} ${f(s.y)}`); break;
        case "Z": out.push("Z"); break;
        case "R": {
          const { x, y, w, h, r } = s;
          if (r) out.push(`M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`);
          else out.push(`M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`);
          cur = false; break;
        }
        case "E": {
          const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
          const pt = (a) => [s.x + s.rx * Math.cos(a) * cs - s.ry * Math.sin(a) * sn, s.y + s.rx * Math.cos(a) * sn + s.ry * Math.sin(a) * cs];
          const deg = f((s.rot * 180) / Math.PI);
          if (s.full) {
            const [x0, y0] = pt(s.a0), [x1, y1] = pt(s.a0 + Math.PI);
            out.push(`${cur ? "L" : "M"}${f(x0)} ${f(y0)}A${f(s.rx)} ${f(s.ry)} ${deg} 1 ${s.ccw ? 0 : 1} ${f(x1)} ${f(y1)}A${f(s.rx)} ${f(s.ry)} ${deg} 1 ${s.ccw ? 0 : 1} ${f(x0)} ${f(y0)}`);
          } else {
            let d = s.ccw ? s.a0 - s.a1 : s.a1 - s.a0;
            d = ((d % TAU) + TAU) % TAU;
            const [x0, y0] = pt(s.a0), [x1, y1] = pt(s.a0 + (s.ccw ? -d : d));
            out.push(`${cur ? "L" : "M"}${f(x0)} ${f(y0)}A${f(s.rx)} ${f(s.ry)} ${deg} ${d > Math.PI ? 1 : 0} ${s.ccw ? 0 : 1} ${f(x1)} ${f(y1)}`);
          }
          cur = true; break;
        }
        default: break;
      }
    }
    return out.join("");
  }

  // ── painting ──
  _rgb(css) {
    let v = this.colorCache.get(css);
    if (v) return v;
    let hex = "#000000", alpha = 1;
    const str = String(css).trim();
    if (!str || str === "transparent" || str === "none") v = { hex: "none", alpha: 0 };
    else {
      this.measure.fillStyle = "#000000";
      this.measure.fillStyle = str;   // an unparsable colour leaves the previous value
      const out = String(this.measure.fillStyle);
      const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(out);
      if (m) {
        const h = (x) => Math.max(0, Math.min(255, Math.round(+x))).toString(16).padStart(2, "0");
        hex = `#${h(m[1])}${h(m[2])}${h(m[3])}`;
        alpha = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
      } else if (/^#[0-9a-f]{6}$/i.test(out)) hex = out.toLowerCase();
      v = { hex, alpha };
    }
    this.colorCache.set(css, v);
    return v;
  }
  _paint(style, attr) {
    if (style instanceof Gradient) {
      const id = `g${this.defs.length + 1}`;
      const stops = style.stops.map(([o, c]) => { const q = this._rgb(c); return `<stop offset="${f(o)}" stop-color="${q.hex === "none" ? "#000000" : q.hex}"${q.alpha < 1 ? ` stop-opacity="${f(q.alpha)}"` : ""}/>`; }).join("");
      const a = style.args;
      this.defs.push(style.kind === "linear"
        ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(a[2])}" y2="${f(a[3])}">${stops}</linearGradient>`
        : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(a[3])}" cy="${f(a[4])}" r="${f(a[5])}" fx="${f(a[0])}" fy="${f(a[1])}">${stops}</radialGradient>`);
      return ` ${attr}="url(#${id})"${this.globalAlpha < 1 ? ` ${attr}-opacity="${f(this.globalAlpha)}"` : ""}`;
    }
    if (typeof style !== "string") return ` ${attr}="none"`;
    const q = this._rgb(style);
    if (q.hex === "none") return ` ${attr}="none"`;
    const op = q.alpha * this.globalAlpha;
    return ` ${attr}="${q.hex}"${op < 0.999 ? ` ${attr}-opacity="${f(op)}"` : ""}`;
  }
  _strokeAttrs() {
    let s = this._paint(this.strokeStyle, "stroke") + ` stroke-width="${f(this.lineWidth)}"`;
    if (this.lineJoin !== "miter") s += ` stroke-linejoin="${this.lineJoin}"`;
    if (this.lineCap !== "butt") s += ` stroke-linecap="${this.lineCap}"`;
    if (this.dash.length) s += ` stroke-dasharray="${this.dash.map(f).join(" ")}"`;
    return s;
  }
  _xf() {   // element transform relative to the layer group (which already carries `base`)
    const m = this.m, i = this.inv;
    const rel = [i[0] * m[0] + i[2] * m[1], i[1] * m[0] + i[3] * m[1], i[0] * m[2] + i[2] * m[3], i[1] * m[2] + i[3] * m[3],
      i[0] * m[4] + i[2] * m[5] + i[4], i[1] * m[4] + i[3] * m[5] + i[5]];
    const id = Math.abs(rel[0] - 1) < 1e-6 && Math.abs(rel[1]) < 1e-6 && Math.abs(rel[2]) < 1e-6 && Math.abs(rel[3] - 1) < 1e-6 && Math.abs(rel[4]) < 1e-3 && Math.abs(rel[5]) < 1e-3;
    return id ? "" : ` transform="matrix(${rel.map((x) => Math.round(x * 1e5) / 1e5).join(" ")})"`;
  }
  _emit(el) { this.out.push(el); this.lastStrokeText = null; }
  _shape(fill, rule) {
    const p = this.p;
    if (!p.length) return;
    const only = p.length === 1 ? p[0] : null;
    const paint = fill ? this._paint(this.fillStyle, "fill") + (rule === "evenodd" ? ' fill-rule="evenodd"' : "") + ' stroke="none"' : ' fill="none"' + this._strokeAttrs();
    const xf = this._xf();
    if (only && only.t === "E" && only.full && only.rx === only.ry) this._emit(`<circle cx="${f(only.x)}" cy="${f(only.y)}" r="${f(only.rx)}"${paint}${xf}/>`);
    else if (only && only.t === "R" && !only.r) this._emit(`<rect x="${f(only.x)}" y="${f(only.y)}" width="${f(only.w)}" height="${f(only.h)}"${paint}${xf}/>`);
    else if (!fill && p.length === 2 && p[0].t === "M" && p[1].t === "L") this._emit(`<line x1="${f(p[0].x)}" y1="${f(p[0].y)}" x2="${f(p[1].x)}" y2="${f(p[1].y)}"${paint}${xf}/>`);
    else this._emit(`<path d="${this._d()}"${paint}${xf}/>`);
  }
  fill(rule) { this._shape(true, typeof rule === "string" ? rule : "nonzero"); }
  stroke() { this._shape(false); }

  // ── text ──
  _textAttrs() {
    const m = /(?:(italic|oblique)\s+)?(?:(bold|[1-9]00)\s+)?([\d.]+)px\s+(.*)$/.exec(this.font) || [];
    let a = ` font-size="${f(m[3] || 10)}" font-family="${xmlAttr((m[4] || "sans-serif").replace(/"/g, "'"))}"`;
    if (m[2]) a += ` font-weight="${m[2]}"`;
    if (m[1]) a += ` font-style="${m[1]}"`;
    if (this.textAlign === "center") a += ' text-anchor="middle"';
    else if (this.textAlign === "right" || this.textAlign === "end") a += ' text-anchor="end"';
    if (this.textBaseline === "middle") a += ' dominant-baseline="central"';
    else if (this.textBaseline === "top" || this.textBaseline === "hanging") a += ' dominant-baseline="hanging"';
    else if (this.textBaseline === "bottom") a += ' dominant-baseline="text-after-edge"';
    return a;
  }
  fillText(text, x, y) {
    const key = `${text}|${f(x)}|${f(y)}|${this.font}`;
    const t = this.lastStrokeText;
    const body = xmlText(text);
    if (t && t.key === key && this.out.length - 1 === t.idx) {   // strokeText then fillText of the same label: one element with a halo
      this.out[t.idx] = `<text x="${f(x)}" y="${f(y)}"${this._textAttrs()}${this._paint(this.fillStyle, "fill")}${t.stroke} paint-order="stroke"${this._xf()}>${body}</text>`;
      this.lastStrokeText = null;
      return;
    }
    this._emit(`<text x="${f(x)}" y="${f(y)}"${this._textAttrs()}${this._paint(this.fillStyle, "fill")}${this._xf()}>${body}</text>`);
  }
  strokeText(text, x, y) {
    const stroke = this._strokeAttrs();
    this._emit(`<text x="${f(x)}" y="${f(y)}"${this._textAttrs()} fill="none"${stroke}${this._xf()}>${xmlText(text)}</text>`);
    this.lastStrokeText = { key: `${text}|${f(x)}|${f(y)}|${this.font}`, idx: this.out.length - 1, stroke };
  }

  /** Give the element just written a <title> (shown as a tooltip by browsers, read by screen readers). */
  titleLast(text) {
    const i = this.out.length - 1, el = this.out[i];
    if (el && /^<(circle|rect|path)\b/.test(el) && el.endsWith("/>")) this.out[i] = el.slice(0, -2) + `><title>${xmlText(text)}</title></${/^<(\w+)/.exec(el)[1]}>`;
  }
}

/** Wrap a recorder so that anything it doesn't implement is a harmless no-op (plugins may call any Canvas 2D method). */
function recordingContext(rec) {
  return new Proxy(rec, {
    get(t, k) { if (k in t) return typeof t[k] === "function" ? t[k].bind(t) : t[k]; return typeof k === "string" ? () => undefined : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** Build the SVG text for the map exactly as it is on screen right now. */
export function buildSvg(api, { transparent = false, background = null } = {}) {
  const W = Math.round(api.width), H = Math.round(api.height);
  const sc = api.view.scale, px = api.view.panX, py = api.view.panY, C = api.colors;
  const measure = document.createElement("canvas").getContext("2d");
  const rec = new SvgRecorder(api.canvas, [sc, 0, 0, sc, px, py], measure);
  const ctx = recordingContext(rec);
  const focus = !!api.prefs.get("focus"), selectedId = api.selectedId, hl = api.highlight;
  const hood = selectedId ? api.neighborsOf(selectedId, focus ? 2 : 1) : null;
  const focusing = focus && selectedId;
  const dimmed = (n) => (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id));
  const show = (n) => api.isVisible(n) && !(focusing && dimmed(n));
  const nodes = api.nodes, edges = api.edges, byId = api.byId;
  const wx0 = -px / sc, wy0 = -py / sc, wx1 = (W - px) / sc, wy1 = (H - py) / sc, mg = 30 / sc;
  const inView = (n, pad = 0) => n.x + n.r + pad >= wx0 - mg && n.x - n.r - pad <= wx1 + mg && n.y + n.r + pad >= wy0 - mg && n.y - n.r - pad <= wy1 + mg;

  rec.layer("before-draw", () => api.emit("beforeDraw", { ctx }));
  rec.layer("layout", () => { const l = api.layout; if (l && l.drawUnder) l.drawUnder(ctx, api); });

  rec.layer("edges", () => {
    const thin = Math.min(1, Math.max(0.35, 220 / (edges.length + 1)));
    for (const e of edges) {
      const a = byId[e.source], b = byId[e.target];
      if (!a || !b || !show(a) || !show(b)) continue;
      if ((a.x < wx0 - mg && b.x < wx0 - mg) || (a.x > wx1 + mg && b.x > wx1 + mg) || (a.y < wy0 - mg && b.y < wy0 - mg) || (a.y > wy1 + mg && b.y > wy1 + mg)) continue;
      const onPath = hl && hl.edges.has(api.edgeKey(e.source, e.target));
      const dim = (hood && !(hood.has(e.source) && hood.has(e.target))) || (hl && !onPath);
      if (dim && focusing) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      if (onPath) { ctx.globalAlpha = 1; ctx.strokeStyle = C.text; ctx.lineWidth = 2.5 / Math.max(1, sc); ctx.setLineDash([]); ctx.stroke(); continue; }
      const similar = e.type === "similar";
      ctx.strokeStyle = similar ? C.dump : e.type === "in" ? (C.colors[a.type] || C.edge) : C.edge;
      ctx.globalAlpha = (similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25)) * (dim ? 1 : thin);
      ctx.lineWidth = (similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1) / Math.max(1, sc);
      ctx.setLineDash(similar ? [4, 3] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  });

  rec.layer("hulls", () => { for (const paint of HULL_PAINTERS) { try { paint(ctx, api); } catch (err) { console.warn("SVG export: hull painter failed", err); } ctx.globalAlpha = 1; } });
  rec.layer("overlays-under", () => api.overlays.under(ctx));

  const styled = api.overlays.hasStyles();
  rec.layer("nodes", () => {
    for (const n of nodes) {
      if (!show(n) || !inView(n, 6)) continue;
      const dim = dimmed(n);
      const st = styled ? api.overlays.nodeStyle(n) : null;
      ctx.globalAlpha = st && st.alpha != null ? (dim ? 0.2 : 1) * st.alpha : dim ? 0.2 : 1;
      const r = st && st.scale != null ? n.r * st.scale : n.r;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU);
      ctx.fillStyle = (st && st.color) || C.colors[n.type] || "#999999";
      ctx.fill();
      rec.titleLast(`${n.label} (${n.type})`);
      if (n.id === selectedId || (hl && hl.nodes.has(n.id))) { ctx.lineWidth = 2; ctx.strokeStyle = C.text; ctx.stroke(); }
      if (st && st.ring) {
        const ring = typeof st.ring === "string" ? { color: st.ring } : st.ring;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 2 / sc + 1, 0, TAU);
        ctx.lineWidth = (ring.width || 2) / sc; ctx.strokeStyle = ring.color; ctx.stroke();
      }
      if (n.fx != null && !dim) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 / sc + 1, 0, TAU);
        ctx.setLineDash([2 / sc, 2 / sc]); ctx.lineWidth = 1 / sc; ctx.strokeStyle = C.edge; ctx.stroke(); ctx.setLineDash([]);
      }
      if (st && st.badge) { ctx.font = `${10 / sc}px sans-serif`; ctx.fillStyle = C.text; ctx.fillText(String(st.badge), n.x + r * 0.7, n.y - r * 0.7); }
    }
    ctx.globalAlpha = 1;
  });
  rec.layer("overlays-over", () => api.overlays.over(ctx));

  rec.layer("labels", () => {
    // Same rule as the live map: busiest hubs always, more as you zoom, neighbours of the selection, never overlapping.
    const hoverTitles = api.prefs.get("hoverTitles");
    const N = nodes.length;
    const labelled = new Set([...nodes].sort((a, b) => b.deg - a.deg).slice(0, Math.max(6, Math.min(30, Math.ceil(N * 0.06)))).map((n) => n.id));
    const fs = 12 / sc;
    ctx.font = `${fs}px sans-serif`;
    ctx.lineJoin = "round";
    const wanted = nodes.filter((n) => {
      if (!show(n) || !inView(n)) return false;
      const dim = dimmed(n);
      if (hl && hl.nodes.has(n.id)) return true;
      return hoverTitles ? false : !dim && (hood || labelled.has(n.id) || n.r * sc > 9 || (sc > 1.3 && n.deg >= 2) || sc > 2.6);
    }).sort((a, b) => (b.id === selectedId) - (a.id === selectedId) || b.deg - a.deg);
    const placed = [];
    for (const n of wanted) {
      const text = n.label.slice(0, 30), w = ctx.measureText(text).width, x = n.x + n.r + 4 / sc, y = n.y + 4 / sc;
      const box = { x0: x, x1: x + w, y0: y - fs, y1: y + fs * 0.3 };
      if (n.id !== selectedId && placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) continue;
      placed.push(box);
      ctx.globalAlpha = dimmed(n) ? 0.2 : 1;
      ctx.lineWidth = 3 / sc; ctx.strokeStyle = C.bg;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = C.text;
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
  });
  rec.layer("after-draw", () => api.emit("afterDraw", { ctx }));

  const bgCss = background || C.bg;
  const bg = transparent ? "" : (() => { const q = rec._rgb(bgCss); return `<rect id="background" width="${W}" height="${H}" fill="${q.hex === "none" ? "#000000" : q.hex}"${q.alpha < 1 ? ` fill-opacity="${f(q.alpha)}"` : ""}/>`; })();
  const shown = nodes.filter((n) => show(n)).length;
  const base = rec.base.map((x) => Math.round(x * 1e5) / 1e5).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">\n`
    + `<title>Brain map</title>\n<desc>BrainDump Lite brain map, ${shown} nodes shown.</desc>\n`
    + (rec.defs.length ? `<defs>${rec.defs.join("")}</defs>\n` : "")
    + bg + "\n"
    + `<g id="map" transform="matrix(${base})">\n${rec.layers.join("\n")}\n</g>\n</svg>\n`;
}
