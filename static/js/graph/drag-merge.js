// Merge tool: drag one node onto another to merge them. There is no confirm dialog; Ctrl+Z (or the toast's Undo button)
// replaces it.
//
//   Merge mode (Edit tab -> Merge, `getMode() === "merge"`): a plain drag is a merge gesture. The dragged node follows the
//   pointer; hover a target for ~150 ms and it lights up with a floating "Merge “A” into “B”" label; release to merge.
//   Release anywhere else (or press Esc) and the node snaps back, nothing happens. Esc also leaves Merge mode.
//   Select mode: hold Shift while dragging for the same thing (the older gesture, kept as a shortcut).
//
// What merges (see merge-rules.js): concept<->concept and person<->person (POST /api/merge/undoable, every dump with the
// old name gets the new one and the old spelling is remembered as an alias), dump<->dump (POST /api/dumps/merge: the older
// note survives with both texts, concepts, people and tasks). Tasks and other item nodes cannot be merged; hovering one says why.
// Every merge is pushed on the undo stack (undo.js) so Ctrl+Z restores it exactly, Ctrl+Shift+Z does it again.
//
// Needs the engine's dragstart / drag / dragend events (engine.js). `dragend` carries `restore`: we set it so the node
// that was dragged goes back where it was and does not get pinned at the drop point.
import { toast } from "../ui.js";
import { onGraphReady } from "./hooks.js";
import { loadPins, savePins } from "./prefs.js";
import { isPathMode } from "./path.js";
import { registerTool, getMode, setMode, onModeChange } from "./toolbar.js";
import { pushUndo, undo } from "./undo.js";
import { postJson, reloadMap, undoToast } from "./edit-tools.js";
import { isLargeMap } from "./perf.js";
import { mergeable, nounOf, canMerge, prompt, doneText, undoLabel, dropHint } from "./merge-rules.js";

const DWELL_MS = 150;   // how long the pointer must rest on a target before it lights up and a drop will merge

const ICON_MERGE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="12" r="3"/><path d="M8.3 7.3C12 8.5 13 10 15.2 11M8.3 16.7C12 15.5 13 14 15.2 13"/></svg>`;

registerTool({
  tab: "edit", id: "merge", label: "Merge", icon: ICON_MERGE, kind: "mode", order: 30, group: "edit",
  tip: "Drag a note onto another to merge them.",
  help: "Pick up a node and drop it on another of the same kind. Two concepts or two people become one: every note that used the old name now uses the other, and the old spelling is remembered. Two notes become one note, keeping the older one's title and the text, tasks and links of both. Nothing asks you to confirm; Ctrl+Z undoes it. Esc leaves this mode.",
});

onGraphReady((api, state) => {
  const tip = document.createElement("div");
  tip.className = "bdl-merge-tip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  let st = null;          // { node, cand, candAt, target, verdict, cancelled, last: {e, point} }
  let eatClick = false;
  let busy = false;
  let timer = 0;
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const mergeMode = () => getMode() === "merge";

  function hideTip() { tip.classList.remove("show"); }
  function showTip(text, x, y, no) {
    tip.textContent = text;
    tip.classList.toggle("no", !!no);
    const w = tip.offsetWidth, vw = document.documentElement.clientWidth;
    tip.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
    tip.style.top = Math.max(8, y) + "px";
    tip.classList.add("show");
  }

  // the node under the pointer, ignoring the one being dragged
  function targetAt(point, dragged) {
    let best = null, bd = Infinity;
    const slack = 5 / Math.max(0.4, api.view.scale);
    for (const n of api.nodes) {
      if (n === dragged) continue;
      const d = Math.hypot(n.x - point.x, n.y - point.y);
      if (d <= n.r + slack && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  const clearTarget = () => { if (st) { st.cand = null; st.target = null; st.verdict = null; } clearTimeout(timer); };

  function freeze(s) {
    s.frozen = true;
    if (isLargeMap(api.nodes.length)) for (const n of api.nodes) if (n !== s.node && n.fx == null) { n.fx = n.x; n.fy = n.y; s.pinned.push(n); }
  }
  function thaw(s) { for (const n of s.pinned) { n.fx = null; n.fy = null; } s.pinned = []; s.frozen = false; }

  function update(e, point) {
    if (!st) return;
    st.last = { e, point };
    const n = st.node;
    st.target = null; st.verdict = null;
    if (st.cancelled || !(mergeMode() || e.shiftKey) || isPathMode()) { st.cand = null; hideTip(); api.requestDraw(); return; }
    const t = targetAt(point, n);
    if (!t) {
      st.cand = null; clearTimeout(timer);
      if (mergeMode()) showTip(dropHint(n), e.clientX + 16, e.clientY - 34, true); else hideTip();
      api.requestDraw();
      return;
    }
    if (t !== st.cand) {                       // a new node under the pointer: wait for it to rest before lighting up
      st.cand = t; st.candAt = performance.now();
      clearTimeout(timer);
      timer = setTimeout(() => { if (st && st.last) update(st.last.e, st.last.point); }, DWELL_MS + 10);
    }
    if (performance.now() - st.candAt >= DWELL_MS) {
      st.target = t; st.verdict = canMerge(n, t);
      const s = api.view.toScreen(t.x, t.y);
      const ty = s.y - (t.r + 8) * api.view.scale - 34;
      if (st.verdict.ok) showTip(prompt(n, t), s.x - 40, ty, false);
      else showTip(st.verdict.reason, s.x - 40, ty, true);
    } else hideTip();
    api.requestDraw();
  }

  /** Make `src` and `tgt` one. Pushes the undo entry, reloads the map, shows the toast. */
  async function doMerge(src, tgt) {
    if (busy) return;
    busy = true;
    try {
      const isDump = src.type === "dump";
      const kind = src.type;
      const pinned = loadPins()[src.id];
      let undoId = null, survivor = null;
      const ops = {
        async run() {
          if (isDump) { const r = await postJson("/dumps/merge", { ids: [src.id, tgt.id] }); undoId = r.merge_id; survivor = r.id; return r; }
          const r = await postJson("/merge/undoable", { kind, sources: [src.label], target: tgt.label }); undoId = r.undo_id; return r;
        },
        async back() {
          const id = undoId; undoId = null;
          if (!id) throw Object.assign(new Error("There is nothing to undo for that merge."), { permanent: true });
          await postJson(isDump ? `/merges/${id}/undo` : `/merge/undo/${id}`);
        },
      };
      const keepId = () => {
        if (isDump) return api.byId[survivor] ? survivor : tgt.id;
        return api.byId[tgt.id] ? tgt.id : (api.nodes.find((n) => n.type === tgt.type && n.label.toLowerCase() === tgt.label.toLowerCase()) || {}).id;
      };
      try { await ops.run(); }
      catch (err) { toast(err.message || "Couldn't merge those.", true); return; }
      const pins = loadPins(); if (pins[src.id]) { delete pins[src.id]; savePins(pins); }
      const label = undoLabel(src, tgt);
      const doUndo = async () => {
        await ops.back();
        if (pinned) { const p = loadPins(); p[src.id] = pinned; savePins(p); }
        await reloadMap(api, state, { select: src.id });
      };
      const doRedo = async () => {
        await ops.run();
        const p = loadPins(); if (p[src.id]) { delete p[src.id]; savePins(p); }
        await reloadMap(api, state, { select: null });
        const k = keepId(); if (k) api.select(k);
      };
      pushUndo({ label, undo: doUndo, redo: doRedo });
      let survivorLabel = null;
      try {
        await reloadMap(api, state, { select: null });
        const k = keepId(); if (k) { api.select(k); survivorLabel = (api.byId[k] || {}).label; }
      } catch (err) { toast("Merged, but the map couldn't reload. Open the Brain map again to see it.", true); return; }
      undoToast(doneText(src, tgt, survivorLabel), { onUndo: () => { undo(); } });
    } finally { busy = false; }
  }

  const offs = [
    api.on("dragstart", ({ node, e }) => {
      st = { node, cand: null, candAt: 0, target: null, verdict: null, cancelled: false, last: null, frozen: false, pinned: [] };
      if (mergeMode() || e.shiftKey) freeze(st);
    }),
    api.on("drag", ({ e, point }) => {
      if (st && !st.frozen && !st.cancelled && (mergeMode() || e.shiftKey)) freeze(st);   // Shift pressed part-way through the drag
      if (st && st.frozen && !st.pinned.length) { st.node.x = point.x; st.node.y = point.y; }   // nothing else moves, so the carried node follows by hand
      update(e, point);
    }),
    // While a merge drag is on, hold the rest of the map still (otherwise the carried node's repulsion shoves the very
    // node you are aiming at out from under the pointer). Small maps: the physics is simply not stepped; large maps
    // (worker physics): every free node is pinned for the drag and let go afterwards.
    api.on("tick", () => { if (st && st.frozen && !st.pinned.length) api.sim.alpha = 0; }),
    api.on("dragend", (ev) => {
      const s = st; st = null; clearTimeout(timer); hideTip(); api.requestDraw();
      if (s) thaw(s);
      if (!s || !ev.dragged) return;
      const inMode = mergeMode();
      if (s.cancelled) { ev.restore = true; return; }          // Esc during a drag: the node goes back, whatever mode
      if (!inMode && !mergeable(s.node)) return;       // a task / idea in Select mode: an ordinary move
      if (isPathMode()) { if (inMode) ev.restore = true; return; }
      const gesture = inMode || ev.e.shiftKey;
      if (!gesture) return;                            // plain drag in Select mode: move + pin, as always
      // the node under the pointer at the moment of release decides (even if the highlight had not appeared yet)
      const t = targetAt(api.view.toWorld(ev.e.clientX, ev.e.clientY), s.node);
      s.verdict = t ? canMerge(s.node, t) : null;
      if (t && s.verdict && s.verdict.ok) {
        ev.restore = true;                             // the drop was a merge request, not a move
        eatClick = true; setTimeout(() => { eatClick = false; }, 60);
        doMerge(s.node, t);
      } else if (t && s.verdict) {                     // dropped on something it can't merge with: say why, don't pin it there
        ev.restore = true;
        toast(s.verdict.reason + ".");
      } else if (inMode) {
        ev.restore = true;                             // dropped on empty space (or before a target lit up): cancel
      }
    }),
    // In Merge mode a click only selects (it must not open the dump page), and the click that ends a merge drag is eaten.
    api.on("click", (ev) => {
      if (eatClick) { ev.handled = true; return; }
      if (mergeMode() && ev.node && !ev.handled) { ev.handled = true; api.select(ev.node.id); }
    }),
    api.on("afterDraw", ({ ctx }) => {
      if (!st) return;
      const sc = api.view.scale, a = st.node;
      ctx.save();
      if (mergeMode() || (st.last && st.last.e.shiftKey)) {           // the node being carried
        ctx.strokeStyle = api.colors.dump; ctx.globalAlpha = 0.8; ctx.lineWidth = 2 / sc; ctx.setLineDash([4 / sc, 3 / sc]);
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r + 4 / sc, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      const b = st.target, v = st.verdict;
      if (b && v) {
        if (v.ok) {
          ctx.strokeStyle = api.colors.dump; ctx.fillStyle = api.colors.dump;
          ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 / sc; ctx.setLineDash([5 / sc, 4 / sc]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
          ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 9 / sc, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.lineWidth = 2.5 / sc; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 5 / sc, 0, Math.PI * 2); ctx.stroke();
        } else {                                                    // dim the invalid target and ring it dashed
          ctx.fillStyle = api.colors.bg; ctx.globalAlpha = 0.6;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 1 / sc, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = api.colors.edge; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 / sc; ctx.setLineDash([2 / sc, 3 / sc]);
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 5 / sc, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    }),
  ];

  // Esc while dragging puts the node back and cancels; Esc anywhere else (not in a text field) leaves Merge mode.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (st && !st.cancelled) { st.cancelled = true; clearTarget(); hideTip(); api.requestDraw(); }
    const t = e.target, tag = t && t.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);
    if (mergeMode() && !typing) setMode("select");
  }, { capture: true, ...sig });

  // A visual cue on the map while Merge mode is on (the engine sets the cursor inline, graph-edit.css overrides it).
  const syncMode = () => { const w = document.getElementById("graph-wrap"); if (w) w.classList.toggle("bdl-merge-mode", mergeMode()); };
  const offMode = onModeChange(() => { syncMode(); if (!mergeMode()) { clearTarget(); hideTip(); } });
  offs.push(offMode, api.on("nodesChanged", syncMode));
  syncMode();

  const cleanup = () => { ac.abort(); offs.forEach((o) => o()); clearTimeout(timer); tip.remove(); const w = document.getElementById("graph-wrap"); if (w) w.classList.remove("bdl-merge-mode"); };
  window.addEventListener("hashchange", cleanup, { once: true });
  return cleanup;
});
