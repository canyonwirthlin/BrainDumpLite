// Dump templates UI: the Capture picker (pinned buttons + searchable "Templates" popover) and the
// manager (list on the left, editor on the right) used from the popover and from Settings.
import { $, $$, esc, modal, toast } from "./ui.js";
import {
  LIMITS, getDoc, loadDoc, saveDoc, onTemplatesChanged, resolveTemplates, builtinDefault, newTemplateId, applyTemplate,
  withPin, withMoveNear, withSaved, withDeleted, withRestoredDefault, withRestoredBuiltins, noteUsed, pickerOrder,
} from "./templates.js";

const GROUP_LABEL = { pinned: "Pinned", recent: "Recently used", all: "All templates" };
const preview = (text) => text.replace(/\s+/g, " ").trim().slice(0, 90);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ── Capture: pinned buttons + popover ────────────────────────────────────────

let activePicker = null;

// Fills `row` with the pinned template buttons and a "Templates ▾" button. `ta` is the writing box;
// `onApplied(text)` is told the new contents (so the caller can keep its draft in sync).
export function mountTemplatePicker(row, { ta, onApplied }) {
  if (activePicker) activePicker.destroy();
  row.innerHTML = `<span class="muted small tpl-label">Template:</span><div class="tpl-pins"></div>
    <button type="button" class="btn ghost small tpl-more" aria-haspopup="dialog" aria-expanded="false" title="Search all your templates">Templates ▾</button>`;
  const pinsEl = $(".tpl-pins", row), moreBtn = $(".tpl-more", row);
  let pop = null, query = "", activeId = null, shown = [];

  const paintPins = () => {
    const pins = resolveTemplates().filter((t) => t.pinned).slice(0, LIMITS.visiblePins);
    pinsEl.innerHTML = pins.map((t) => `<button type="button" class="btn ghost small tpl-btn" data-tpl="${esc(t.id)}" title="${esc(t.label)}">${esc(t.label)}</button>`).join("");
    $$(".tpl-btn", pinsEl).forEach((b) => { b.onclick = () => use(b.dataset.tpl); });
    fit();
  };
  // One line, always: hide pinned buttons from the end until the rest fit (they stay in the popover).
  const fit = () => {
    const btns = $$(".tpl-btn", pinsEl);
    btns.forEach((b) => { b.hidden = false; });
    for (let i = btns.length - 1; i > 0 && pinsEl.scrollWidth > pinsEl.clientWidth + 1; i--) btns[i].hidden = true;
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => fit()) : null;
  if (ro) ro.observe(pinsEl);

  // Using a template keeps the old behaviour: a non-empty box is only cleared after a confirmation.
  function use(id) {
    const tpl = resolveTemplates().find((t) => t.id === id);
    if (!tpl) return;
    closePop();
    const apply = () => { noteUsed(tpl.id); onApplied(applyTemplate(ta, tpl)); };
    if (!ta.value.trim()) { apply(); return; }
    const m = modal(`<h2>Replace what you've written?</h2>
      <p class="small muted" style="margin:0 0 14px">Using the ${esc(tpl.label)} template clears the box first.</p>
      <div class="row"><div class="grow"></div>
        <button class="btn ghost small" id="tpl-no">Cancel</button><button class="btn small" id="tpl-yes">Yes, clear it</button></div>`);
    $("#tpl-no", m.el).onclick = m.close;
    $("#tpl-yes", m.el).onclick = () => { m.close(); apply(); };
  }

  async function togglePin(id) {
    const t = resolveTemplates().find((x) => x.id === id);
    if (!t) return;
    try { await saveDoc(withPin(getDoc(), id, !t.pinned)); }
    catch (e) { toast("Couldn't save: " + e.message, true); }
  }

  // ── popover ──
  const rankOf = (t, q) => (t.label.toLowerCase().startsWith(q) ? 0 : t.label.toLowerCase().includes(q) ? 1 : 2);
  function paintList() {
    if (!pop) return;
    const all = pickerOrder(resolveTemplates());
    const q = query.trim().toLowerCase();
    shown = q
      ? all.filter((t) => `${t.label}\n${t.text}`.toLowerCase().includes(q)).map((t, i) => ({ t, i })).sort((a, b) => rankOf(a.t, q) - rankOf(b.t, q) || a.i - b.i).map((x) => x.t)
      : all;
    if (!shown.some((t) => t.id === activeId)) activeId = shown[0] ? shown[0].id : null;
    const search = $(".tp-search", pop);
    search.placeholder = `Search ${plural(all.length, "template")}…`;
    const groups = new Set(shown.map((t) => t.group));
    let last = "", html = "";
    for (const t of shown) {
      if (!q && groups.size > 1 && t.group !== last) { html += `<div class="tp-sec">${GROUP_LABEL[t.group]}</div>`; last = t.group; }
      html += `<div class="tp-row ${t.id === activeId ? "active" : ""}" role="option" id="tp-o-${esc(t.id)}" data-id="${esc(t.id)}" aria-selected="${t.id === activeId}">
        <button type="button" class="tp-star ${t.pinned ? "on" : ""}" tabindex="-1" aria-pressed="${t.pinned}" title="${t.pinned ? "Unpin from the Capture screen" : "Pin to the Capture screen"}" aria-label="${t.pinned ? "Unpin" : "Pin"} ${esc(t.label)}">${t.pinned ? "★" : "☆"}</button>
        <div class="tp-main"><span class="tp-name">${esc(t.label)}</span><span class="tp-prev">${esc(preview(t.text))}</span></div></div>`;
    }
    const list = $(".tp-list", pop), top = list.scrollTop;
    list.innerHTML = html || `<div class="tp-empty">${q ? `No template matches “${esc(query.trim())}”.` : "No templates yet."} <button type="button" class="tp-link tp-newhere">Make one…</button></div>`;
    list.scrollTop = top;
    search.setAttribute("aria-activedescendant", activeId ? "tp-o-" + activeId : "");
    $$(".tp-row", list).forEach((r) => {
      r.onclick = () => use(r.dataset.id);
      r.onmousemove = () => { if (activeId !== r.dataset.id) setActive(r.dataset.id, false); };
      $(".tp-star", r).onclick = (e) => { e.stopPropagation(); togglePin(r.dataset.id); };
    });
    const nh = $(".tp-newhere", list);
    if (nh) nh.onclick = () => { closePop(); openTemplateManager({ newDraft: { label: query.trim().slice(0, LIMITS.label), text: "" } }); };
  }

  function setActive(id, scroll = true) {
    activeId = id;
    $$(".tp-row", pop).forEach((r) => {
      const on = r.dataset.id === id;
      r.classList.toggle("active", on); r.setAttribute("aria-selected", on);
      if (on && scroll) r.scrollIntoView({ block: "nearest" });
    });
    $(".tp-search", pop).setAttribute("aria-activedescendant", id ? "tp-o-" + id : "");
  }

  function position() {
    if (!pop) return;
    const r = moreBtn.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(440, vw - 24);
    const left = Math.max(12, Math.min(vw - w - 12, r.right - w));
    const below = vh - r.bottom - 12, above = r.top - 12;
    const down = below >= 300 || below >= above;
    const room = Math.max(160, (down ? below : above) - 6);
    pop.style.width = w + "px"; pop.style.left = left + "px";
    pop.style.maxHeight = Math.min(480, room) + "px";
    if (down) { pop.style.top = r.bottom + 6 + "px"; pop.style.bottom = "auto"; }
    else { pop.style.bottom = vh - r.top + 6 + "px"; pop.style.top = "auto"; }
  }

  const onDocPointer = (e) => { if (pop && !pop.contains(e.target) && !moreBtn.contains(e.target)) closePop(); };
  const onDocFocus = (e) => { if (pop && !pop.contains(e.target) && !moreBtn.contains(e.target)) closePop(); };
  const onWin = () => position();

  function openPop() {
    if (pop) { closePop(); return; }
    query = ""; activeId = null;
    pop = document.createElement("div");
    pop.className = "tpl-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Choose a template");
    pop.innerHTML = `<input type="text" class="tp-search" role="combobox" aria-expanded="true" aria-controls="tp-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" aria-label="Search templates">
      <div class="tp-list" id="tp-list" role="listbox" aria-label="Templates"></div>
      <div class="tp-foot"><span class="tp-keys">↑↓ choose · Enter use · Shift+Enter pin</span><button type="button" class="tp-link tp-manage">Manage templates…</button></div>`;
    document.body.appendChild(pop);
    moreBtn.setAttribute("aria-expanded", "true");
    paintList(); position();
    const search = $(".tp-search", pop);
    search.focus();
    search.oninput = () => { query = search.value; paintList(); };
    search.onkeydown = (e) => {
      const i = shown.findIndex((t) => t.id === activeId);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        const n = e.key === "ArrowDown" ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1);
        setActive(shown[n].id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeId) { if (e.shiftKey) togglePin(activeId); else use(activeId); }
      } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(true); }
    };
    $(".tp-manage", pop).onclick = () => { closePop(); openTemplateManager(); };
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("focusin", onDocFocus, true);
    window.addEventListener("resize", onWin);
  }

  function closePop(refocus = false) {
    if (!pop) return;
    pop.remove(); pop = null;
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("focusin", onDocFocus, true);
    window.removeEventListener("resize", onWin);
    if (refocus) moreBtn.focus();
  }

  moreBtn.onclick = openPop;
  const off = onTemplatesChanged(() => {
    if (!row.isConnected) { api.destroy(); return; }
    paintPins(); paintList();
  });
  const api = { destroy() { closePop(); off(); if (ro) ro.disconnect(); if (activePicker === api) activePicker = null; } };
  activePicker = api;
  paintPins();
  loadDoc();      // first visit: fetch the user's changes; onTemplatesChanged repaints
  return api;
}

// ── Manager ──────────────────────────────────────────────────────────────────

// Mounts the manager into `box`. Returns {isDirty, guard(fn)}; guard runs fn now, or after the user
// agrees to discard unsaved edits.
export function mountTemplateManager(box, opts = {}) {
  const st = { sel: null, isNew: false, dupOf: null, query: "", draft: { label: "", text: "" }, focusAfter: null };
  box.innerHTML = `<div class="tm">
    <p class="tm-intro">Templates are ready-made starting points for a dump. Pin your favourites to show them as buttons on the Capture screen; the rest stay one search away under “Templates”. Edit the built-in ones, delete what you don't use, or write your own.</p>
    <div class="tm-body">
      <section class="tm-list" aria-label="Template list">
        <div class="tm-list-head">
          <input type="text" class="tm-search" placeholder="Search templates…" aria-label="Search templates" spellcheck="false" autocomplete="off">
          <button type="button" class="btn small tm-new">+ New template</button>
        </div>
        <div class="small muted tm-count-line" aria-live="polite"></div>
        <ul class="tm-items"></ul>
        <div class="tm-restore" hidden><button type="button" class="btn ghost small tm-restore-btn"></button></div>
      </section>
      <section class="tm-editor" aria-label="Template editor"></section>
    </div></div>`;
  const listEl = $(".tm-items", box), editor = $(".tm-editor", box);

  const list = () => resolveTemplates();
  const current = () => list().find((t) => t.id === st.sel) || null;
  const saved = () => { const c = current(); return st.isNew || !c ? { label: "", text: "" } : { label: c.label, text: c.text }; };
  const isDirty = () => { const s = saved(); return st.draft.label.trim() !== s.label.trim() || st.draft.text !== s.text; };
  const deletedBuiltins = () => getDoc().deleted.filter((id) => builtinDefault(id));

  function guard(fn) {
    if (!isDirty() || !$(".tm-confirm", editor)) return fn();
    const nm = st.draft.label.trim();
    ask(`You have unsaved changes${nm ? ` to “${nm}”` : ""}. Leave without saving?`, "Discard changes", fn, { no: "Keep editing" });
  }

  // ── list ──
  function paintList() {
    const all = list(), q = st.query.trim().toLowerCase();
    const shownRows = q ? all.filter((t) => `${t.label}\n${t.text}`.toLowerCase().includes(q)) : all;
    const pins = all.filter((t) => t.pinned).length;
    $(".tm-count-line", box).textContent = q ? `${shownRows.length} of ${plural(all.length, "template")}` : `${plural(all.length, "template")} · ${pins} pinned`;
    const reorder = !q;
    const row = (t, i) => `<li class="tm-item ${t.id === st.sel && !st.isNew ? "sel" : ""}" data-id="${esc(t.id)}" ${reorder ? 'draggable="true"' : ""}>
        <button type="button" class="tm-pin ${t.pinned ? "on" : ""}" aria-pressed="${t.pinned}" title="${t.pinned ? "Unpin from the Capture screen" : "Pin to the Capture screen"}" aria-label="${t.pinned ? "Unpin" : "Pin"} ${esc(t.label)}">${t.pinned ? "★" : "☆"}</button>
        <button type="button" class="tm-pick" ${t.id === st.sel && !st.isNew ? 'aria-current="true"' : ""}><span class="tm-name">${esc(t.label)}</span>${t.builtin ? `<span class="tm-badge ${t.edited ? "edited" : ""}">${t.edited ? "edited" : "built-in"}</span>` : ""}</button>
        <span class="tm-move"><button type="button" class="tm-up" aria-label="Move ${esc(t.label)} up" title="${reorder ? "Move up" : "Clear the search to reorder"}" ${!reorder || i === 0 ? "disabled" : ""}>↑</button><button type="button" class="tm-down" aria-label="Move ${esc(t.label)} down" title="${reorder ? "Move down" : "Clear the search to reorder"}" ${!reorder || i === shownRows.length - 1 ? "disabled" : ""}>↓</button></span>
      </li>`;
    const draftRow = st.isNew ? `<li class="tm-item sel draft"><span class="tm-pin ghost" aria-hidden="true">✎</span><span class="tm-pick"><span class="tm-name">${esc(st.draft.label.trim() || "New template")}</span><span class="tm-badge">unsaved</span></span></li>` : "";
    listEl.innerHTML = draftRow + (shownRows.map(row).join("") || `<li class="tm-none small muted">${all.length ? "Nothing matches your search." : "No templates yet. Create one, or restore the built-in ones below."}</li>`);
    const n = deletedBuiltins().length;
    $(".tm-restore", box).hidden = !n;
    $(".tm-restore-btn", box).textContent = `Restore deleted built-ins (${n})`;
    if (st.focusAfter) {
      const f = $(`.tm-item[data-id="${CSS.escape(st.focusAfter.id)}"] ${st.focusAfter.sel}`, listEl);
      const tgt = f && !f.disabled ? f : $(`.tm-item[data-id="${CSS.escape(st.focusAfter.id)}"] .tm-pick`, listEl);
      if (tgt) { tgt.focus(); tgt.scrollIntoView({ block: "nearest" }); }
      st.focusAfter = null;
    }
  }

  async function persist(next, okMsg) {
    try { await saveDoc(next); if (okMsg) toast(okMsg); return true; }
    catch (e) { toast("Couldn't save: " + e.message, true); return false; }
  }

  listEl.onclick = (e) => {
    const li = e.target.closest(".tm-item");
    if (!li || !li.dataset.id) return;
    const id = li.dataset.id, ids = list().map((t) => t.id), i = ids.indexOf(id);
    if (e.target.closest(".tm-pin")) { const t = list()[i]; persist(withPin(getDoc(), id, !t.pinned)); return; }
    if (e.target.closest(".tm-up") && i > 0) { st.focusAfter = { id, sel: ".tm-up" }; persist(withMoveNear(getDoc(), id, ids[i - 1], false)); return; }
    if (e.target.closest(".tm-down") && i < ids.length - 1) { st.focusAfter = { id, sel: ".tm-down" }; persist(withMoveNear(getDoc(), id, ids[i + 1], true)); return; }
    if (e.target.closest(".tm-pick") && (id !== st.sel || st.isNew)) guard(() => select(id));
  };
  listEl.onkeydown = (e) => {
    const pick = e.target.closest(".tm-pick");
    if (!pick || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const li = pick.closest(".tm-item"), id = li.dataset.id, ids = list().map((t) => t.id), i = ids.indexOf(id);
    if (e.altKey && !st.query.trim()) {     // Alt+↑/↓ reorders from the keyboard
      const j = e.key === "ArrowUp" ? i - 1 : i + 1;
      if (j >= 0 && j < ids.length) { st.focusAfter = { id, sel: ".tm-pick" }; persist(withMoveNear(getDoc(), id, ids[j], e.key === "ArrowDown")); }
      return;
    }
    const sib = e.key === "ArrowUp" ? li.previousElementSibling : li.nextElementSibling;
    const p = sib && $(".tm-pick", sib);
    if (p) p.focus();
  };
  // Drag to reorder (only while the search box is empty).
  let dragId = null;
  const clearDrop = () => $$(".drop-before, .drop-after, .dragging", listEl).forEach((x) => x.classList.remove("drop-before", "drop-after", "dragging"));
  listEl.ondragstart = (e) => {
    const li = e.target.closest && e.target.closest(".tm-item");
    if (!li || !li.dataset.id) return;
    dragId = li.dataset.id; li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch {}
  };
  listEl.ondragover = (e) => {
    const li = e.target.closest(".tm-item");
    if (!dragId || !li || !li.dataset.id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    $$(".drop-before, .drop-after", listEl).forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (li.dataset.id !== dragId) li.classList.add(after ? "drop-after" : "drop-before");
  };
  listEl.ondrop = (e) => {
    const li = e.target.closest(".tm-item");
    if (!dragId || !li || !li.dataset.id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2, id = dragId;
    dragId = null; clearDrop();
    if (li.dataset.id !== id) persist(withMoveNear(getDoc(), id, li.dataset.id, after));
  };
  listEl.ondragend = () => { dragId = null; clearDrop(); };

  $(".tm-search", box).oninput = (e) => { st.query = e.target.value; paintList(); };
  $(".tm-new", box).onclick = () => guard(() => startNew());
  $(".tm-restore-btn", box).onclick = async () => {
    const n = deletedBuiltins().length;
    if (await persist(withRestoredBuiltins(getDoc()))) toast(`Restored ${plural(n, "built-in template")}`);
  };

  // ── editor ──
  function select(id) {
    st.sel = id; st.isNew = false;
    const c = current();
    st.draft = c ? { label: c.label, text: c.text } : { label: "", text: "" };
    paintList(); paintEditor();
    const li = $(`.tm-item[data-id="${CSS.escape(id)}"]`, listEl);
    if (li) li.scrollIntoView({ block: "nearest" });
  }
  function startNew(seed, dupOf = null) {
    if (getDoc().templates.length >= LIMITS.templates) { toast(`That's the limit: ${LIMITS.templates} of your own templates. Delete one first.`, true); return; }
    st.isNew = true; st.sel = null; st.dupOf = dupOf;
    st.draft = seed ? { label: seed.label || "", text: seed.text || "" } : { label: "", text: "" };
    paintList(); paintEditor();
    $("#tm-name", editor).focus();
  }

  function ask(msg, yes, onYes, { danger = false, no = "Cancel" } = {}) {
    const c = $(".tm-confirm", editor);
    if (!c) { onYes(); return; }
    c.hidden = false;
    c.innerHTML = `<span class="tm-confirm-msg" role="alert">${esc(msg)}</span><span class="tm-confirm-btns"><button type="button" class="btn small ${danger ? "danger" : ""} tm-yes">${esc(yes)}</button><button type="button" class="btn ghost small tm-no">${esc(no)}</button></span>`;
    $(".tm-no", c).onclick = () => { c.hidden = true; c.innerHTML = ""; };
    $(".tm-yes", c).onclick = () => { c.hidden = true; c.innerHTML = ""; onYes(); };
    $(".tm-no", c).focus();
  }

  function paintEditor() {
    const c = current();
    if (!c && !st.isNew) {
      editor.innerHTML = `<div class="tm-empty"><p>${list().length ? "Pick a template on the left to edit it." : "You have no templates."}</p>
        <button type="button" class="btn small" id="tm-empty-new">+ New template</button></div>`;
      $("#tm-empty-new", editor).onclick = () => startNew();
      return;
    }
    const badge = !st.isNew && c.builtin ? `<span class="tm-badge ${c.edited ? "edited" : ""}">${c.edited ? "built-in · edited" : "built-in"}</span>` : "";
    editor.innerHTML = `
      <div class="tm-ed-head"><h3>${st.isNew ? "New template" : "Edit template"}</h3>${badge}</div>
      <div class="field"><div class="tm-label-line"><label for="tm-name">Name <span class="muted">(the button's label)</span></label><span class="small muted" id="tm-name-count"></span></div>
        <input id="tm-name" type="text" maxlength="${LIMITS.label}" value="${esc(st.draft.label)}" placeholder="e.g. Weekly review" autocomplete="off"></div>
      <div class="field tm-textfield"><div class="tm-label-line"><label for="tm-text">Template text</label><span class="small muted" id="tm-text-count"></span></div>
        <textarea id="tm-text" maxlength="${LIMITS.text}" placeholder="What should the writing box start with?">${esc(st.draft.text)}</textarea>
        <div class="small muted tm-hint">The cursor lands on the first blank line, so write a heading or a question, then leave one empty line where you want to start typing.</div></div>
      <div class="small bad tm-err" id="tm-err" role="alert"></div>
      <div class="tm-confirm" hidden></div>
      <div class="row tm-actions">
        <button type="button" class="btn small" id="tm-save">Save</button>
        <button type="button" class="btn ghost small" id="tm-cancel">Cancel</button>
        <div class="grow"></div>
        ${st.isNew ? "" : `<button type="button" class="btn ghost small" id="tm-dup" title="Make a copy you can change">Duplicate</button>`}
        ${!st.isNew && c.edited ? `<button type="button" class="btn ghost small" id="tm-default" title="Throw away your changes and go back to the original wording">Restore default</button>` : ""}
        ${st.isNew ? "" : `<button type="button" class="btn danger small" id="tm-del">Delete</button>`}
      </div>`;
    const name = $("#tm-name", editor), text = $("#tm-text", editor);
    const sync = () => {
      $("#tm-name-count", editor).textContent = `${name.value.length}/${LIMITS.label}`;
      $("#tm-text-count", editor).textContent = `${text.value.length.toLocaleString()} / ${LIMITS.text.toLocaleString()} characters`;
      const d = isDirty();
      $("#tm-save", editor).disabled = !d; $("#tm-cancel", editor).disabled = !d;
    };
    name.oninput = () => { st.draft.label = name.value; $("#tm-err", editor).textContent = ""; sync(); const nm = $(".tm-item.draft .tm-name", listEl); if (nm) nm.textContent = name.value.trim() || "New template"; };
    text.oninput = () => { st.draft.text = text.value; $("#tm-err", editor).textContent = ""; sync(); };
    sync();
    $("#tm-save", editor).onclick = save;
    $("#tm-cancel", editor).onclick = () => { if (st.isNew) { const f = list()[0]; if (f) select(f.id); else { st.isNew = false; paintList(); paintEditor(); } } else select(st.sel); };
    if (!st.isNew) {
      const nm = c.label;
      $("#tm-dup", editor).onclick = () => startNew({ label: (st.draft.label.trim() || nm).slice(0, LIMITS.label - 7) + " (copy)", text: st.draft.text }, c.id);
      $("#tm-del", editor).onclick = () => ask(c.builtin
        ? `Remove “${nm}” from your templates? It's a built-in, so you can bring it back any time with “Restore deleted built-ins”.`
        : `Delete “${nm}”? This can't be undone.`, "Delete", () => remove(c), { danger: true, no: "Keep it" });
      const rd = $("#tm-default", editor);
      if (rd) rd.onclick = () => ask(`Discard your edits to “${nm}” and go back to the original wording?`, "Restore default", async () => {
        if (await persist(withRestoredDefault(getDoc(), c.id), "Restored the default wording")) select(c.id);
      });
    }
  }

  async function save() {
    const label = st.draft.label.trim(), text = st.draft.text, err = $("#tm-err", editor);
    if (!label) { err.textContent = "Give the template a name."; $("#tm-name", editor).focus(); return; }
    if (!text.trim()) { err.textContent = "The template text can't be empty."; $("#tm-text", editor).focus(); return; }
    const id = st.isNew ? newTemplateId() : st.sel;
    let next = withSaved(getDoc(), id, label, text);
    if (st.isNew && st.dupOf) next = withMoveNear(next, id, st.dupOf, true);     // a copy lands right after its original
    try { await saveDoc(next); }
    catch (e) { err.textContent = e.message; return; }
    toast("Saved");
    select(id);
  }

  async function remove(c) {
    const ids = list().map((t) => t.id), i = ids.indexOf(c.id);
    if (!(await persist(withDeleted(getDoc(), c.id), `Removed “${c.label}”`))) return;
    const rest = list();
    st.sel = null;
    if (rest.length) select(rest[Math.min(i, rest.length - 1)].id); else { st.draft = { label: "", text: "" }; paintList(); paintEditor(); }
  }

  const off = onTemplatesChanged(() => { if (!box.isConnected) { off(); return; } paintList(); if (!st.isNew && st.sel && !current()) { const f = list()[0]; if (f) select(f.id); else { st.sel = null; paintEditor(); } } });

  paintList(); paintEditor();
  loadDoc(true).then(() => {
    if (!box.isConnected) return;
    if (opts.newDraft) startNew(opts.newDraft);
    else { const first = list()[0]; if (first) select(first.id); else { paintList(); paintEditor(); } }
  });
  return { isDirty, guard };
}

// The manager as a dialog over the current screen (opened from the Capture popover).
export function openTemplateManager(opts = {}) {
  const prev = document.activeElement;
  const bg = document.createElement("div");
  bg.className = "modal-bg tm-overlay";
  bg.innerHTML = `<div class="modal tm-modal" role="dialog" aria-modal="true" aria-labelledby="tm-title">
    <div class="tm-modal-head"><h2 id="tm-title">Dump templates</h2><div class="grow"></div><button type="button" class="btn ghost small" id="tm-close">Close</button></div>
    <div id="tm-mount"></div></div>`;
  document.body.appendChild(bg);
  const mgr = mountTemplateManager($("#tm-mount", bg), opts);
  const finish = () => { bg.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus && prev.isConnected) prev.focus(); };
  const close = () => mgr.guard(finish);
  function onKey(e) {
    if (e.key === "Escape") {
      const c = $(".tm-confirm:not([hidden])", bg);
      e.stopPropagation(); e.preventDefault();
      if (c) { $(".tm-no", c).click(); return; }
      close();
    } else if (e.key === "Tab") {
      const f = $$("button:not([disabled]), input, textarea, [tabindex]:not([tabindex='-1'])", bg).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!bg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener("keydown", onKey, true);
  $("#tm-close", bg).onclick = close;
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
  return { close };
}
