// The tutorial: a replica of the app you can poke at, one short card per idea. The script (titles, copy, what each card
// mirrors) is tour-steps.js; the mock screens are tour-scenes.js, tour-templates.js and tour-graph.js. Nothing here calls
// the API, so the tour never creates dumps, tasks or history. After any app change, walk it: docs/TUTORIAL-CHECKLIST.md.
import { $, $$, esc, ICONS } from "./ui.js";
import { NAV } from "./shell.js";
import { STEPS, SCREENS, firstStepOf } from "./tour-steps.js";
import { SCENES as BASE } from "./tour-scenes.js";
import { SCENES as TEMPLATES } from "./tour-templates.js";
import { SCENES as GRAPH } from "./tour-graph.js";

const SCENES = { ...BASE, ...TEMPLATES, ...GRAPH };
const labelOf = (id) => (NAV.find((n) => n.id === id) || { label: id[0].toUpperCase() + id.slice(1) }).label;

// runTour(el, finish, start): draws the tour into el; finish() is called on Skip / Get started. `start` is a card id or a screen id.
export function runTour(el, finish, start = "capture") {
  let i = Math.max(0, STEPS.findIndex((s) => s.id === start || s.screen === start)), timers = [], cleanup = null;
  const t = { later: (fn, ms) => timers.push(setTimeout(fn, ms)), clear: () => { timers.forEach(clearTimeout); timers = []; } };
  const teardown = () => { t.clear(); if (cleanup) { try { cleanup(); } catch { /* a mock that is already gone */ } cleanup = null; } };
  const done = () => { teardown(); document.removeEventListener("keydown", onKey); finish(); };
  const go = (n) => { i = Math.max(0, Math.min(STEPS.length - 1, n)); draw(); };
  const nav = { next: () => go(i + 1), back: () => go(i - 1) };
  // Left / Right arrows turn the cards, unless you are typing or a mock owns the key.
  function onKey(e) {
    if (!el.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]"))) return;
    if (e.key === "ArrowRight") nav.next(); else if (e.key === "ArrowLeft") nav.back();
  }
  document.addEventListener("keydown", onKey);

  function draw() {
    teardown();
    const st = STEPS[i], last = i === STEPS.length - 1;
    const sc = SCENES[st.id] || { mount(v) { v.innerHTML = `<p class="muted">This card has no demo yet.</p>`; } };
    el.innerHTML = `<div class="tour">
      <div class="tour-head"><h1>${esc(st.title)}</h1><p class="sub">${esc(st.blurb)}</p></div>
      <div class="tour-app"><nav class="tour-rail" aria-label="Tutorial sections">${SCREENS.map((id) => `<a href="#" data-id="${id}" class="${id === st.screen ? "active" : ""}" title="${labelOf(id)}">${ICONS[id]}<span>${labelOf(id)}</span></a>`).join("")}</nav>
        <div class="tour-view" id="tour-view"></div></div>
      <p class="tour-tip">👆 ${esc(st.tip)}</p>
      <div class="ob-dots" aria-hidden="true">${STEPS.map((s, n) => `<i class="${n === i ? "on" : ""} ${s.screen === st.screen ? "same" : ""}"></i>`).join("")}</div>
      <p class="tour-count small muted" aria-live="polite">Card ${i + 1} of ${STEPS.length}</p>
      <div class="ob-foot"><button class="btn ghost" id="ob-back" ${i === 0 ? "disabled" : ""}>Back</button><div class="grow"></div>
        <button class="btn ghost small" id="ob-skip">Skip tutorial</button><div class="grow"></div>
        <button class="btn" id="ob-next">${last ? "Get started" : "Next"}</button></div></div>`;
    cleanup = sc.mount($("#tour-view", el), t, nav) || null;
    $("#ob-skip", el).onclick = done;
    $("#ob-back", el).onclick = nav.back;
    $("#ob-next", el).onclick = () => (last ? done() : nav.next());
    $$(".tour-rail a", el).forEach((a) => a.onclick = (e) => { e.preventDefault(); go(firstStepOf(a.dataset.id)); });
    el.scrollTop = 0;
  }
  draw();
}
