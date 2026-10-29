// Drag-to-merge: hold Shift, drag a concept (or person) onto another node of the SAME kind, drop, confirm.
// A plain drag keeps its normal meaning (move + pin). The merge itself is the app's existing POST /api/merge
// (graph.merge_names): every dump that has the old name gets the new one, and the old spelling is remembered as an
// alias. After it succeeds the map data is reloaded and the surviving node is selected.
//
// Needs the engine's dragstart / drag / dragend events (engine.js). `dragend` carries `restore`: we set it so the node
// that was dragged goes back where it was and does not get pinned at the drop point.
import { esc, modal, toast } from "../ui.js";
import { api as http } from "../api.js";
import { onGraphReady } from "./hooks.js";
import { loadGraph } from "./data.js";
import { loadPins, savePins } from "./prefs.js";
import { isPathMode } from "./path.js";
import { mentionTimes } from "./info-sparkline.js";
import { selectAndReveal } from "./keyboard.js";

const mergeable = (n) => n && (n.type === "concept" || n.type === "person");
const noun = (n) => (n.type === "person" ? "person" : "concept");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Confirm dialog. Resolves true on "Merge", false on cancel / Esc / click outside. */
function confirmMerge(src, tgt, count) {
  return new Promise((resolve) => {
    const kind = noun(src);
    const m = modal(`<div class="bdl-merge-dlg" role="alertdialog" aria-labelledby="bdl-md-h">
      <h2 id="bdl-md-h">Merge these ${kind}s?</h2>
      <div class="md-flow"><span class="name">${esc(src.label)}</span><span aria-hidden="true">→</span><span class="name to">${esc(tgt.label)}</span></div>
      <p class="md-sub">“${esc(src.label)}” will be merged into “${esc(tgt.label)}” in ${plural(count, "dump")}. Anywhere you wrote the old name, the dump will say “${esc(tgt.label)}” instead, and new dumps that use it will land on the same ${kind}.</p>
      <p class="md-warn">You can't undo this.</p>
      <div class="md-actions"><button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn" data-act="ok">Merge</button></div>
    </div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; document.removeEventListener("keydown", onKey, true); m.close(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
    document.addEventListener("keydown", onKey, true);
    // clicking the backdrop closes the modal helper's element: treat as cancel
    new MutationObserver((_, ob) => { if (!m.el.isConnected) { ob.disconnect(); finish(false); } }).observe(document.body, { childList: true });
    const q = (s) => m.el.querySelector(s);
    q('[data-act="cancel"]').onclick = () => finish(false);
    q('[data-act="ok"]').onclick = () => finish(true);
    q('[data-act="cancel"]').focus();   // an irreversible action: Enter must not confirm it by accident
  });
}

onGraphReady((api, state) => {
  const tip = document.createElement("div");
  tip.className = "bdl-merge-tip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  let st = null;          // { node, target, valid, cancelled }
  let eatClick = false;
  let busy = false;
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  function hideTip() { tip.classList.remove("show"); }
  function showTip(text, e, no) {
    tip.textContent = text;
    tip.classList.toggle("no", !!no);
    const w = tip.offsetWidth, vw = document.documentElement.clientWidth;
    tip.style.left = Math.max(8, Math.min(e.clientX + 16, vw - w - 8)) + "px";
    tip.style.top = Math.max(8, e.clientY - 34) + "px";
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

  function update(e, point) {
    if (!st) return;
    const n = st.node;
    st.target = null; st.valid = false;
    if (st.cancelled || !e.shiftKey || !mergeable(n) || isPathMode()) { hideTip(); api.requestDraw(); return; }
    const t = targetAt(point, n);
    if (!t) { showTip(`Shift + drag onto another ${noun(n)} to merge`, e, true); api.requestDraw(); return; }
    st.target = t;
    st.valid = t.type === n.type;
    if (st.valid) showTip(`Merge into ${t.label}`, e, false);
    else showTip(`Can't merge a ${noun(n)} into this`, e, true);
    api.requestDraw();
  }

  async function doMerge(src, tgt, count) {
    if (busy) return;
    busy = true;
    try {
      if (!(await confirmMerge(src, tgt, count))) return;
      let res;
      try { res = await http.post("/merge", { kind: noun(src), sources: [src.label], target: tgt.label }); }
      catch (err) { toast(err.message || "Couldn't merge those.", true); return; }
      const pins = loadPins(); if (pins[src.id]) { delete pins[src.id]; savePins(pins); }
      toast(`Merged “${src.label}” into “${tgt.label}”${res.merged_dumps ? ` in ${plural(res.merged_dumps, "dump")}` : ""}.`);
      try { state.data = await loadGraph(!!(state.data && state.data.hasItems)); }
      catch (err) { toast("Merged, but the map couldn't reload. Open the Brain map again to see it.", true); return; }
      state.mount();
      const keep = api.byId[tgt.id] ? tgt.id : (api.nodes.find((n) => n.type === tgt.type && n.label.toLowerCase() === tgt.label.toLowerCase()) || {}).id;
      if (keep) selectAndReveal(api, keep);
    } finally { busy = false; }
  }

  const offs = [
    api.on("dragstart", ({ node }) => { st = { node, target: null, valid: false, cancelled: false }; }),
    api.on("drag", ({ e, point }) => update(e, point)),
    api.on("dragend", (ev) => {
      const s = st; st = null; hideTip(); api.requestDraw();
      if (!s || !mergeable(s.node) || !ev.dragged) return;
      if (s.cancelled) { if (ev.e.shiftKey || s.target) ev.restore = true; return; }
      if (ev.e.shiftKey && s.target && !s.valid && !isPathMode()) {   // dropped on the wrong kind of node: say so, don't pin it there
        ev.restore = true;
        toast(`A ${noun(s.node)} can only be merged into another ${noun(s.node)}.`);
        return;
      }
      if (!ev.e.shiftKey || !s.target || !s.valid || isPathMode()) return;
      ev.restore = true;                 // the drop was a merge request, not a move
      eatClick = true; setTimeout(() => { eatClick = false; }, 60);
      doMerge(s.node, s.target, mentionTimes(api, s.node.id).length || (api.nbrIds[s.node.id] || []).length);
    }),
    api.on("click", (ev) => { if (eatClick) ev.handled = true; }),
    api.on("afterDraw", ({ ctx }) => {
      if (!st || !st.target) return;
      const a = st.node, b = st.target, sc = api.view.scale, col = st.valid ? api.colors.dump : api.colors.edge;
      ctx.save();
      ctx.strokeStyle = col; ctx.fillStyle = col;
      if (st.valid) {
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 / sc; ctx.setLineDash([5 / sc, 4 / sc]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 9 / sc, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 2.5 / sc; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 5 / sc, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.globalAlpha = 0.7; ctx.lineWidth = 1.5 / sc; ctx.setLineDash([2 / sc, 3 / sc]);
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 5 / sc, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }),
  ];
  // Esc while dragging puts the node back and cancels the merge
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st) { st.cancelled = true; st.target = null; hideTip(); api.requestDraw(); }
  }, { capture: true, ...sig });

  const cleanup = () => { ac.abort(); offs.forEach((o) => o()); tip.remove(); };
  window.addEventListener("hashchange", cleanup, { once: true });
  return cleanup;
});
