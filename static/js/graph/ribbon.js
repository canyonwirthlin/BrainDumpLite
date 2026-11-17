// The Brain map ribbon: a tab strip (View, Layout, Overlays, Filter, Edit, Tools) above one compact row of tools,
// like the ribbon in Office or Roblox Studio. It draws whatever is registered in graph/toolbar.js, so a feature adds a
// button by calling registerTool() from its own file and never touches this one.
//
// HOW TO ADD A TOOL (full contract: the header of toolbar.js)
//   import { registerTool } from "./toolbar.js";
//   registerTool({ tab: "tools", id: "my-tool", label: "My tool", icon: "<svg ...>", order: 50, group: "mine",
//     tip: "One plain sentence shown on hover and focus.", help: "One to three sentences shown in the tab's ? panel.",
//     kind: "toggle", run() { ... }, isActive() { ... }, isEnabled() { ... } });
//   kinds: "button" (run once), "toggle" (run flips a setting, isActive says whether it is on), "mode" (exclusive, see
//   setMode in toolbar.js), "custom" (mount(el, { api, state }) fills the slot itself; optional update(el, ctx) runs on
//   every refresh so a slider can follow its pref without being rebuilt).
//   Extras this ribbon understands: `group` (a thin divider is drawn wherever the group changes), `key` (shortcut shown in
//   the tooltip), `domId` (id given to the button), and `label` / `icon` / `tip` may be functions or may be changed on the
//   registered object followed by notifyToolbar(): they are re-read on every refresh (Undo's "Undo: Link A to B").
//
// WHAT THE RIBBON DOES
//   * Tabs come from TABS, tools from toolsFor(tab). The active tab is remembered in localStorage (bdl-graph-ribbon-tab).
//   * Active modes and active toggles look pressed, disabled tools are dimmed (aria-disabled, still focusable so their
//     tooltip explains them). Everything re-reads isActive / isEnabled after notifyToolbar() (onToolbarChange).
//   * Every tool has a styled tooltip (its tip) that shows on hover and on keyboard focus, not the native title.
//     Icon-only tools get the tip as their aria-label.
//   * The "?" button at the right end of the tab strip opens a panel with the tab's help text and each tool's name and
//     help. Esc or a click anywhere else closes it.
//   * The status area next to it shows the live node count ("Showing X of Y nodes"): mountRibbon(...).setStatus(text).
//   * Custom tools that other modules fill (Export, Keyboard shortcuts) render an empty mount point (#graph-slot-export,
//     #graph-slot-keys) and the ribbon then fires window event "bdl-graph-panel-rendered" after EVERY tool-row render, so
//     those modules can (re)mount into it. A slot exists only while its tab is the active one.
//   * Narrow windows: the tool row scrolls sideways (edge arrows appear) instead of growing taller.
// The migrated built-in tools live in ribbon-tools.js (View, Layout, Overlays, Edit/Select, Tools) and ribbon-filters.js.
import { esc } from "../ui.js";
import { TABS, toolsFor, onToolbarChange, getMode, setMode } from "./toolbar.js";
import { val, toolName, pickTab, buildRow, tabSignature, helpModel, placeTip, nextTabIndex } from "./ribbon-model.js";
import { syncRegistryTools } from "./ribbon-tools.js";
import "./ribbon-filters.js";

const KEY_TAB = "bdl-graph-ribbon-tab";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the ribbon just forgets the tab */ } },
};

/** An svg string is used as is; anything else (an emoji) is text. */
const iconHtml = (icon) => (typeof icon === "string" && icon.trimStart().startsWith("<svg") ? icon : `<span class="gr-emoji">${esc(icon || "")}</span>`);

let live = null;   // the ribbon of the current visit; a new visit replaces it (and its listeners)

/** Draw the ribbon into `host`. Returns { setStatus(text), rerender(), setTab(id), destroy() }. */
export function mountRibbon(host, ctx) {
  live?.destroy();
  syncRegistryTools();
  let tabId = pickTab(store.get(KEY_TAB), TABS);
  let sig = "";
  const offs = [];
  const customs = new Map();   // tool id -> element, for update()
  const buttons = new Map();   // tool id -> { el, tool }

  host.innerHTML = `<div class="gr" id="graph-ribbon">
    <div class="gr-top">
      <div class="gr-tabs" role="tablist" aria-label="Map toolbar tabs"></div>
      <span class="gr-status" id="graph-count" aria-live="polite"></span>
      <button type="button" class="gr-help-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="gr-help"><span aria-hidden="true">?</span></button>
    </div>
    <div class="gr-rowwrap">
      <button type="button" class="gr-nav gr-nav-l" aria-label="Scroll the tools left" tabindex="-1" hidden><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button>
      <div class="gr-row" role="tabpanel" id="gr-panel"><div class="gr-tools" role="toolbar"></div></div>
      <button type="button" class="gr-nav gr-nav-r" aria-label="Scroll the tools right" tabindex="-1" hidden><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
    </div>
    <div class="gr-tip" id="gr-tip" role="tooltip" hidden></div>
    <div class="gr-help" id="gr-help" role="dialog" tabindex="-1" hidden></div>
  </div>`;
  const root = host.firstElementChild;
  const q = (s) => root.querySelector(s);
  const tabsEl = q(".gr-tabs"), statusEl = q(".gr-status"), helpBtn = q(".gr-help-btn");
  const row = q(".gr-row"), tools = q(".gr-tools"), tip = q("#gr-tip"), help = q("#gr-help");
  const navL = q(".gr-nav-l"), navR = q(".gr-nav-r");

  const tabLabel = () => (TABS.find((t) => t.id === tabId) || {}).label || "";

  // ── tabs ──────────────────────────────────────────────────────────────────────────────────
  tabsEl.innerHTML = TABS.map((t) => `<button type="button" role="tab" class="gr-tab" id="gr-tab-${esc(t.id)}" data-tab="${esc(t.id)}" aria-controls="gr-panel">${esc(t.label)}</button>`).join("");
  const tabBtns = [...tabsEl.children];
  function paintTabs() {
    tabBtns.forEach((b) => {
      const on = b.dataset.tab === tabId;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    row.setAttribute("aria-labelledby", "gr-tab-" + tabId);
    tools.setAttribute("aria-label", `${tabLabel()} tools`);
    helpBtn.setAttribute("aria-label", `Help for the ${tabLabel()} tab`);
    helpBtn.dataset.tip = `Explains the tools on the ${tabLabel()} tab`;
  }
  function setTab(id, focus = false) {
    if (!TABS.some((t) => t.id === id)) return;
    hideTip();
    tabId = id;
    store.set(KEY_TAB, id);
    paintTabs();
    renderRow();
    if (!help.hidden) paintHelp();
    if (focus) tabBtns.find((b) => b.dataset.tab === id)?.focus();
  }
  tabBtns.forEach((b, i) => {
    b.onclick = () => setTab(b.dataset.tab);
    b.onkeydown = (e) => {
      const n = nextTabIndex(e.key, i, tabBtns.length);
      if (n < 0) return;
      e.preventDefault();
      setTab(tabBtns[n].dataset.tab, true);
    };
  });

  // ── tools ─────────────────────────────────────────────────────────────────────────────────
  const isOn = (t) => (t.kind === "mode" ? getMode() === t.id : !!(t.isActive && t.isActive()));
  const isEnabled = (t) => (t.isEnabled ? !!t.isEnabled() : true);

  function paintButton(el, t) {
    const label = String(val(t.label) || ""), icon = val(t.icon), tipText = String(val(t.tip) || ""), key = val(t.key) || "";
    const html = `${iconHtml(icon)}|${label}`;
    if (el.dataset.sig !== html) {
      el.dataset.sig = html;
      el.innerHTML = `<span class="gr-ico" aria-hidden="true">${iconHtml(icon)}</span>${label ? `<span class="gr-lbl">${esc(label)}</span>` : ""}`;
    }
    el.dataset.tip = tipText;
    if (key) el.dataset.key = key; else delete el.dataset.key;
    const on = isOn(t), off = !isEnabled(t);
    el.classList.toggle("on", on);
    el.classList.toggle("is-disabled", off);
    el.setAttribute("aria-disabled", String(off));
    if (t.kind === "button" && !t.isActive) el.removeAttribute("aria-pressed"); else el.setAttribute("aria-pressed", String(on));
    if (!label) el.setAttribute("aria-label", tipText || t.id); else el.removeAttribute("aria-label");
  }
  function makeButton(t) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "gr-btn" + (t.kind === "mode" ? " gr-mode" : "");
    el.dataset.tool = t.id;
    if (t.domId) el.id = t.domId;
    el.onclick = () => activate(t);
    paintButton(el, t);
    buttons.set(t.id, { el, tool: t });
    return el;
  }
  function activate(t) {
    if (!isEnabled(t)) return;
    if (t.kind === "mode") { setMode(t.id); return; }
    let r;
    try { r = t.run && t.run(ctx); } catch (e) { console.warn("graph tool", t.id, e); }
    Promise.resolve(r).catch((e) => console.warn("graph tool", t.id, e)).finally(refresh);   // run() may be async
  }
  function makeCustom(t) {
    const el = document.createElement("div");
    el.className = "gr-item";
    el.dataset.tool = t.id;
    const label = String(val(t.label) || "");
    el.dataset.tip = String(val(t.tip) || "");
    if (val(t.key)) el.dataset.key = val(t.key);
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", label || String(val(t.tip) || t.id));
    customs.set(t.id, { el, tool: t });
    return el;
  }

  function renderRow() {
    syncRegistryTools();
    const list = toolsFor(tabId);
    sig = tabSignature(list);
    tools.textContent = "";
    customs.clear(); buttons.clear();
    const mounts = [];
    for (const entry of buildRow(list)) {
      if (entry.type === "divider") {
        const d = document.createElement("i");
        d.className = "gr-div"; d.setAttribute("role", "separator"); d.setAttribute("aria-orientation", "vertical");
        tools.appendChild(d);
      } else if (entry.tool.kind === "custom") {
        const el = makeCustom(entry.tool);
        tools.appendChild(el);
        mounts.push([entry.tool, el]);
      } else tools.appendChild(makeButton(entry.tool));
    }
    if (!list.length) tools.innerHTML = `<span class="gr-empty">Nothing on this tab yet.</span>`;
    // custom tools fill their slot once it is in the document (find.js and friends look elements up by id)
    for (const [t, el] of mounts) { try { t.mount && t.mount(el, ctx); } catch (e) { console.warn("graph tool", t.id, e); } }
    row.scrollLeft = 0;
    paintAll();
    updateNav();
    window.dispatchEvent(new CustomEvent("bdl-graph-panel-rendered"));
  }
  function paintAll() {
    buttons.forEach(({ el, tool }) => paintButton(el, tool));
    customs.forEach(({ el, tool }) => {
      el.dataset.tip = String(val(tool.tip) || "");
      try { tool.update && tool.update(el, ctx); } catch (e) { console.warn("graph tool", tool.id, e); }
    });
  }
  function refresh() {
    if (!root.isConnected) { destroy(); return; }
    syncRegistryTools();
    if (tabSignature(toolsFor(tabId)) !== sig) renderRow(); else paintAll();
  }
  offs.push(onToolbarChange(refresh));

  // ── sideways scrolling on narrow windows ──────────────────────────────────────────────────
  function updateNav() {
    const max = row.scrollWidth - row.clientWidth;
    navL.hidden = !(max > 2 && row.scrollLeft > 2);
    navR.hidden = !(max > 2 && row.scrollLeft < max - 2);
  }
  row.addEventListener("scroll", updateNav, { passive: true });
  row.addEventListener("wheel", (e) => {
    if (row.scrollWidth <= row.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    row.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  navL.onclick = () => row.scrollBy({ left: -row.clientWidth * 0.6, behavior: "smooth" });
  navR.onclick = () => row.scrollBy({ left: row.clientWidth * 0.6, behavior: "smooth" });
  if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(updateNav); ro.observe(row); offs.push(() => ro.disconnect()); }
  row.addEventListener("focusin", (e) => e.target.scrollIntoView?.({ block: "nearest", inline: "nearest" }));

  // ── tooltips (hover with a short delay, keyboard focus at once) ───────────────────────────
  let tipFor = null, tipTimer = 0, tipWarm = false, warmTimer = 0;
  function showTip(anchor) {
    const text = anchor.dataset.tip;
    if (!text) return;
    tipFor = anchor;
    tip.innerHTML = `<span>${esc(text)}</span>${anchor.dataset.key ? `<kbd>${esc(anchor.dataset.key)}</kbd>` : ""}`;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const p = placeTip(r, { w: tip.offsetWidth, h: tip.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    tip.style.left = p.left + "px"; tip.style.top = p.top + "px";
    tip.dataset.side = p.side;
    anchor.setAttribute("aria-describedby", "gr-tip");
    tipWarm = true; clearTimeout(warmTimer);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipFor) { tipFor.removeAttribute("aria-describedby"); tipFor = null; warmTimer = setTimeout(() => { tipWarm = false; }, 500); }
    tip.hidden = true;
  }
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const a = e.target.closest("[data-tip]");
    if (a === tipFor || (!a && tip.hidden)) return;
    hideTip();
    if (a && root.contains(a) && !a.closest(".gr-help")) tipTimer = setTimeout(() => showTip(a), tipWarm ? 60 : 420);
  });
  root.addEventListener("pointerleave", hideTip);
  root.addEventListener("pointerdown", hideTip);
  root.addEventListener("focusin", (e) => {
    const a = e.target.closest("[data-tip]");
    if (a && !a.closest(".gr-help") && e.target.matches(":focus-visible")) { hideTip(); showTip(a); }
  });
  root.addEventListener("focusout", hideTip);
  row.addEventListener("scroll", hideTip, { passive: true });

  // ── the "?" panel ─────────────────────────────────────────────────────────────────────────
  function paintHelp() {
    const m = helpModel(TABS.find((t) => t.id === tabId) || { label: "", help: "" }, toolsFor(tabId));
    help.setAttribute("aria-label", m.title);
    help.innerHTML = `<div class="gr-help-h"><h3>${esc(m.title)}</h3><button type="button" class="gr-help-x" aria-label="Close help">×</button></div>
      ${m.intro ? `<p class="gr-help-intro">${esc(m.intro)}</p>` : ""}
      <dl class="gr-help-list">${m.items.map((i) => `<div class="gr-help-item"><dt>${esc(i.name)}${i.key ? ` <kbd>${esc(i.key)}</kbd>` : ""}</dt><dd>${esc(i.help)}</dd></div>`).join("")}</dl>`;
    help.querySelector(".gr-help-x").onclick = () => closeHelp(true);
  }
  function openHelp() {
    hideTip();
    paintHelp();
    help.hidden = false;
    helpBtn.setAttribute("aria-expanded", "true");
    help.focus({ preventScroll: true });
  }
  function closeHelp(refocus = false) {
    if (help.hidden) return;
    help.hidden = true;
    helpBtn.setAttribute("aria-expanded", "false");
    if (refocus) helpBtn.focus();
  }
  helpBtn.onclick = () => (help.hidden ? openHelp() : closeHelp(true));
  const onDocKey = (e) => {
    if (e.key === "Escape" && !help.hidden) { e.preventDefault(); e.stopPropagation(); closeHelp(true); }
    else if (e.key === "Escape" && !tip.hidden) hideTip();
  };
  const onDocDown = (e) => { if (!help.hidden && !help.contains(e.target) && !helpBtn.contains(e.target)) closeHelp(); };
  document.addEventListener("keydown", onDocKey, true);
  document.addEventListener("pointerdown", onDocDown, true);
  offs.push(() => { document.removeEventListener("keydown", onDocKey, true); document.removeEventListener("pointerdown", onDocDown, true); });

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────
  function destroy() { offs.splice(0).forEach((f) => { try { f(); } catch { /* already gone */ } }); if (live === me) live = null; }
  const me = {
    setStatus(text) { statusEl.textContent = text || ""; },
    rerender() { paintTabs(); renderRow(); if (!help.hidden) paintHelp(); },
    setTab,
    destroy,
    get tab() { return tabId; },
  };
  live = me;
  paintTabs();
  renderRow();
  return me;
}
