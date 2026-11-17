// Link mode ("blueprint" editing): connect two nodes by dragging a wire from one to the other, like a node editor.
// Register: the "Link" mode tool on the toolbar's Edit tab (toolbar.js). Active only while getMode() === "link".
//
//  * every visible node shows two small ports (left and right edge); press on a node and drag: a bezier wire follows the
//    pointer, the node under it lights up when the link is possible, invalid ones dim and the tip says why.
//  * release on a valid node = the link is made (blueprint-store.js -> app/routes_graph_links.py) and pushed on the undo
//    stack; release on empty space cancels. The map never pans or moves a node while a wire is being pulled.
//  * what a link IS depends on the pair: dump-dump = a manual link, dump-concept / dump-person = the name is added to the
//    note, concept/person pair = an accepted link kept in settings. Tasks and ideas cannot be linked.
//  * links made by hand are drawn as blueprint wires in every mode. In Link mode click one to select it, then Delete /
//    Backspace (or its x) removes it. Esc: cancel the wire, then deselect, then leave Link mode.
//
// Pure rules and geometry: blueprint-calc.js (tested under node). Data + backend calls: blueprint-store.js.
import { registerTool, getMode, setMode, onModeChange, notifyToolbar } from "./toolbar.js";
import { pushUndo } from "./undo.js";
import { onGraphReady } from "./hooks.js";
import { loadGraph } from "./data.js";
import { palette } from "./overlay-common.js";
import { isPathMode, togglePath } from "./path.js";
import { toast } from "../ui.js";
import * as calc from "./blueprint-calc.js";
import * as store from "./blueprint-store.js";

const ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="17" r="2.2"/><circle cx="19" cy="7" r="2.2"/><path d="M7.2 17C13 17 11 7 16.8 7"/></svg>`;

registerTool({
  tab: "edit", id: "link", order: 20, kind: "mode", label: "Link", icon: ICON,
  tip: "Drag from one note to another to connect them.",
  help: "Link: every node gets a small port on its edge. Drag from a node to another and let go to connect them: two notes become linked, "
    + "a note gets the concept or person you dropped it on, and two concepts or people are linked to each other. Your links show as bright wires. "
    + "Click a wire, then press Delete (or click its x) to remove it. Ctrl+Z undoes any link you made or removed. Tasks and ideas can't be linked. "
    + "Press Esc to leave Link mode.",
  isActive: () => getMode() === "link",
});

const linkOn = () => getMode() === "link";
const TIPS = {
  "dump-dump": (l) => `Link between “${l.a_label}” and “${l.b_label}”`,
  "dump-concept": (l) => `“${l.a_label}” has the concept “${l.b_label}”`,
  "dump-person": (l) => `“${l.a_label}” mentions “${l.b_label}”`,
  pair: (l) => `“${l.a_label}” and “${l.b_label}” are linked`,
};
/** An undo/redo step that hit a server refusal (the note was trashed, the concept is gone ...) can never succeed: tell the undo stack to drop it. */
const permanent = async (fn) => { try { return await fn(); } catch (e) { if (e && !(e instanceof TypeError)) e.permanent = true; throw e; } };
const wireKey = (l) => l.kind + ":" + calc.pairKey(l.a, l.b);

let ctx = null;   // { api, state, ... } of the current visit of the map

onGraphReady((api, state) => {
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const attached = new WeakSet();
  const tip = document.createElement("div");
  tip.className = "bdl-bp-tip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  let wire = null;            // the wire being pulled: { from, pt, moved, target, valid: Map(id -> verdict), x0, y0 }
  let selKey = null;          // the selected wire
  let hoverKey = null;        // the wire under the pointer
  let overX = false;          // the pointer is on the x of that wire
  let consumed = false;       // the last mousedown was ours, so the click that follows must not reach the engine
  let busy = false;
  let sets = { sim: new Set(), mention: new Set() };
  let hintTimer = 0;
  const me = ctx = { api, state, reload };

  // ── helpers ────────────────────────────────────────────────────────────────────────────────
  const visible = (n) => api.isVisible(n);
  const nodeById = (id) => api.byId[id];

  /** The user's links that can be drawn right now (both ends on the map and shown): [{ link, a, b, curve, key }]. */
  function wires() {
    const out = [];
    for (const l of store.getLinks()) {
      const a = nodeById(l.a), b = nodeById(l.b);
      if (a && b && visible(a) && visible(b)) out.push({ link: l, a, b, curve: calc.wireCurve(a, b), key: wireKey(l) });
    }
    return out;
  }
  const wireByKey = (k) => (k ? wires().find((w) => w.key === k) || null : null);

  function existing(a, b) {
    const k = calc.pairKey(a.id, b.id), ka = calc.kindOf(a), kb = calc.kindOf(b);
    if (ka === "dump" && kb === "dump") return sets.sim.has(k) || store.hasLink("dump-dump", a.id, b.id);
    if (ka === "dump" || kb === "dump") return sets.mention.has(k) || store.hasLink("dump-" + (ka === "dump" ? kb : ka), a.id, b.id);
    return store.hasLink("pair", a.id, b.id);
  }
  function indexEdges() {
    sets = { sim: new Set(), mention: new Set() };
    for (const e of api.edges) {
      if (e.type === "similar" || e.type === "manual") sets.sim.add(calc.pairKey(e.source, e.target));
      else if (e.type === "mention") sets.mention.add(calc.pairKey(e.source, e.target));
    }
  }

  function showTip(text, e, no) {
    tip.textContent = text;
    tip.classList.toggle("no", !!no);
    const w = tip.offsetWidth, vw = document.documentElement.clientWidth;
    tip.style.left = Math.max(8, Math.min(e.clientX + 16, vw - w - 8)) + "px";
    tip.style.top = Math.max(8, e.clientY - 36) + "px";
    tip.classList.add("show");
  }
  const hideTip = () => tip.classList.remove("show");
  const setCursor = (c) => { const cv = api.canvas; if (cv && cv.style.cursor !== c) cv.style.cursor = c; };
  const redraw = () => api.requestDraw();

  function cancelWire() { wire = null; hideTip(); redraw(); }

  // ── the hint chip at the top of the map ────────────────────────────────────────────────────
  function paintHint() {
    const wrap = api.wrap;
    if (!wrap) return;
    wrap.querySelectorAll(".bdl-bp-hint").forEach((n) => n.remove());
    clearTimeout(hintTimer);
    wrap.classList.toggle("bdl-bp-on", linkOn());
    if (!linkOn() || !api.nodes.length) return;
    const noDumps = !api.nodes.some((n) => n.type === "dump" && visible(n));
    const el = document.createElement("div");
    el.className = "bdl-bp-hint";
    el.setAttribute("role", "status");
    el.innerHTML = `<div><b>Link mode</b> · drag from one node to another to connect them · <kbd>Esc</kbd> leaves</div>`
      + (noDumps ? `<div class="bp-warn">This layout doesn't show notes. Switch to a layout that shows both notes and concepts to link a note to something. Concepts and people can still be linked to each other.</div>` : "");
    wrap.appendChild(el);
    if (!noDumps) hintTimer = setTimeout(() => el.classList.add("quiet"), 6000);
  }

  // ── making and removing links ──────────────────────────────────────────────────────────────
  /** Re-read the map from the server and rebuild it in place: the arrangement, zoom and selection are kept. */
  async function reload() {
    const c = ctx;
    if (!c || c !== me) return;
    const sel = api.selectedId;
    try { state.data = await loadGraph(!!(state.data && state.data.hasItems)); }
    catch { toast("Saved, but the map couldn't refresh. Open the Brain map again to see it.", true); return; }
    state.mount();
    if (sel && api.byId[sel]) api.select(sel);
  }

  async function commit(from, to, verdict) {
    if (busy) return;
    busy = true;
    const a = from.id, b = to.id, label = calc.linkLabel(from, to);
    try {
      let r;
      try { r = await store.createLink(a, b); }
      catch (err) { toast(err.message || "Couldn't make that link.", true); return; }
      if (!r.created) { toast(`${calc.linkLabel(from, to, " and ")} are already linked.`); return; }
      const names = r.names;
      pushUndo({
        label: `Link ${label}`,
        undo: () => permanent(async () => { await store.removeLink(a, b); selKey = null; await reload(); }),
        redo: () => permanent(async () => { await store.createLink(a, b, names); await reload(); }),
      });
      toast(`Linked ${label}. Ctrl+Z undoes it.`);
      selKey = wireKey({ kind: r.kind, a, b });
      await reload();
    } finally { busy = false; }
  }

  async function removeWire(w) {
    if (busy || !w) return;
    busy = true;
    const { a, b } = w.link, label = calc.linkLabel(w.a, w.b);
    try {
      let r;
      try { r = await store.removeLink(a, b); }
      catch (err) { toast(err.message || "Couldn't remove that link.", true); return; }
      selKey = null; hoverKey = null; overX = false; hideTip();
      if (r.removed) {
        const names = r.names;
        pushUndo({
          label: `Unlink ${label}`,
          undo: () => permanent(async () => { await store.createLink(a, b, names); await reload(); }),
          redo: () => permanent(async () => { await store.removeLink(a, b); selKey = null; await reload(); }),
        });
        toast(`Removed the link ${label}. Ctrl+Z brings it back.`);
      } else toast("That link was already gone.");
      await reload();
    } finally { busy = false; }
  }

  // ── pointer: a press on a node pulls a wire; a press on a wire selects it ───────────────────
  const world = (e) => api.view.toWorld(e.clientX, e.clientY);
  /** The pointer is on the x in the middle of wire w. A very short wire gets a smaller x so its ends stay clickable. */
  const onX = (w, p) => {
    if (!w) return false;
    const m = calc.bezierPoint(w.curve, 0.5), sc = api.view.scale;
    const chord = Math.hypot(w.curve.p3.x - w.curve.p0.x, w.curve.p3.y - w.curve.p0.y) * sc;
    return Math.hypot(m.x - p.x, m.y - p.y) * sc <= Math.min(9, Math.max(4, chord * 0.2));
  };

  function onDown(e) {
    consumed = false;
    if (!linkOn() || e.button !== 0 || e.target !== api.canvas || busy) return;
    const p = world(e), sc = api.view.scale;
    const hot = wireByKey(selKey) || wireByKey(hoverKey);
    if (hot && onX(hot, p)) { consumed = true; e.preventDefault(); e.stopImmediatePropagation(); removeWire(hot); return; }
    const n = calc.nodeAt(api.nodes, p.x, p.y, sc, visible);
    if (n) {
      consumed = true; e.preventDefault(); e.stopImmediatePropagation();
      const valid = new Map();
      for (const m of api.nodes) if (m !== n && visible(m)) valid.set(m.id, calc.validateLink(n, m, existing));
      wire = { from: n, pt: p, moved: false, target: null, valid, x0: e.clientX, y0: e.clientY };
      hideTip(); redraw();
      return;
    }
    const hit = calc.wireAt(wires(), p.x, p.y, sc);
    if (hit) {
      consumed = true; e.preventDefault(); e.stopImmediatePropagation();
      selKey = selKey === hit.wire.key ? null : hit.wire.key;
      redraw();
      return;
    }
    if (selKey) { selKey = null; redraw(); }   // a press on empty space: deselect, and let the map pan as usual
  }
  function onClick(e) {
    if (consumed && e.target === api.canvas) { consumed = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }

  function onMove(e) {
    if (!linkOn() || busy) return;
    const p = world(e), sc = api.view.scale;
    if (wire) {
      wire.pt = p;
      if (!wire.moved && Math.hypot(e.clientX - wire.x0, e.clientY - wire.y0) > 4) wire.moved = true;
      if (!wire.moved) return;
      const t = calc.nodeAt(api.nodes, p.x, p.y, sc, (n) => n !== wire.from && visible(n));
      wire.target = t;
      const v = t && wire.valid.get(t.id);
      if (t && v) showTip(v.reason, e, !v.ok);
      else hideTip();
      setCursor(v && v.ok ? "copy" : t ? "not-allowed" : "crosshair");
      redraw();
      return;
    }
    const rect = api.canvas && api.canvas.getBoundingClientRect();
    if (!rect || e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) { if (hoverKey) { hoverKey = null; overX = false; redraw(); } hideTip(); return; }
    const n = calc.nodeAt(api.nodes, p.x, p.y, sc, visible);
    let hit = null;
    if (!n) {
      const keep = wireByKey(hoverKey) || wireByKey(selKey);
      hit = keep && onX(keep, p) ? { wire: keep } : calc.wireAt(wires(), p.x, p.y, sc);
    }
    const key = hit ? hit.wire.key : null, x = !!hit && onX(hit.wire, p);
    if (key !== hoverKey || x !== overX) { hoverKey = key; overX = x; redraw(); }
    if (hit) { showTip(x ? "Remove this link" : `${TIPS[hit.wire.link.kind](hit.wire.link)}. Click to select it, then press Delete.`, e, false); setCursor("pointer"); }
    else { hideTip(); setCursor(n ? "crosshair" : api.hoverId ? "pointer" : "grab"); }
  }

  function onUp(e) {
    if (!wire) return;
    const w = wire; wire = null; hideTip(); redraw();
    if (!linkOn()) return;
    const sc = api.view.scale, p = world(e);
    if (!w.moved) { api.select(w.from.id); return; }   // a plain click on a node just selects it (it never opens the note while linking)
    const t = calc.nodeAt(api.nodes, p.x, p.y, sc, (n) => n !== w.from && visible(n));
    if (!t) return;                                      // dropped on empty space: cancelled
    const v = w.valid.get(t.id);
    if (!v || !v.ok) { toast(v ? v.reason : "Those two can't be linked.", true); return; }
    if (v.duplicate) { toast(`${calc.linkLabel(w.from, t, " and ")} are already linked.`); return; }
    commit(w.from, t, v);
  }

  function onKey(e) {
    if (!linkOn()) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector(".modal-bg") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (api.timelapse && api.timelapse.active) return;   // the time-lapse owns Esc while it is open
      if (wire) cancelWire();
      else if (selKey) { selKey = null; redraw(); }
      else setMode("select");
      e.preventDefault(); e.stopPropagation();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selKey) {
      const w = wireByKey(selKey);
      e.preventDefault(); e.stopPropagation();
      if (w) removeWire(w);
    }
  }

  let moveAc = null;   // the mousemove listener is re-added after every rebuild so it runs AFTER the engine's (and so wins the cursor)
  window.addEventListener("mouseup", onUp, sig);
  window.addEventListener("keydown", onKey, { capture: true, ...sig });
  window.addEventListener("blur", () => { if (wire) cancelWire(); }, sig);

  // ── drawing: wires under the nodes (always), ports + the live wire over them (Link mode) ─────────
  const px = () => 1 / Math.max(0.6, api.view.scale);
  const bez = (c, k) => { c.beginPath(); c.moveTo(k.p0.x, k.p0.y); c.bezierCurveTo(k.p1.x, k.p1.y, k.p2.x, k.p2.y, k.p3.x, k.p3.y); };
  const disc = (c, x, y, r) => { c.moveTo(x + r, y); c.arc(x, y, r, 0, Math.PI * 2); };

  function drawWires({ ctx: c }) {
    const ws = wires();
    if (!ws.length) return;
    const p = palette(api), u = px();
    c.save();
    c.lineCap = "round"; c.setLineDash([]);
    for (const w of ws) {
      const sel = w.key === selKey, hov = linkOn() && w.key === hoverKey;
      c.strokeStyle = p.accent2;
      c.globalAlpha = sel ? 0.38 : hov ? 0.3 : 0.17; c.lineWidth = (sel ? 10 : 7) * u; bez(c, w.curve); c.stroke();
      c.globalAlpha = 0.95; c.lineWidth = (sel || hov ? 3.4 : 2.4) * u; bez(c, w.curve); c.stroke();
      if (sel) { c.strokeStyle = p.text; c.globalAlpha = 0.55; c.lineWidth = 1 * u; bez(c, w.curve); c.stroke(); }
      for (const q of [w.curve.p0, w.curve.p3]) {   // the plugs where the wire meets the nodes
        c.globalAlpha = 1; c.fillStyle = p.bg; c.strokeStyle = p.accent2; c.lineWidth = 1.6 * u;
        c.beginPath(); c.arc(q.x, q.y, 3 * u, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }
    c.restore();
  }

  function viewRect(m) {
    const v = api.view, s = v.scale;
    return { x0: -v.panX / s - m, y0: -v.panY / s - m, x1: (api.width - v.panX) / s + m, y1: (api.height - v.panY) / s + m };
  }

  function drawLink({ ctx: c }) {
    if (!linkOn()) return;
    const p = palette(api), u = px(), sc = api.view.scale, v = viewRect(30 / sc);
    const hoverNode = wire ? wire.target : api.byId[api.hoverId];
    const many = api.nodes.length > 1200 && sc < 0.8;
    c.save();
    c.lineCap = "round"; c.setLineDash([]);
    // while a wire is pulled, nodes it cannot connect to fade back
    if (wire && wire.moved) {
      c.fillStyle = p.bg; c.globalAlpha = 0.6; c.beginPath();
      for (const n of api.nodes) {
        if (n === wire.from || n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1 || !visible(n)) continue;
        const vd = wire.valid.get(n.id);
        if (vd && !vd.ok) disc(c, n.x, n.y, n.r + 1.5 * u);
      }
      c.fill();
    }
    // ports: two small dots per node, on the left and right edge; bigger for the node under the pointer
    c.globalAlpha = 0.85; c.fillStyle = p.bg; c.strokeStyle = p.accent2; c.lineWidth = 1.2 * u; c.beginPath();
    if (!many) for (const n of api.nodes) {
      if (n === hoverNode || (wire && n === wire.from) || n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1 || !visible(n)) continue;
      if (wire && wire.moved) { const vd = wire.valid.get(n.id); if (vd && !vd.ok) continue; }
      disc(c, n.x - n.r, n.y, 2.6 * u); disc(c, n.x + n.r, n.y, 2.6 * u);
    }
    c.fill(); c.stroke();
    const big = (n, col, fill) => {
      c.globalAlpha = 1; c.fillStyle = fill; c.strokeStyle = col; c.lineWidth = 1.8 * u;
      for (const dx of [-n.r, n.r]) { c.beginPath(); c.arc(n.x + dx, n.y, 4.6 * u, 0, Math.PI * 2); c.fill(); c.stroke(); }
    };
    if (hoverNode && visible(hoverNode)) big(hoverNode, p.accent2, p.bg);
    if (wire) big(wire.from, p.accent2, p.accent2);

    // the live wire
    if (wire && wire.moved) {
      const t = wire.target, vd = t && wire.valid.get(t.id), good = !!(vd && vd.ok);
      const col = !t ? p.accent2 : !good ? p.red : vd.duplicate ? p.amber : p.accent2;
      const k = good ? calc.wireCurve(wire.from, t) : calc.wireCurveTo(wire.from, wire.pt);
      c.shadowColor = col; c.shadowBlur = 14;
      c.strokeStyle = col; c.lineWidth = 2.8 * u; c.globalAlpha = 1;
      if (t && !good) c.setLineDash([5 * u, 4 * u]);
      bez(c, k); c.stroke();
      c.setLineDash([]);
      c.fillStyle = col; c.beginPath(); c.arc(k.p3.x, k.p3.y, 4.6 * u, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      if (t) {
        c.strokeStyle = col; c.lineWidth = 2.4 * u; c.globalAlpha = good ? 1 : 0.8;
        c.beginPath(); c.arc(t.x, t.y, t.r + 5 * u, 0, Math.PI * 2); c.stroke();
        if (good) { c.globalAlpha = 0.18; c.fillStyle = col; c.beginPath(); c.arc(t.x, t.y, t.r + 9 * u, 0, Math.PI * 2); c.fill(); }
      }
    }

    // the x on the middle of the hovered / selected wire
    for (const w of wires()) {
      const sel = w.key === selKey, hov = w.key === hoverKey;
      if (!sel && !hov) continue;
      const m = calc.bezierPoint(w.curve, 0.5), hot = hov && overX;
      c.globalAlpha = 1; c.fillStyle = hot ? p.red : p.bg; c.strokeStyle = hot ? p.red : p.accent2; c.lineWidth = 1.6 * u;
      c.beginPath(); c.arc(m.x, m.y, 8 * u, 0, Math.PI * 2); c.fill(); c.stroke();
      c.strokeStyle = hot ? "#fff" : p.text; c.lineWidth = 1.7 * u; c.beginPath();
      c.moveTo(m.x - 3 * u, m.y - 3 * u); c.lineTo(m.x + 3 * u, m.y + 3 * u); c.moveTo(m.x + 3 * u, m.y - 3 * u); c.lineTo(m.x - 3 * u, m.y + 3 * u); c.stroke();
    }
    c.restore();
  }

  // ── wiring it all up ───────────────────────────────────────────────────────────────────────
  const offs = [
    api.on("beforeDraw", drawWires),
    api.on("afterDraw", drawLink),
    api.on("nodesChanged", () => {
      wire = null; hoverKey = null; overX = false; hideTip();
      indexEdges();
      if (moveAc) moveAc.abort();
      moveAc = new AbortController();
      window.addEventListener("mousemove", onMove, { signal: moveAc.signal });
      const wrap = api.wrap;
      if (wrap && !attached.has(wrap)) {
        attached.add(wrap);   // on the wrap, in the capture phase: we see the press before the engine's own handlers do
        wrap.addEventListener("mousedown", onDown, { capture: true, ...sig });
        wrap.addEventListener("click", onClick, { capture: true, ...sig });
        wrap.addEventListener("mouseleave", () => { if (!wire) { hideTip(); if (hoverKey) { hoverKey = null; overX = false; redraw(); } } }, sig);
      }
      paintHint();
    }),
  ];
  const offMode = onModeChange((m, prev) => {
    if (ctx !== me) return;
    if (m === "link") { if (isPathMode()) togglePath(api); selKey = null; }
    if (prev === "link") { wire = null; selKey = null; hoverKey = null; hideTip(); }
    paintHint(); redraw();
  });
  // links made by hand: fetch them, and rebuild the map once if concept / person links need to join its graph
  let alive = true;
  store.fetchLinks().then((changed) => {
    if (!alive) return;
    if (changed && state.data && store.getLinks().some((l) => l.kind === "pair")) state.mount(); else redraw();
  }, () => {});

  const cleanup = () => {
    alive = false; ac.abort(); if (moveAc) moveAc.abort(); offs.forEach((o) => o()); offMode(); tip.remove(); clearTimeout(hintTimer);
    if (ctx === me) { ctx = null; if (getMode() === "link") setMode("select"); }
  };
  window.addEventListener("hashchange", cleanup, { once: true });
  if (linkOn()) notifyToolbar();
  return cleanup;
});
