// Hand-editing a finished dump: title, concepts/people chips, linked dumps, and
// "Export .md…". Markup helpers are used by reviewHtml (views/review.js); bindDumpEdit
// wires them up after the HTML is in the DOM. Item editing lives with the item rows.
import { $, $$, esc, toast, modal, fmtDate, relTime } from "./ui.js";
import { api } from "./api.js";
import { emit } from "./state.js";
import { saveAs } from "./native.js";

// ── Markup ───────────────────────────────────────────────────────────────────
export const titleHtml = (d) => `<h1 class="page title-row"><span id="d-title">${esc(d.title || "Untitled dump")}</span>
  <button class="iconbtn edit" id="edit-title" title="Rename">✎</button></h1>`;

const chip = (kind, name) => `<span class="wl-chip tag ${kind === "person" ? "p" : ""}" data-kind="${kind}" data-name="${esc(name)}">
  <a href="#graph/${kind}/${encodeURIComponent(name)}">${kind === "person" ? "@" : ""}${esc(name)}</a>
  <button class="tag-btn" data-act="rename" title="Rename" aria-label="Rename ${esc(name)}">✎</button>
  <button class="tag-btn" data-act="remove" title="Remove" aria-label="Remove ${esc(name)}">×</button></span>`;

export const tagsHtml = (d) => `<div class="card" id="tags"><h2>Concepts &amp; people</h2>
  <div class="wl">${(d.concepts || []).map((c) => chip("concept", c)).join("")}${(d.people || []).map((p) => chip("person", p)).join("")}
    ${(d.concepts || []).length || (d.people || []).length ? "" : `<span class="small muted">None yet — add some below.</span>`}</div>
  <div class="tag-add"><input type="text" id="add-concept" placeholder="＋ concept" maxlength="60" autocomplete="off">
    <input type="text" id="add-person" placeholder="＋ person" maxlength="60" autocomplete="off"></div></div>`;

export const linksHtml = (d) => `<div class="card" id="links"><h2>Linked dumps</h2>
  ${(d.related || []).map((r) => `<div class="dump-row link-row" data-id="${r.id}">
    <a href="#history/${r.id}" class="grow">🔗 ${esc(r.title || "Untitled")}</a>
    <span class="meta">${fmtDate(r.created_at)}</span>
    <button class="iconbtn no" data-unlink="${r.id}" title="Remove this link">✕</button></div>`).join("")
    || `<p class="small muted" style="margin-bottom:8px">Nothing linked yet.</p>`}
  <div class="row" style="margin-top:8px"><button class="btn ghost small" id="add-link">＋ Link a dump</button></div></div>`;

// ── Behaviour ────────────────────────────────────────────────────────────────
// reload(): re-render the whole detail (used when links change).
// onTags(): the chips changed in place — the host can refresh anything derived from them.
export function bindDumpEdit(box, d, { reload, onTags } = {}) {
  bindTitle(box, d);
  bindTags(box, d, onTags);
  bindLinks(box, d, reload);
  bindExport(box, d);
}

function bindTitle(box, d) {
  const btn = $("#edit-title", box);
  if (!btn) return;
  btn.onclick = () => {
    const h = $(".title-row", box);
    h.innerHTML = `<input type="text" class="title-input" maxlength="80" value="${esc(d.title || "")}" aria-label="Title">
      <button class="btn small" data-save>Save</button><button class="btn ghost small" data-cancel>Cancel</button>`;
    const input = $("input", h);
    input.focus(); input.select();
    const paint = () => { h.innerHTML = `<span id="d-title">${esc(d.title || "Untitled dump")}</span><button class="iconbtn edit" id="edit-title" title="Rename">✎</button>`; bindTitle(box, d); };
    const save = async () => {
      const title = input.value.trim();
      if (!title) { toast("A dump needs a title", true); return; }
      if (title === d.title) { paint(); return; }
      try {
        const r = await api.patch("/dumps/" + d.id, { title });
        d.title = r.title;
        emit("dump:changed", { id: d.id, title: r.title });
        paint();
      } catch (e) { toast("Couldn't rename: " + e.message, true); }
    };
    $("[data-save]", h).onclick = save;
    $("[data-cancel]", h).onclick = paint;
    input.onkeydown = (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") paint(); };
  };
}

function bindTags(box, d, onTags) {
  const card = $("#tags", box);
  if (!card) return;
  // Concepts/people are stored on the dump as two name lists; every edit PATCHes the affected list
  // and repaints just this card from the response, so typing several in a row keeps its place.
  const commit = async (field, names) => {
    try {
      const r = await api.patch("/dumps/" + d.id, { [field]: names });
      d.concepts = r.concepts; d.people = r.people;
      card.outerHTML = tagsHtml(d);
      bindTags(box, d, onTags);
      onTags?.();
      return true;
    } catch (e) { toast("Couldn't update: " + e.message, true); return false; }
  };
  const listOf = (kind) => (kind === "person" ? d.people : d.concepts) || [];
  const fieldOf = (kind) => (kind === "person" ? "people" : "concepts");

  for (const [id, kind] of [["add-concept", "concept"], ["add-person", "person"]]) {
    const input = $("#" + id, card);
    input.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      if (await commit(fieldOf(kind), [...listOf(kind), name])) $("#" + id, box)?.focus();
    };
  }
  $$(".tag", card).forEach((el) => {
    const { kind, name } = el.dataset;
    $('[data-act="remove"]', el).onclick = () => commit(fieldOf(kind), listOf(kind).filter((n) => n !== name));
    $('[data-act="rename"]', el).onclick = () => {
      el.innerHTML = `<input type="text" class="tag-rename" maxlength="60" value="${esc(name)}" aria-label="Rename ${esc(name)}">`;
      const input = $("input", el);
      input.focus(); input.select();
      const cancel = () => {
        if (!el.isConnected) return;  // the card was already repainted by a successful rename
        el.outerHTML = chip(kind, name); bindTags(box, d, onTags);
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape") cancel();
        else if (e.key === "Enter") {
          const next = input.value.trim();
          if (!next || next === name) cancel();
          else commit(fieldOf(kind), listOf(kind).map((n) => (n === name ? next : n)));
        }
      };
      input.onblur = cancel;
    };
  });
}

function bindLinks(box, d, reload) {
  const card = $("#links", box);
  if (!card) return;
  $$("[data-unlink]", card).forEach((b) => b.onclick = async () => {
    try { await api.del(`/dumps/${d.id}/links/${b.dataset.unlink}`); reload?.(); }
    catch (e) { toast("Couldn't remove link: " + e.message, true); }
  });
  $("#add-link", card).onclick = async () => {
    let all;
    try { all = await api.get("/dumps?limit=200"); } catch (e) { toast(e.message, true); return; }
    const linked = new Set((d.related || []).map((r) => r.id));
    const pool = all.filter((x) => x.id !== d.id && !linked.has(x.id) && x.status === "ready");
    const m = modal(`<h2>Link a dump</h2>
      <input type="text" id="lk-q" placeholder="Filter by title…" autocomplete="off" style="width:100%;margin-bottom:10px">
      <div id="lk-list" class="lk-list"></div>`);
    const paint = () => {
      const q = $("#lk-q", m.el).value.trim().toLowerCase();
      const rows = pool.filter((x) => !q || (x.title || "").toLowerCase().includes(q));
      $("#lk-list", m.el).innerHTML = rows.length
        ? rows.map((x) => `<button class="lk-row" data-id="${x.id}"><b>${esc(x.title || "Untitled")}</b><span class="muted small">${relTime(x.created_at)}</span></button>`).join("")
        : `<p class="small muted">${pool.length ? "No dumps match." : "No other dumps to link."}</p>`;
      $$(".lk-row", m.el).forEach((r) => r.onclick = async () => {
        try { await api.post(`/dumps/${d.id}/links`, { related_id: r.dataset.id }); m.close(); reload?.(); }
        catch (e) { toast("Couldn't link: " + e.message, true); }
      });
    };
    $("#lk-q", m.el).oninput = paint;
    paint();
    $("#lk-q", m.el).focus();
  };
}

// Native: the OS Save dialog (choose folder + name). Browser: the link's normal download.
function bindExport(box, d) {
  const a = $("#export-md", box);
  if (!a) return;
  a.onclick = async (e) => {
    e.preventDefault();
    const name = ((d.title || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 60) || "Untitled") + ".md";
    try {
      const path = await saveAs({ defaultName: name, ext: "md", label: "Markdown", endpoint: `/dumps/${d.id}/markdown/save`, downloadUrl: a.href });
      if (path) toast("Saved to " + path);
    } catch (err) { toast("Couldn't save: " + (err.message || err), true); }
  };
}
