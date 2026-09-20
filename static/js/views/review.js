// Review pieces shared by the capture flow, History detail and Tasks.
import { $, $$, esc, md, toast, modal, fmtDate, fmtDay, fmtTime, todayIso, MODES, kindBadge, timeChips, toneChip, trustBadge } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { titleHtml, tagsHtml, linksHtml, bindDumpEdit } from "../dumpedit.js";

// Prefilled Google Calendar event link — no OAuth, user completes it there.
function gcalUrl(t) {
  const p = new URLSearchParams({ action: "TEMPLATE", text: t.content.slice(0, 120) });
  if (t.due_date) {
    const [d, tm] = t.due_date.split("T");
    const stamp = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
    if (tm) {  // timed event: YYYYMMDDTHHMMSS, 1h long
      const s = new Date(`${d}T${tm}`), e = new Date(s.getTime() + 3600000);
      const dt = (x) => `${stamp(x)}T${String(x.getHours()).padStart(2, "0")}${String(x.getMinutes()).padStart(2, "0")}00`;
      p.set("dates", `${dt(s)}/${dt(e)}`);
    } else {   // all-day: start/next-day
      const next = new Date(d + "T00:00"); next.setDate(next.getDate() + 1);
      p.set("dates", `${d.replace(/-/g, "")}/${stamp(next)}`);
    }
  }
  p.set("details", (t.detail ? "First step: " + t.detail + "\n" : "") + "From BrainDump Lite");
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

export function calBtns(t) {
  return `<button class="iconbtn send" data-send="${t.id}" title="Send to Google Calendar / Todoist">⇪</button>
    <a class="iconbtn cal" title="Add to Google Calendar" target="_blank" rel="noopener" href="${esc(gcalUrl(t))}">📅</a>
    <a class="iconbtn cal" title="Download .ics (Apple Calendar / Outlook / Reminders)" href="/api/items/${t.id}/ics">⬇</a>`;
}

// ── Editable due date/time (used in Tasks + review rows) ─────────────────────
// Markup is an empty span; paintDue() fills it (chip or "+ date"), and clicking
// swaps in date/time inputs. Any change PATCHes the item, then reload() re-renders.
export function dueWrap(it) {
  return `<span class="due-wrap" data-id="${it.id}" data-due="${esc(it.due_date || "")}"></span>`;
}

function paintDue(wrap, done) {
  const dd = wrap.dataset.due || "";
  const [d, tm] = dd.split("T");
  if (dd) {
    const overdue = !tm && d < todayIso() && !done;
    wrap.innerHTML = `<button class="chip due-open ${overdue ? "overdue" : "due"}" title="Edit date">⏰ ${fmtDay(d)}${tm ? " · " + fmtTime(tm) : ""}</button>`;
  } else {
    wrap.innerHTML = `<button class="chip due-open adddate" title="Add a date">＋ date</button>`;
  }
}

export function bindDue(container, reload) {
  $$(".due-wrap", container).forEach((wrap) => {
    const done = !!wrap.closest(".task-row.done, .item.done");
    paintDue(wrap, done);
    wrap.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-due-act]")?.dataset.dueAct;
      if (e.target.closest(".due-open")) {
        const [d, tm] = (wrap.dataset.due || "").split("T");
        wrap.innerHTML = `
          <span class="due-editor">
            <input type="date" class="due-d" value="${d || ""}">
            <input type="time" class="due-t" value="${tm || ""}">
            <button class="chip mini set" data-due-act="save">Set</button>
            ${wrap.dataset.due ? `<button class="chip mini" data-due-act="clear">Clear</button>` : ""}
            <button class="chip mini" data-due-act="cancel">✕</button>
          </span>`;
        $(".due-d", wrap).focus();
        return;
      }
      if (!act) return;
      const id = wrap.dataset.id;
      try {
        if (act === "save") {
          const d = $(".due-d", wrap).value;
          const tm = $(".due-t", wrap).value;
          if (!d) { toast("Pick a date first", true); return; }
          await api.patch("/items/" + id, { due_date: tm ? `${d}T${tm}` : d });
          reload();
        } else if (act === "clear") {
          await api.patch("/items/" + id, { due_date: null });
          reload();
        } else if (act === "cancel") {
          paintDue(wrap, done);
        }
      } catch (err) { toast("Couldn't update date: " + err.message, true); }
    });
  });
}

export function itemRow(it) {
  return `
    <div class="item ${it.status === "rejected" ? "rejected" : ""}" data-id="${it.id}">
      ${kindBadge(it.kind)}
      <div class="body">
        <div class="content">${esc(it.content)}
          ${["task", "goal", "event"].includes(it.kind) ? dueWrap(it) : ""}
          ${it.priority >= 4 ? `<span class="chip">P${it.priority}</span>` : ""}
          ${timeChips(it)}
        </div>
        ${it.detail ? `<div class="detail">↳ ${esc(it.detail)}</div>` : ""}
      </div>
      ${["task", "goal", "event"].includes(it.kind) ? calBtns(it) : ""}
      <button class="iconbtn edit" title="Edit">✎</button>
      <button class="iconbtn ok ${it.status === "approved" ? "active" : ""}" title="Keep">✓</button>
      <button class="iconbtn no ${it.status === "rejected" ? "active" : ""}" title="Reject">✕</button>
    </div>`;
}

// Swap an item row's text for a small form: text, first step / note, and type.
function editItem(el, it, reload) {
  const types = state.types.some((t) => t.id === it.kind) ? state.types : [...state.types, { id: it.kind, label: it.kind, icon: "" }];
  const body = $(".body", el);
  body.innerHTML = `<div class="ed-form">
    <textarea class="ed-content" rows="2" maxlength="500" aria-label="Item text">${esc(it.content)}</textarea>
    <input type="text" class="ed-detail" maxlength="500" placeholder="First step or note (optional)" value="${esc(it.detail || "")}" aria-label="First step or note">
    <div class="row" style="margin:0">
      <select class="ed-kind" aria-label="Type">${types.map((t) => `<option value="${esc(t.id)}" ${t.id === it.kind ? "selected" : ""}>${esc((t.icon ? t.icon + " " : "") + t.label)}</option>`).join("")}</select>
      <div class="grow"></div>
      <button class="btn small" data-save>Save</button><button class="btn ghost small" data-cancel>Cancel</button></div></div>`;
  const content = $(".ed-content", body);
  content.focus(); content.setSelectionRange(content.value.length, content.value.length);
  const save = async () => {
    const text = content.value.trim();
    if (!text) { toast("An item needs some text", true); return; }
    const patch = { content: text, detail: $(".ed-detail", body).value.trim() || null };
    const kind = $(".ed-kind", body).value;
    if (kind !== it.kind) patch.kind = kind;
    try { await api.patch("/items/" + it.id, patch); reload?.(); }
    catch (e) { toast("Couldn't save: " + e.message, true); }
  };
  $("[data-save]", body).onclick = save;
  $("[data-cancel]", body).onclick = () => reload?.();
  body.onkeydown = (e) => {
    if (e.key === "Escape") reload?.();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target.classList.contains("ed-detail"))) { e.preventDefault(); save(); }
  };
}

export function bindItemRows(container, items, reload) {
  if (reload) bindDue(container, reload);
  $$(".item", container).forEach((el) => {
    const it = items.find((x) => x.id === el.dataset.id);
    const [ok, no] = [$(".ok", el), $(".no", el)];
    $(".edit", el).onclick = () => editItem(el, it, reload);
    ok.onclick = async () => {
      const next = it.status === "approved" ? "suggested" : "approved";
      await api.patch("/items/" + it.id, { status: next });
      it.status = next;
      ok.classList.toggle("active", next === "approved");
      no.classList.remove("active");
      el.classList.remove("rejected");
    };
    no.onclick = async () => {
      const next = it.status === "rejected" ? "suggested" : "rejected";
      await api.patch("/items/" + it.id, { status: next });
      it.status = next;
      no.classList.toggle("active", next === "rejected");
      ok.classList.remove("active");
      el.classList.toggle("rejected", next === "rejected");
    };
  });
}

export function reviewHtml(d, { showBack = false, detail = false } = {}) {
  const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
  const n = d.items.length;
  const transcript = d.clean_text || d.raw_text || "";
  return `
    ${titleHtml(d)}
    ${detail ? `<div class="meta"><span>${fmtDate(d.created_at)}</span><span>${mode.icon} ${mode.label}</span><span>${n} item${n === 1 ? "" : "s"}</span>${toneChip(d.tone)}${trustBadge(d.provider)}</div>`
             : `<p class="sub">${mode.icon} ${mode.label} · ${fmtDate(d.created_at)}</p>`}
    ${transcript ? `<div class="card transcript"><h2>Cleaned transcript</h2><p class="transcript-text">${esc(transcript)}</p>
      ${d.summary ? `<h3 class="keypoints-h">Key points</h3>${md(d.summary)}` : ""}</div>`
      : d.summary ? `<div class="card">${md(d.summary)}</div>` : ""}
    ${d.items.length ? `<div class="card"><h2>Extracted items <span class="muted small">(✓ keep · ✕ reject · ✎ edit)</span></h2>
      <div id="items">${d.items.map(itemRow).join("")}</div>
      <div class="row"><button class="btn ghost" id="approve-all">Keep all</button></div></div>` : ""}
    ${tagsHtml(d)}
    ${linksHtml(d)}
    ${detail ? `<div class="card backlinks" id="backlinks"><span class="small muted">Looking for links…</span></div>` : ""}
    ${d.clean_text && d.clean_text !== d.raw_text ? `<details class="card"><summary class="muted">Raw text</summary>
      <p class="small" style="margin-top:10px;white-space:pre-wrap">${esc(d.raw_text)}</p></details>` : ""}
    <div class="row">
      ${showBack ? `<a class="btn ghost" href="#history">← History</a>` : ""}
      ${detail ? `<a class="btn ghost" id="export-md" href="/api/dumps/${d.id}/markdown" download title="Obsidian-compatible markdown with [[wikilinks]]">Export .md…</a>` : ""}
      ${showBack || detail ? `<button class="btn danger" id="delete-dump">Delete</button>` : ""}
      <div class="grow"></div>
      ${detail ? "" : `<a class="btn" href="#capture">New dump →</a>`}
    </div>`;
}

export function renderReview(d) {
  $("#view").innerHTML = reviewHtml(d);
  const reload = async () => { try { renderReview(await api.get("/dumps/" + d.id)); } catch {} };
  bindItemRows($("#view"), d.items, reload);
  bindDumpEdit($("#view"), d, { reload });
  if ($("#approve-all")) $("#approve-all").onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) {
      await api.patch("/items/" + it.id, { status: "approved" });
      it.status = "approved";
    }
    $$("#items .item:not(.rejected) .ok").forEach((b) => b.classList.add("active"));
  };
}

// ── Send to… (Phase 8) ───────────────────────────────────────────────────────
let integ = null, integAt = 0;
async function integrations() {
  if (!integ || Date.now() - integAt > 60_000) { try { integ = await api.get("/integrations"); integAt = Date.now(); } catch { integ = null; } }
  return integ;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-send]");
  if (!b) return;
  e.preventDefault();
  const id = b.dataset.send, i = await integrations();
  const opt = (target, icon, label, on) => on
    ? `<button class="btn ghost" data-target="${target}" style="justify-content:flex-start">${icon} ${label}</button>`
    : `<a class="btn ghost" href="#settings/integrations" style="justify-content:flex-start;opacity:.7">${icon} ${label} — connect in Settings</a>`;
  const m = modal(`<h2>Send to…</h2>
    <div style="display:grid;gap:8px">
      ${opt("calendar", "📅", "Google Calendar" + (i?.google?.account ? ` (${esc(i.google.account)})` : ""), i?.google?.connected)}
      ${opt("todoist", "✅", "Todoist", i?.todoist?.connected)}
    </div>
    <p class="small muted" style="margin:14px 0 0">Sends right away. Suggested sends from new dumps land in the <a href="#inbox">Inbox</a> first.</p>`);
  $$("[data-target]", m.el).forEach((o) => o.onclick = async () => {
    o.disabled = true;
    try {
      const r = await api.post(`/items/${id}/send`, { target: o.dataset.target });
      if (r.status === "failed") toast("Couldn't send: " + (r.result?.error || "unknown error"), true);
      else toast("Sent" + (r.result?.link ? " — open it from Inbox → Recently handled" : ""));
    } catch (err) { toast(err.message, true); }
    m.close();
  });
  $$("a[href]", m.el).forEach((a) => a.addEventListener("click", () => m.close()));
});
