// Tutorial cards for the Brain map. One light mock (a ribbon on top of a small SVG map) shared by four cards:
//   graph         hover a dot for a preview, click it, drag it           (View tab, Select mode)
//   graph-ribbon  the six tabs, button tooltips, the round ? help panel  (any tab)
//   graph-link    Edit tab, Link mode: drag a wire between two dots, click it, Delete, Ctrl+Z
//   graph-merge   Edit tab, Merge mode: drag one dot onto another, Undo / Ctrl+Z
// The ribbon is drawn from the REAL registry (graph/toolbar.js: tab names, tool labels, icons, tips, help text), so a renamed or
// added tool shows up here by itself; only the map and what the tools do are simulated. Nothing calls the API.
import { $, $$, esc } from "./ui.js";
import { TABS, toolsFor } from "./graph/toolbar.js";
import { val, buildRow, helpModel, placeTip, nextTabIndex } from "./graph/ribbon-model.js";
import { demoNote } from "./tour-scenes.js";

const COLOR = { dump: "var(--accent)", concept: "var(--amber)", person: "var(--accent-2)" };
const R = { dump: 9, concept: 7, person: 7 };
const NOUN = { dump: "note", concept: "concept", person: "person" };
const KIND = { dump: "Dump", concept: "Concept", person: "Person" };
const short = (s, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// Nodes keep their place as a fraction of the map box (x, y in 0..1) so the map fits any card width; px() turns that into pixels.
const startState = (seedWire) => ({
  nodes: [
    { id: "d1", label: "Career pivot anxiety", type: "dump", x: 0.4688, y: 0.2067, note: "I keep going back and forth on the internship applications…", tags: ["Internship", "home lab", "Sam"], mentions: 3 },
    { id: "d2", label: "Weekend reset plan", type: "dump", x: 0.1875, y: 0.6833, note: "Laundry, call the dentist, finish the report…", tags: ["hiking", "Sam"], mentions: 2 },
    { id: "d3", label: "Streak garden idea", type: "dump", x: 0.7891, y: 0.7167, note: "What if streaks grew a little garden instead of a flame?", tags: ["internships"], mentions: 1 },
    { id: "c1", label: "Internship", type: "concept", x: 0.6250, y: 0.4167, mentions: 4 },
    { id: "c2", label: "internships", type: "concept", x: 0.8750, y: 0.3500, mentions: 2 },
    { id: "c3", label: "home lab", type: "concept", x: 0.2734, y: 0.3167, mentions: 3 },
    { id: "c4", label: "hiking", type: "concept", x: 0.0859, y: 0.8733, mentions: 2 },
    { id: "p1", label: "Sam", type: "person", x: 0.4453, y: 0.7833, mentions: 2 },
  ],
  edges: [["d1", "c1"], ["d1", "c3"], ["d1", "p1"], ["d3", "c2"], ["d2", "c4"], ["d2", "p1"], ["d1", "d3", "sim"]]
    .map(([a, b, kind]) => ({ a, b, kind: kind || "mention" })).concat(seedWire ? [{ a: "c4", b: "c3", kind: "wire" }] : []),
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const MAP_H = 250;
const pairKey = (a, b) => [a, b].sort().join("|");

// What a wire between two kinds of node means, in the app's own words (graph/blueprint.js).
function wireText(A, B) {
  const [x, y] = A.type === "dump" || B.type !== "dump" ? [A, B] : [B, A];
  if (x.type === "dump" && y.type === "dump") return `a link between “${short(x.label)}” and “${short(y.label)}”`;
  if (x.type === "dump") return `“${short(x.label)}” ${y.type === "concept" ? "has the concept" : "mentions"} “${short(y.label)}”`;
  return `“${short(x.label)}” and “${short(y.label)}”`;
}

function mountGraph(view, t, nav, opts) {
  let tab = opts.tab, mode = opts.mode;
  const S = startState(opts.seedWire);
  const stack = []; let idx = 0;           // undo stack: [{ label, before, after }], idx = how many are applied
  let hover = null, sel = null, selWire = null, drag = null, link = null, toastEl = null, helpOpen = false, tipFor = null, tipTimer = 0;
  const flags = new Set();                 // buttons the viewer toggled (look only)
  const total = S.nodes.length;

  view.innerHTML = `<div class="t-gm"><div class="gr" id="t-gr">
      <div class="gr-top"><div class="gr-tabs" role="tablist" aria-label="Map toolbar tabs"></div><span class="gr-status" id="t-count"></span>
        <button type="button" class="gr-help-btn" aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">?</span></button></div>
      <div class="gr-rowwrap"><div class="gr-row" role="tabpanel"><div class="gr-tools" role="toolbar"></div></div></div>
      <div class="gr-tip" role="tooltip" hidden></div><div class="gr-help" role="dialog" tabindex="-1" hidden></div></div>
    <div class="t-gwrap" id="t-gwrap"><svg class="t-gsvg" id="t-svg" role="img" aria-label="Demo Brain map"></svg></div>
    <div class="card t-info" id="t-info"></div>${opts.show ? `<div class="row" style="margin:8px 0 0"><button class="btn small" id="t-show">▶ Show me</button><span class="small muted">or try it yourself</span></div>` : ""}
    ${demoNote("Demo map. The ribbon is the real one; nothing here changes your notes.")}</div>`;
  const $q = (s) => $(s, view);
  const root = $q("#t-gr"), svg = $q("#t-svg"), wrap = $q("#t-gwrap"), tools = $q(".gr-tools"), tipEl = $q(".gr-tip"), helpEl = $q(".gr-help"), helpBtn = $q(".gr-help-btn");
  let W = 640;
  const px = (n) => ({ x: n.x * W, y: n.y * MAP_H });
  const sizeMap = () => { W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 640); svg.setAttribute("viewBox", `0 0 ${W} ${MAP_H}`); };
  const byId = (id) => S.nodes.find((n) => n.id === id);
  const adj = (id) => S.edges.filter((e) => e.a === id || e.b === id).map((e) => (e.a === id ? e.b : e.a));
  const canUndo = () => idx > 0, canRedo = () => idx < stack.length;

  // ── undo ───────────────────────────────────────────────────────────────────────────────────
  const apply = (st) => { S.nodes = clone(st.nodes); S.edges = clone(st.edges); sel = null; selWire = null; hover = null; draw(); };
  const push = (label, before) => { stack.splice(idx); stack.push({ label, before, after: clone({ nodes: S.nodes, edges: S.edges }) }); idx = stack.length; paintRibbon(); };
  const undo = () => { if (!canUndo()) return; const e = stack[--idx]; apply(e.before); say(`Undone: ${e.label}`); paintRibbon(); };
  const redo = () => { if (!canRedo()) return; const e = stack[idx++]; apply(e.after); say(`Done again: ${e.label}`); paintRibbon(); };
  const snap = () => clone({ nodes: S.nodes, edges: S.edges });

  // ── ribbon (drawn from the real tool registry) ─────────────────────────────────────────────
  const iconHtml = (i) => (typeof i === "string" && i.trimStart().startsWith("<svg") ? i : `<span class="gr-emoji">${esc(i || "")}</span>`);
  const isOn = (tl) => (tl.kind === "mode" ? mode === tl.id : tl.id === "layout:organic" || flags.has(tl.id));
  const tipOf = (tl) => (tl.id === "undo" ? (canUndo() ? `Undo: ${stack[idx - 1].label} (Ctrl+Z)` : "Nothing to undo (Ctrl+Z)") : tl.id === "redo" ? (canRedo() ? `Redo: ${stack[idx].label} (Ctrl+Shift+Z)` : "Nothing to redo (Ctrl+Shift+Z)") : String(val(tl.tip) || ""));
  const custom = (tl) => {
    const lbl = String(val(tl.label) || "");
    if (tl.id === "find") return `<div class="gr-find"><span class="gr-find-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span><input type="search" placeholder="Find a node…" aria-label="Find a node"></div>`;
    if (["spacing", "min-mentions", "edge-threshold"].includes(tl.id)) return `<div class="gr-slider"><div class="gr-slider-top"><label>${esc(lbl)}</label><output>${tl.id === "spacing" ? "1.0×" : tl.id === "min-mentions" ? "1" : "Any"}</output></div><input type="range" min="0" max="10" value="${tl.id === "spacing" ? 3 : 0}" aria-label="${esc(lbl)}"></div>`;
    if (tl.id === "types") return `<div class="gr-types">${[["Dumps", "dump", 1], ["Concepts", "concept", 1], ["People", "person", 1], ["Tasks", "", 0], ["Ideas", "", 0]].map(([n, k, on]) => `<span class="gr-type ${on ? "" : "off"}"><button type="button" class="gr-chip"><i class="gr-dot" style="background:${k ? COLOR[k] : "var(--dim)"}"></i>${n}</button></span>`).join("")}</div>`;
    if (tl.id === "range") return `<div class="gr-cap">Date range</div><div class="gr-seg">${["7d", "30d", "90d", "1y", "All"].map((r, i) => `<button type="button" class="${i === 4 ? "on" : ""}">${r}</button>`).join("")}</div>`;
    return `<button type="button" class="gr-btn" data-tool="${tl.id}"><span class="gr-ico">${iconHtml(val(tl.icon) || (tl.id === "export" ? "⤓" : tl.id === "keys" ? "⌨" : "◇"))}</span><span class="gr-lbl">${esc(lbl)}</span></button>`;
  };
  function paintRibbon() {
    $$(".gr-tab", root).forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; });
    const label = (TABS.find((x) => x.id === tab) || {}).label || "";
    helpBtn.setAttribute("aria-label", `Help for the ${label} tab`); helpBtn.dataset.tip = `Explains the tools on the ${label} tab`;
    $q("#t-count").textContent = `Showing ${S.nodes.length} of ${total} nodes`;
    tools.innerHTML = buildRow(toolsFor(tab)).map((en) => {
      if (en.type === "divider") return `<i class="gr-div" role="separator"></i>`;
      const tl = en.tool;
      if (tl.kind === "custom") return `<div class="gr-item" data-tool="${tl.id}" data-tip="${esc(String(val(tl.tip) || ""))}" ${val(tl.key) ? `data-key="${esc(val(tl.key))}"` : ""}>${custom(tl)}</div>`;
      const off = (tl.id === "undo" && !canUndo()) || (tl.id === "redo" && !canRedo());
      return `<button type="button" class="gr-btn ${tl.kind === "mode" ? "gr-mode" : ""} ${isOn(tl) ? "on" : ""} ${off ? "is-disabled" : ""}" data-tool="${tl.id}" data-tip="${esc(tipOf(tl))}" ${val(tl.key) ? `data-key="${esc(val(tl.key))}"` : ""} aria-pressed="${isOn(tl)}" aria-disabled="${off}">
        <span class="gr-ico" aria-hidden="true">${iconHtml(val(tl.icon))}</span><span class="gr-lbl">${esc(String(val(tl.label) || ""))}</span></button>`;
    }).join("");
    $$("button.gr-btn", tools).forEach((b) => b.onclick = () => {
      const tl = toolsFor(tab).find((x) => x.id === b.dataset.tool);
      if (!tl) return;
      if (tl.kind === "mode") { setMode(tl.id); return; }
      if (tl.id === "undo") undo(); else if (tl.id === "redo") redo();
      else if (tl.kind === "toggle") { flags.has(tl.id) ? flags.delete(tl.id) : flags.add(tl.id); paintRibbon(); }
    });
    wrap.classList.toggle("bdl-merge-mode", mode === "merge");
    hintChip();
  }
  const setTab = (id) => { tab = id; hideTip(); paintRibbon(); if (helpOpen) paintHelp(); };
  $q(".gr-tabs").innerHTML = TABS.map((x) => `<button type="button" role="tab" class="gr-tab" data-tab="${x.id}">${esc(x.label)}</button>`).join("");
  const tabBtns = $$(".gr-tab", root);
  tabBtns.forEach((b, i) => { b.onclick = () => setTab(b.dataset.tab); b.onkeydown = (e) => { const n = nextTabIndex(e.key, i, tabBtns.length); if (n < 0) return; e.preventDefault(); setTab(tabBtns[n].dataset.tab); tabBtns[n].focus(); }; });
  function setMode(id) { if (id === mode) return; mode = id; link = null; drag = null; selWire = null; hideTip(); paintRibbon(); draw(); }

  // tooltips: the real ones show after a short pause on hover and at once on keyboard focus
  function showTip(a) {
    const text = a.dataset.tip; if (!text) return;
    tipFor = a; tipEl.innerHTML = `<span>${esc(text)}</span>${a.dataset.key ? `<kbd>${esc(a.dataset.key)}</kbd>` : ""}`; tipEl.hidden = false;
    const p = placeTip(a.getBoundingClientRect(), { w: tipEl.offsetWidth, h: tipEl.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    tipEl.style.left = p.left + "px"; tipEl.style.top = p.top + "px";
  }
  function hideTip() { clearTimeout(tipTimer); tipFor = null; tipEl.hidden = true; }
  root.addEventListener("pointerover", (e) => { const a = e.target.closest("[data-tip]"); if (a === tipFor || (!a && tipEl.hidden)) return; hideTip(); if (a && !a.closest(".gr-help")) tipTimer = setTimeout(() => showTip(a), 250); });
  root.addEventListener("pointerleave", hideTip); root.addEventListener("pointerdown", hideTip);
  root.addEventListener("focusin", (e) => { const a = e.target.closest("[data-tip]"); if (a && e.target.matches(":focus-visible")) { hideTip(); showTip(a); } });
  root.addEventListener("focusout", hideTip);

  // the round ? button
  function paintHelp() {
    const m = helpModel(TABS.find((x) => x.id === tab) || { label: "", help: "" }, toolsFor(tab));
    helpEl.innerHTML = `<div class="gr-help-h"><h3>${esc(m.title)}</h3><button type="button" class="gr-help-x" aria-label="Close help">×</button></div>${m.intro ? `<p class="gr-help-intro">${esc(m.intro)}</p>` : ""}
      <dl class="gr-help-list">${m.items.map((i) => `<div class="gr-help-item"><dt>${esc(i.name)}${i.key ? ` <kbd>${esc(i.key)}</kbd>` : ""}</dt><dd>${esc(i.help)}</dd></div>`).join("")}</dl>`;
    $(".gr-help-x", helpEl).onclick = () => closeHelp();
  }
  function openHelp() { hideTip(); paintHelp(); helpEl.hidden = false; helpOpen = true; helpBtn.setAttribute("aria-expanded", "true"); }
  function closeHelp() { helpEl.hidden = true; helpOpen = false; helpBtn.setAttribute("aria-expanded", "false"); }
  helpBtn.onclick = () => (helpOpen ? closeHelp() : openHelp());
  const onDown = (e) => { if (helpOpen && !helpEl.contains(e.target) && !helpBtn.contains(e.target)) closeHelp(); };
  document.addEventListener("pointerdown", onDown, true);

  // ── map ────────────────────────────────────────────────────────────────────────────────────
  const pt = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hit = (p, skip) => { let best = null, bd = 1e9; for (const n of S.nodes) { if (n === skip) continue; const c = px(n), d = Math.hypot(c.x - p.x, c.y - p.y); if (d <= R[n.type] + 8 && d < bd) { bd = d; best = n; } } return best; };
  const segDist = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1, k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)); return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy)); };
  const wireAt = (p) => S.edges.find((e) => e.kind === "wire" && byId(e.a) && byId(e.b) && segDist(p, px(byId(e.a)), px(byId(e.b))) < 8) || null;
  const wkey = (e) => pairKey(e.a, e.b);

  function draw() {
    const at = drag || link || mode !== "select" ? null : hover || sel, near = new Set(at ? [at, ...adj(at)] : []);
    const pos = (n) => (drag && drag.node === n ? drag.pt : px(n));
    let h = "";
    for (const e of S.edges) {
      const A = byId(e.a), B = byId(e.b); if (!A || !B) continue;
      const a = pos(A), b = pos(B), dim = at && !(near.has(e.a) && near.has(e.b));
      if (e.kind === "wire") {
        const on = selWire === wkey(e);
        h += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${on ? "var(--amber)" : "var(--accent-2)"}" stroke-width="${on ? 4 : 2.6}" stroke-linecap="round" opacity="${dim ? .2 : 1}"/>`;
        if (on) h += `<g class="t-wx" data-k="${wkey(e)}" style="cursor:pointer"><circle cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" r="9" fill="var(--panel)" stroke="var(--amber)" stroke-width="1.5"/><path d="M${(a.x + b.x) / 2 - 3.5} ${(a.y + b.y) / 2 - 3.5}l7 7m0 -7l-7 7" stroke="var(--amber)" stroke-width="1.8" stroke-linecap="round"/></g>`;
      } else h += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--dim)" stroke-dasharray="${e.kind === "sim" ? "4 3" : ""}" opacity="${dim ? .08 : .4}"/>`;
    }
    if (link) h += `<line x1="${px(link.from).x}" y1="${px(link.from).y}" x2="${link.pt.x}" y2="${link.pt.y}" stroke="var(--accent-2)" stroke-width="2.4" stroke-dasharray="6 4" stroke-linecap="round"/>`;
    const tgt = link ? link.target : drag ? drag.target : null;
    for (const n of S.nodes) {
      const { x, y } = pos(n), r = R[n.type], dim = at && !near.has(n.id), left = x > W - 150, ok = drag ? drag.ok : link ? link.ok : true;
      h += `<g opacity="${dim ? .25 : 1}">${tgt === n ? `<circle cx="${x}" cy="${y}" r="${r + 7}" fill="none" stroke="${ok ? "var(--green)" : "var(--red)"}" stroke-width="2.4"/>` : ""}
        <circle cx="${x}" cy="${y}" r="${r}" fill="${COLOR[n.type]}" ${n.id === sel ? 'stroke="var(--text)" stroke-width="2"' : ""} opacity="${drag && drag.node === n ? .8 : 1}"/>
        ${mode === "link" ? `<circle cx="${x + r + 4}" cy="${y}" r="3.6" fill="var(--panel)" stroke="var(--accent-2)" stroke-width="1.6"/>` : ""}
        <text x="${left ? x - r - 5 : x + r + 5}" y="${y + 4}" text-anchor="${left ? "end" : "start"}" fill="var(--text)" font-size="11" ${mode === "link" && !left ? 'dx="9"' : ""}>${esc(short(n.label, W < 520 ? 13 : 22))}</text></g>`;
    }
    svg.innerHTML = h;
    $$(".t-wx", svg).forEach((g) => g.onpointerdown = (e) => { e.stopPropagation(); removeWire(g.dataset.k); });
    svg.style.cursor = mode === "merge" ? "crosshair" : mode === "link" ? "crosshair" : hover ? "pointer" : "grab";
    paintInfo(); paintCard();
  }

  // hover card + info box
  function paintCard() {
    wrap.querySelectorAll(".t-hc").forEach((n) => n.remove());
    const n = mode === "select" && !drag && hover && byId(hover); if (!n || n.id === sel) return;   // the real card is quiet while Link / Merge own the pointer
    const e = document.createElement("div"); e.className = "bdl-hc show t-hc";
    const chips = (n.tags || []).map((c) => `<span class="bdl-hc-chip ${c === "Sam" ? "person" : ""}">${esc(c)}</span>`).join("");
    e.innerHTML = `<div class="bdl-hc-head"><i class="bdl-hc-dot" style="background:${COLOR[n.type]}"></i><span>${KIND[n.type]}${n.type === "dump" ? " · 14 Sep 2026" : ` · ${n.mentions} mention${n.mentions === 1 ? "" : "s"}`}</span></div>
      <div class="bdl-hc-title">${esc(n.label)}</div>${n.note ? `<div class="bdl-hc-snippet">${esc(n.note)}</div>` : ""}${chips ? `<div class="bdl-hc-chips">${chips}</div>` : ""}
      <div class="bdl-hc-foot">Click to select it</div>`;
    wrap.appendChild(e);
    const c = px(n), w = e.offsetWidth, hgt = e.offsetHeight;
    let left = c.x + 18; if (left + w > W - 6) left = c.x - w - 18;
    e.style.left = Math.max(6, left) + "px"; e.style.top = Math.max(6, Math.min(c.y - hgt / 2, MAP_H - hgt - 6)) + "px";
  }
  function paintInfo() {
    const n = sel && byId(sel), box = $q("#t-info");
    if (opts.info) { box.innerHTML = opts.info(mode, n); return; }
    box.innerHTML = n ? `<b>${esc(n.label)}</b> <span class="small muted">${KIND[n.type].toLowerCase()} · connected to ${adj(n.id).length}: ${esc(adj(n.id).map((i) => byId(i).label).join(", ") || "nothing yet")}</span>` : `<span class="small muted">Click a dot.</span>`;
  }

  // toast with an inline Undo (the real one lives at the bottom of the screen; here it sits on the map)
  function say(msg, withUndo) {
    toastEl?.remove(); clearTimeout(say.t);
    const e = toastEl = document.createElement("div"); e.className = "t-toast"; e.setAttribute("role", "status");
    e.innerHTML = `<span>${esc(msg)}</span>${withUndo ? `<button type="button" class="ut-btn">Undo</button>` : ""}`;
    wrap.appendChild(e);
    if (withUndo) $(".ut-btn", e).onclick = () => { e.remove(); undo(); };
    say.t = setTimeout(() => e.remove(), 6500);
  }
  function hintChip() {
    wrap.querySelectorAll(".bdl-bp-hint").forEach((n) => n.remove());
    if (mode !== "link") return;
    const e = document.createElement("div"); e.className = "bdl-bp-hint"; e.setAttribute("role", "status");
    e.innerHTML = `<div><b>Link mode</b> · drag from one node to another to connect them · <kbd>Esc</kbd> leaves</div>`;
    wrap.prepend(e);
    t.later(() => e.classList.add("quiet"), 6000);   // like the real chip, it fades out by itself
  }
  function mtip(text, p, no) {
    let e = $(".t-mtip", wrap);
    if (!text) { e?.remove(); return; }
    if (!e) { e = document.createElement("div"); e.className = "t-mtip"; wrap.appendChild(e); }
    e.textContent = text; e.classList.toggle("no", !!no);
    const w = e.offsetWidth;
    e.style.left = Math.max(6, Math.min(p.x + 14, W - w - 6)) + "px"; e.style.top = Math.max(6, p.y - 34) + "px";
  }

  // ── what the tools do ──────────────────────────────────────────────────────────────────────
  function makeWire(A, B) {
    if (!A || !B || A === B) return;
    if (S.edges.some((e) => pairKey(e.a, e.b) === pairKey(A.id, B.id))) { say(`${wireText(A, B)} are already linked.`); return; }
    const before = snap(); S.edges.push({ a: A.id, b: B.id, kind: "wire" });
    push(`Link ${short(A.label, 14)} and ${short(B.label, 14)}`, before); draw(); say(`Linked ${wireText(A, B)}. Ctrl+Z undoes it.`);
  }
  function removeWire(k) {
    const e = S.edges.find((x) => x.kind === "wire" && wkey(x) === k); if (!e) return;
    const before = snap(), A = byId(e.a), B = byId(e.b);
    S.edges = S.edges.filter((x) => x !== e); selWire = null;
    push(`Remove link ${short(A.label, 14)} and ${short(B.label, 14)}`, before); draw(); say(`Removed the link ${wireText(A, B)}. Ctrl+Z brings it back.`);
  }
  function verdict(src, tgt) {
    if (!tgt) return null;
    if (src.type !== tgt.type) return { ok: false, text: `A ${NOUN[src.type]} can only merge with another ${NOUN[src.type]}` };
    return { ok: true, text: src.type === "dump" ? `Combine “${short(src.label)}” and “${short(tgt.label)}” into one note` : `Merge “${short(src.label)}” into “${short(tgt.label)}”` };
  }
  function doMerge(src, tgt) {
    const before = snap();
    S.edges = S.edges.map((e) => ({ ...e, a: e.a === src.id ? tgt.id : e.a, b: e.b === src.id ? tgt.id : e.b })).filter((e) => e.a !== e.b);
    const seen = new Set(); S.edges = S.edges.filter((e) => { const k = e.kind + pairKey(e.a, e.b); return seen.has(k) ? false : (seen.add(k), true); });
    tgt.mentions = (tgt.mentions || 0) + (src.mentions || 0); S.nodes = S.nodes.filter((n) => n !== src); hover = null; sel = null;
    push(src.type === "dump" ? `Combine “${short(src.label, 16)}” and “${short(tgt.label, 16)}”` : `Merge “${short(src.label, 16)}” into “${short(tgt.label, 16)}”`, before);
    draw(); say(src.type === "dump" ? `Combined two notes into “${short(tgt.label)}”. Ctrl+Z to undo` : `Merged “${short(src.label)}” into “${short(tgt.label)}”. Ctrl+Z to undo`, true);
  }

  svg.addEventListener("pointerdown", (e) => {
    const p = pt(e), n = hit(p);
    if (mode === "link") {
      if (n) { link = { from: n, pt: p, ok: true }; svg.setPointerCapture(e.pointerId); selWire = null; } else { const w = wireAt(p); selWire = w ? wkey(w) : null; }
    } else if (n) { drag = { node: n, pt: p, start: p, moved: false, ok: true }; svg.setPointerCapture(e.pointerId); }
    else if (mode === "select") sel = null;
    hideTip(); draw();
  });
  svg.addEventListener("pointermove", (e) => {
    const p = pt(e);
    if (link) { link.pt = p; link.target = hit(p, link.from); link.ok = !!link.target; draw(); return; }
    if (drag) {
      drag.pt = p; if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
      if (mode === "merge") { drag.target = hit(p, drag.node); const v = verdict(drag.node, drag.target); drag.ok = v ? v.ok : true; mtip(v ? v.text : drag.moved ? `Drop on another ${NOUN[drag.node.type]} to merge` : "", p, v && !v.ok); }
      draw(); return;
    }
    const n = hit(p); if ((n ? n.id : null) !== hover) { hover = n ? n.id : null; draw(); }
  });
  const end = (e) => {
    const p = pt(e);
    if (link) { const from = link.from, to = hit(p, from); link = null; draw(); if (to) makeWire(from, to); return; }
    if (!drag) return;
    const d = drag; drag = null; mtip("");
    if (mode === "merge") { const tgt = hit(p, d.node), v = verdict(d.node, tgt); if (v && v.ok && d.moved) doMerge(d.node, tgt); else draw(); return; }
    if (!d.moved) sel = d.node.id; else { d.node.x = Math.max(12, Math.min(W - 12, p.x)) / W; d.node.y = Math.max(12, Math.min(MAP_H - 12, p.y)) / MAP_H; }
    draw();
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", () => { link = null; drag = null; mtip(""); draw(); });
  svg.addEventListener("pointerleave", () => { if (!drag && !link && hover) { hover = null; draw(); } });

  // keyboard: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Delete on a selected wire, Esc
  const onKey = (e) => {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && mode === "link" && selWire) { e.preventDefault(); removeWire(selWire); }
    else if (e.key === "Escape" && helpOpen) { e.preventDefault(); e.stopPropagation(); closeHelp(); }
    else if (e.key === "Escape" && mode !== "select") { e.preventDefault(); setMode("select"); }
  };
  document.addEventListener("keydown", onKey, true);

  // "Show me": the same thing a viewer would do, played back
  const show = $q("#t-show");
  if (show) show.onclick = () => {
    show.disabled = true;
    const done = () => { show.disabled = false; };
    const run = (A, B, finish) => { let i = 0; const a0 = px(A), b0 = px(B); const step = () => { i++; const f = i / 14, p = { x: a0.x + (b0.x - a0.x) * f, y: a0.y + (b0.y - a0.y) * f };
      if (mode === "link") { link = { from: A, pt: p, target: i > 12 ? B : null, ok: true }; } else { drag = { node: A, pt: p, start: a0, moved: true, ok: true, target: i > 12 ? B : null }; mtip(i > 12 ? verdict(A, B).text : "", p); }
      draw(); if (i < 14) t.later(step, 45); else t.later(() => { link = null; drag = null; mtip(""); draw(); finish(); done(); }, 350); }; step(); };
    if (mode === "link") run(byId("d2"), byId("c1"), () => { if (byId("d2") && byId("c1")) makeWire(byId("d2"), byId("c1")); });
    else { const a = byId("c2"), b = byId("c1"); if (a && b) run(a, b, () => doMerge(a, b)); else { undo(); done(); } }
  };

  sizeMap(); paintRibbon(); draw();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { const w = Math.round(svg.getBoundingClientRect().width); if (w && w !== W) { sizeMap(); draw(); } }) : null;
  if (ro) ro.observe(svg);
  return () => { if (ro) ro.disconnect(); document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); clearTimeout(tipTimer); clearTimeout(say.t); };
}

export const SCENES = {
  graph: { mount: (view, t, nav) => mountGraph(view, t, nav, { tab: "view", mode: "select" }) },
  "graph-ribbon": { mount: (view, t, nav) => mountGraph(view, t, nav, { tab: "view", mode: "select",
    info: (mode, n) => `<span class="small muted">Click a tab. Hover a button and wait a moment for its tip. Press the round <b>?</b> for a plain-English guide to the tab you are on.</span>` }) },
  "graph-link": { mount: (view, t, nav) => mountGraph(view, t, nav, { tab: "edit", mode: "link", seedWire: true, show: true,
    info: (mode, n) => `<span class="small muted">${mode === "link" ? "Drag from a dot to another dot. The bright wire between <b>hiking</b> and <b>home lab</b> is already there: click it, then press <kbd>Delete</kbd>. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes." : "Press <b>Link</b> on the Edit tab to draw wires again."}</span>` }) },
  "graph-merge": { mount: (view, t, nav) => mountGraph(view, t, nav, { tab: "edit", mode: "merge", show: true,
    info: (mode) => `<span class="small muted">${mode === "merge" ? "Drag <b>internships</b> onto <b>Internship</b> and let go. Both spellings become one concept. Nothing asks you to confirm, so press <kbd>Ctrl</kbd>+<kbd>Z</kbd> (or Undo) to take it back." : "Press <b>Merge</b> on the Edit tab, then drag one dot onto another."}</span>` }) },
};
