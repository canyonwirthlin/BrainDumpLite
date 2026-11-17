// Tutorial cards for dump templates: the Capture picker (pinned buttons + searchable Templates list) and the manager.
// Mocks only: they use the real CSS classes from templates.css and the built-in template texts from templates.js, never the
// user's own templates and never the API. See tour-steps.js for the card copy and what each card mirrors.
import { $, $$, esc } from "./ui.js";
import { TEMPLATES } from "./templates.js";

// The four built-ins plus three made-up extras, so searching and pinning have something to show.
const EXTRA = [
  { id: "x1", label: "Weekly review", text: "Weekly review.\n\nWhat went well:\n\nWhat didn't:\n\nOne thing to change next week:\n" },
  { id: "x2", label: "Gratitude", text: "Three things I'm grateful for today:\n1.\n2.\n3.\n" },
  { id: "x3", label: "Decision", text: "The decision I'm facing:\n\nOptions:\n\nWhat matters most:\n\nMy gut says:\n" },
];
const start = () => [...TEMPLATES.map((t) => ({ ...t, pinned: true, builtin: true })), ...EXTRA.map((t) => ({ ...t, pinned: false, builtin: false }))];
const preview = (text) => text.replace(/\s+/g, " ").trim().slice(0, 70);

export const SCENES = {
  "capture-templates": {
    mount(view, t, nav) {
      let list = start(), pop = null, q = "", active = null;
      view.innerHTML = `<div class="capture t-tpl-scene"><textarea class="editor" id="t-text" rows="7" placeholder="Type, paste, or hit the mic and just talk…"></textarea>
        <div class="t-tpl-wrap"><div class="row tpl-row" id="t-row"><span class="muted small tpl-label">Template:</span><div class="tpl-pins" id="t-pins"></div>
          <button type="button" class="btn ghost small tpl-more" id="t-more" aria-haspopup="dialog" aria-expanded="false" title="Search all your templates">Templates ▾</button></div></div>
        <p class="t-demo">Demo only. Pinned buttons that don't fit on one line move into the Templates list. The real one starts with your own templates.</p></div>`;
      const ta = $("#t-text", view);
      const paintPins = () => {
        $("#t-pins", view).innerHTML = list.filter((x) => x.pinned).slice(0, 6).map((x) => `<button type="button" class="btn ghost small tpl-btn" data-id="${x.id}" title="${esc(x.label)}">${esc(x.label)}</button>`).join("");
        $$(".tpl-btn", view).forEach((b) => b.onclick = () => use(b.dataset.id));
      };
      const use = (id) => { const x = list.find((y) => y.id === id); closePop(); ta.value = x.text; ta.focus(); const at = Math.max(0, ta.value.indexOf("\n\n") + 2); ta.setSelectionRange(at, at); };
      const order = () => [...list.filter((x) => x.pinned), ...list.filter((x) => !x.pinned)];
      const paintList = () => {
        if (!pop) return;
        const all = order(), ql = q.trim().toLowerCase();
        const shown = ql ? all.filter((x) => `${x.label}\n${x.text}`.toLowerCase().includes(ql)) : all;
        if (!shown.some((x) => x.id === active)) active = shown[0] ? shown[0].id : null;
        $(".tp-search", pop).placeholder = `Search ${all.length} templates…`;
        const groups = new Set(shown.map((x) => (x.pinned ? "p" : "a")));
        let last = "", html = "";
        for (const x of shown) {
          const g = x.pinned ? "p" : "a";
          if (!ql && groups.size > 1 && g !== last) { html += `<div class="tp-sec">${g === "p" ? "Pinned" : "All templates"}</div>`; last = g; }
          html += `<div class="tp-row ${x.id === active ? "active" : ""}" data-id="${x.id}"><button type="button" class="tp-star ${x.pinned ? "on" : ""}" tabindex="-1" title="${x.pinned ? "Unpin from the Capture screen" : "Pin to the Capture screen"}" aria-label="${x.pinned ? "Unpin" : "Pin"} ${esc(x.label)}">${x.pinned ? "★" : "☆"}</button>
            <div class="tp-main"><span class="tp-name">${esc(x.label)}</span><span class="tp-prev">${esc(preview(x.text))}</span></div></div>`;
        }
        $(".tp-list", pop).innerHTML = html || `<div class="tp-empty">No template matches “${esc(q.trim())}”.</div>`;
        $$(".tp-row", pop).forEach((r) => {
          r.onclick = () => use(r.dataset.id);
          r.onmousemove = () => { if (active !== r.dataset.id) { active = r.dataset.id; $$(".tp-row", pop).forEach((o) => o.classList.toggle("active", o === r)); } };
          $(".tp-star", r).onclick = (e) => { e.stopPropagation(); const x = list.find((y) => y.id === r.dataset.id); x.pinned = !x.pinned; paintPins(); paintList(); };
        });
      };
      const closePop = () => { if (!pop) return; pop.remove(); pop = null; $("#t-more", view).setAttribute("aria-expanded", "false"); };
      $("#t-more", view).onclick = () => {
        if (pop) { closePop(); return; }
        q = ""; active = null;
        pop = document.createElement("div");
        pop.className = "tpl-pop t-pop-abs";
        pop.innerHTML = `<input type="text" class="tp-search" autocomplete="off" spellcheck="false" aria-label="Search templates"><div class="tp-list"></div>
          <div class="tp-foot"><span class="tp-keys">↑↓ choose · Enter use · Shift+Enter pin</span><button type="button" class="tp-link tp-manage">Manage templates…</button></div>`;
        $(".t-tpl-wrap", view).appendChild(pop);
        $("#t-more", view).setAttribute("aria-expanded", "true");
        paintList();
        const s = $(".tp-search", pop);
        s.focus();
        s.oninput = () => { q = s.value; paintList(); };
        s.onkeydown = (e) => {
          const shown = $$(".tp-row", pop).map((r) => r.dataset.id), i = shown.indexOf(active);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!shown.length) return; active = shown[e.key === "ArrowDown" ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)]; paintList(); $(".tp-row.active", pop)?.scrollIntoView({ block: "nearest" }); }
          else if (e.key === "Enter") { e.preventDefault(); if (active) { if (e.shiftKey) { const x = list.find((y) => y.id === active); x.pinned = !x.pinned; paintPins(); paintList(); } else use(active); } }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(); }
        };
        $(".tp-manage", pop).onclick = () => { closePop(); nav.next(); };
      };
      paintPins();
    },
  },

  "capture-manage": {
    mount(view) {
      let list = start(), sel = "morning", isNew = false, deleted = [], seq = 0, armed = null, draft = null;
      view.innerHTML = `<div class="t-tm"><div class="row t-pinstrip" style="margin:0 0 10px"><span class="muted small">On the Capture screen:</span><div class="tpl-pins" id="t-pins"></div></div>
        <div class="tm"><div class="tm-body"><section class="tm-list" aria-label="Template list"><div class="tm-list-head"><input type="text" class="tm-search" placeholder="Search templates…" aria-label="Search templates" autocomplete="off"><button type="button" class="btn small tm-new">+ New template</button></div>
          <div class="small muted tm-count-line"></div><ul class="tm-items"></ul><div class="tm-restore" hidden><button type="button" class="btn ghost small tm-restore-btn"></button></div></section><section class="tm-editor" aria-label="Template editor"></section></div></div></div>
        <p class="t-demo">Demo only. In the real app, changes save automatically to your vault.</p>`;
      const itemsEl = $(".tm-items", view), editor = $(".tm-editor", view);
      const cur = () => list.find((x) => x.id === sel);
      const paintList = () => {
        const q = $(".tm-search", view).value.trim().toLowerCase(), shown = q ? list.filter((x) => `${x.label}\n${x.text}`.toLowerCase().includes(q)) : list;
        $("#t-pins", view).innerHTML = list.filter((x) => x.pinned).slice(0, 6).map((x) => `<span class="btn ghost small tpl-btn">${esc(x.label)}</span>`).join("") || `<span class="small muted">no pinned templates</span>`;
        $(".tm-count-line", view).textContent = `${list.length} templates · ${list.filter((x) => x.pinned).length} pinned`;
        itemsEl.innerHTML = shown.map((x, i) => `<li class="tm-item ${x.id === sel && !isNew ? "sel" : ""}" data-id="${x.id}"><button type="button" class="tm-pin ${x.pinned ? "on" : ""}" aria-pressed="${x.pinned}" title="${x.pinned ? "Unpin from the Capture screen" : "Pin to the Capture screen"}" aria-label="${x.pinned ? "Unpin" : "Pin"} ${esc(x.label)}">${x.pinned ? "★" : "☆"}</button>
          <button type="button" class="tm-pick"><span class="tm-name">${esc(x.label)}</span>${x.builtin ? `<span class="tm-badge ${x.edited ? "edited" : ""}">${x.edited ? "edited" : "built-in"}</span>` : ""}</button>
          <span class="tm-move"><button type="button" class="tm-up" aria-label="Move ${esc(x.label)} up" ${q || i === 0 ? "disabled" : ""}>↑</button><button type="button" class="tm-down" aria-label="Move ${esc(x.label)} down" ${q || i === shown.length - 1 ? "disabled" : ""}>↓</button></span></li>`).join("");
        const rest = $(".tm-restore", view); rest.hidden = !deleted.length; $(".tm-restore-btn", view).textContent = `Restore deleted built-ins (${deleted.length})`;
        $$(".tm-item", itemsEl).forEach((li) => {
          const id = li.dataset.id, i = list.findIndex((x) => x.id === id);
          $(".tm-pin", li).onclick = () => { list[i].pinned = !list[i].pinned; paintList(); };
          $(".tm-pick", li).onclick = () => { sel = id; isNew = false; paintList(); paintEditor(); };
          $(".tm-up", li).onclick = () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; paintList(); } };
          $(".tm-down", li).onclick = () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; paintList(); } };
        });
      };
      const paintEditor = () => {
        const c = isNew ? { label: draft.label, text: draft.text } : cur();
        if (!c) { editor.innerHTML = `<div class="tm-empty"><p>Pick a template on the left to edit it.</p></div>`; return; }
        editor.innerHTML = `<div class="tm-ed-head"><h3>${isNew ? "New template" : "Edit template"}</h3>${!isNew && c.builtin ? `<span class="tm-badge ${c.edited ? "edited" : ""}">${c.edited ? "built-in · edited" : "built-in"}</span>` : ""}</div>
          <div class="field"><label>Name <span class="muted">(the button's label)</span></label><input id="t-name" type="text" maxlength="30" value="${esc(c.label)}" placeholder="e.g. Weekly review" autocomplete="off"></div>
          <div class="field tm-textfield"><label>Template text</label><textarea id="t-body" placeholder="What should the writing box start with?">${esc(c.text)}</textarea></div>
          <div class="tm-confirm" hidden></div>
          <div class="row tm-actions"><button type="button" class="btn small" id="t-save">Save</button><div class="grow"></div>${isNew ? "" : `<button type="button" class="btn ghost small" id="t-dup">Duplicate</button><button type="button" class="btn danger small" id="t-del">Delete</button>`}</div>`;
        $("#t-save", editor).onclick = () => {
          const label = $("#t-name", editor).value.trim(), text = $("#t-body", editor).value; if (!label || !text.trim()) return;
          if (isNew) { const id = "n" + ++seq; list.push({ id, label, text, pinned: false, builtin: false }); sel = id; isNew = false; }
          else { const x = cur(); x.edited = x.builtin && (x.label !== label || x.text !== text) ? true : x.edited; x.label = label; x.text = text; }
          paintList(); paintEditor();
        };
        if (isNew) return;
        $("#t-dup", editor).onclick = () => { const x = cur(), id = "n" + ++seq; list.splice(list.indexOf(x) + 1, 0, { id, label: (x.label + " (copy)").slice(0, 30), text: x.text, pinned: false, builtin: false }); sel = id; paintList(); paintEditor(); };
        $("#t-del", editor).onclick = () => {
          const x = cur(), conf = $(".tm-confirm", editor); conf.hidden = false;
          conf.innerHTML = `<span class="tm-confirm-msg">${x.builtin ? `Remove “${esc(x.label)}” from your templates? It's a built-in, so you can bring it back any time with “Restore deleted built-ins”.` : `Delete “${esc(x.label)}”? This can't be undone.`}</span><span class="tm-confirm-btns"><button type="button" class="btn small danger" id="t-yes">Delete</button><button type="button" class="btn ghost small" id="t-no">Keep it</button></span>`;
          $("#t-no", conf).onclick = () => { conf.hidden = true; };
          $("#t-yes", conf).onclick = () => { const i = list.indexOf(x); list.splice(i, 1); if (x.builtin) deleted.push(x); sel = (list[Math.min(i, list.length - 1)] || {}).id || null; paintList(); paintEditor(); };
        };
      };
      $(".tm-search", view).oninput = paintList;
      $(".tm-new", view).onclick = () => { isNew = true; draft = { label: "", text: "" }; paintList(); paintEditor(); $("#t-name", editor).focus(); };
      $(".tm-restore-btn", view).onclick = () => { list.push(...deleted.map((x) => ({ ...x, pinned: false }))); deleted = []; paintList(); };
      armed = null;
      paintList(); paintEditor();
    },
  },
};
