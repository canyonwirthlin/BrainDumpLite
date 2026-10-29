// Keyboard navigation for the Brain map, plus the shortcut cheat sheet and the screen-reader announcements.
//
//   arrows  move the selection to the nearest connected node in that direction (any node, if none is connected)
//   Enter   open the selected node        Esc  clear the selection / close the cheat sheet
//   /       Find box                      F    fit to screen        + / -   zoom
//   P       Path mode                     H    Focus mode           ?       the cheat sheet
//
// Keys come from the engine's "keydown" event, which already ignores typing in inputs / selects. We additionally
// ignore Ctrl/Alt/Meta combos and any key while a modal is open. The canvas is focusable (tabindex 0) with a visible
// focus ring (graph-cards.css) and every selection is announced through an aria-live region.
import { $, esc } from "../ui.js";
import { go } from "../router.js";
import { onGraphReady } from "./hooks.js";
import { togglePath } from "./path.js";

const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const SHEET = [
  [["←", "↑", "→", "↓"], "Move to a connected node"],
  [["Enter"], "Open the selected node"],
  [["Esc"], "Clear selection / close this"],
  [["/"], "Find a node"],
  [["F"], "Fit everything on screen"],
  [["+", "−"], "Zoom in / out"],
  [["P"], "Path mode"],
  [["H"], "Focus mode"],
  [["?"], "Show or hide this list"],
];

/** Select `id`; if it is off-screen, pan (keeping the zoom) so it is centred. Returns false when it isn't on the map. */
export function selectAndReveal(api, id) {
  const n = api.byId[id];
  if (!n || !api.canvas) return false;
  const p = api.view.toScreen(n.x, n.y), r = api.canvas.getBoundingClientRect(), m = 70;
  if (p.x >= r.left + m && p.x <= r.right - m && p.y >= r.top + m && p.y <= r.bottom - m) { api.select(id); return true; }
  const s = api.view.scale;
  api.focusOn(id);   // marks the view as user-moved (so auto-fit stops), selects, and zooms in to >= 1.4 ...
  api.view.scale = s;   // ... which we undo: a keyboard move should pan, not zoom
  api.view.panX = api.width / 2 - s * n.x;
  api.view.panY = api.height / 2 - s * n.y;
  api.requestDraw();
  return true;
}

function typeLabel(state, type) { return (state?.types || []).find((t) => t.id === type)?.label || type; }

onGraphReady((api, state) => {
  const live = document.createElement("div");
  live.className = "bdl-sr-only";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);
  let flip = false;
  const say = (text) => { flip = !flip; live.textContent = text + (flip ? "" : " "); };   // same text twice still gets read

  let sheetOpen = false, wantFocus = false, restoreSel = null;
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  // ── visibility: what can the arrows land on? ──
  const visibleFn = () => {
    const focusSet = api.prefs.get("focus") && api.selectedId ? api.neighborsOf(api.selectedId, 2) : null;
    const tl = api.timelapse;
    return (n) => (!focusSet || focusSet.has(n.id)) && (!tl || tl.alive(n));
  };
  function nearestInDirection(from, list, d, minCos) {
    let best = null, bestScore = Infinity;
    for (const c of list) {
      if (c === from) continue;
      const dx = c.x - from.x, dy = c.y - from.y, dist = Math.hypot(dx, dy);
      if (dist < 1e-6) continue;
      const cos = (dx * d[0] + dy * d[1]) / dist;
      if (cos < minCos) continue;
      const score = dist * (1 + 2 * (1 - cos));   // nearer wins, but a node dead ahead beats one off to the side
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  function move(key) {
    const vis = visibleFn();
    const cur = api.byId[api.selectedId];
    if (!cur || !vis(cur)) {   // nothing selected yet: start from whatever is nearest the middle of the view
      const r = api.canvas.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let best = null, bd = Infinity;
      for (const n of api.nodes) {
        if (!vis(n)) continue;
        const p = api.view.toScreen(n.x, n.y), dd = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (dd < bd) { bd = dd; best = n; }
      }
      if (best) selectAndReveal(api, best.id);
      return;
    }
    const d = DIRS[key];
    const linked = (api.nbrIds[cur.id] || []).map((id) => api.byId[id]).filter((n) => n && vis(n));
    const next = nearestInDirection(cur, linked, d, 0.5) || nearestInDirection(cur, api.nodes.filter(vis), d, 0.7);
    if (next) selectAndReveal(api, next.id);
    else say("No node further that way.");
  }

  function open(n) {
    if (!n) return;
    if (n.type === "concept" || n.type === "person") go("graph/" + n.type + "/" + encodeURIComponent(n.label));
    else if (n.type === "dump") go("history/" + n.id);
    else if (n.dump) go("history/" + n.dump);
  }

  function zoom(dir) {   // reuse the engine's own wheel handler (zoom about the middle of the canvas)
    const c = api.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    for (let i = 0; i < 2; i++) c.dispatchEvent(new WheelEvent("wheel", { deltaY: dir * 100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  }

  function togglePathMode() {
    const b = $("#graph-path");
    if (b) b.click(); else togglePath(api);
  }
  function toggleFocusMode() {
    restoreSel = api.selectedId;   // the map is rebuilt when Focus flips; put the selection back afterwards
    const b = $("#graph-focus");
    if (b) b.click(); else state.setFocus(!api.prefs.get("focus"));
  }

  // ── cheat sheet + "Keys" button ──
  function paintSheet() {
    $(".bdl-keys")?.remove();
    document.querySelectorAll(".bdl-keys-btn").forEach((b) => b.setAttribute("aria-expanded", String(sheetOpen)));
    const wrap = api.wrap;
    if (!sheetOpen || !wrap) return;
    const el = document.createElement("div");
    el.className = "bdl-keys";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Keyboard shortcuts");
    el.innerHTML = `<h3>Keyboard shortcuts <button type="button" aria-label="Close shortcuts">×</button></h3>
      <dl>${SHEET.map(([keys, what]) => `<dt>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ")}</dt><dd>${esc(what)}</dd>`).join("")}</dl>
      <p class="bdl-keys-note">With the mouse: drag a node to move and pin it, double-click to unpin. Hold <kbd>Shift</kbd> and drag a concept or person onto another of the same kind to merge them.</p>`;
    $("button", el).onclick = () => setSheet(false);
    wrap.appendChild(el);
  }
  function setSheet(on) { sheetOpen = on; paintSheet(); }
  function mountKeysButton() {
    document.querySelectorAll(".bdl-keys-btn").forEach((b) => b.remove());
    // two entry points: the small "?" on the map (always there, even with the panel closed) and, when the panel has the
    // #graph-slot-keys mount point (its Tools section), a labelled "Keys" button
    const mk = (parent, slot) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = slot ? "gp-btn bdl-keys-btn" : "bdl-keys-btn floating";
      b.title = "Keyboard shortcuts (?)";
      b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", String(sheetOpen));
      if (slot) b.innerHTML = "⌨ <span>Keyboard shortcuts</span>"; else { b.id = "graph-keys-btn"; b.textContent = "?"; b.setAttribute("aria-label", "Keyboard shortcuts"); }
      b.onclick = () => setSheet(!sheetOpen);
      parent.appendChild(b);
    };
    if (api.wrap && api.wrap.isConnected) mk(api.wrap, false);
    const slot = $("#graph-slot-keys");
    if (slot) mk(slot, true);
  }

  // ── canvas focus ──
  function prepCanvas() {
    const c = api.canvas;
    if (!c) return;
    c.tabIndex = 0;
    c.setAttribute("role", "application");
    c.setAttribute("aria-label", "Brain map. Use the arrow keys to move between connected nodes, Enter to open one, question mark for all shortcuts.");
    c.addEventListener("focus", () => { wantFocus = true; });
    c.addEventListener("mousedown", () => { c.classList.remove("kbd-nav"); wantFocus = true; if (sheetOpen) setSheet(false); });
    if (wantFocus) c.focus({ preventScroll: true });
  }
  document.addEventListener("focusin", (e) => { const t = e.target; if (t && t !== document.body && t.id !== "graph-canvas") wantFocus = false; }, sig);

  const offs = [
    api.on("nodesChanged", () => {
      prepCanvas(); mountKeysButton(); paintSheet();
      if (restoreSel && api.byId[restoreSel]) api.select(restoreSel);
      restoreSel = null;
    }),
    api.on("select", ({ node }) => {
      if (!node) { say("Selection cleared."); return; }
      const links = (api.nbrIds[node.id] || []).length;
      say(`${node.label}. ${typeLabel(state, node.type)}. ${links} connection${links === 1 ? "" : "s"}.`);
    }),
    api.on("keydown", ({ e, node }) => {
      // defaultPrevented: another tool already used the key (the time-lapse owns Space / Left / Right / Esc while it is open)
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".modal-bg")) return;
      const t = e.target, key = e.key;
      const onControl = t && t.closest && t.closest("a, button, summary, [role=button]");
      let used = true;
      if (DIRS[key]) { if (!e.shiftKey) move(key); else used = false; }
      else if (key === "Enter") { if (onControl) return; open(api.byId[api.selectedId] || node); }
      else if (key === "Escape") { if (sheetOpen) setSheet(false); else if (api.selectedId) api.select(null); else used = false; }
      else if (key === "/") { const f = $("#graph-find"); if (f) { f.focus(); f.select?.(); } else used = false; }
      else if (key === "f" || key === "F") api.fit();
      else if (key === "+" || key === "=") zoom(-1);
      else if (key === "-" || key === "_") zoom(1);
      else if (key === "p" || key === "P") togglePathMode();
      else if (key === "h" || key === "H") toggleFocusMode();
      else if (key === "?") setSheet(!sheetOpen);
      else used = false;
      if (used) { e.preventDefault(); api.canvas?.classList.add("kbd-nav"); }
    }),
  ];
  window.addEventListener("bdl-graph-panel-rendered", () => { mountKeysButton(); paintSheet(); }, sig);

  // Leaving the map: take our page-level pieces with us (the hooks run again on the next visit).
  const cleanup = () => { ac.abort(); offs.forEach((o) => o()); live.remove(); document.querySelectorAll(".bdl-keys, .bdl-keys-btn").forEach((n) => n.remove()); };
  window.addEventListener("hashchange", cleanup, { once: true });
  return cleanup;
});
