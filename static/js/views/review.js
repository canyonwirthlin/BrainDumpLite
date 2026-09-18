// Review pieces shared by the capture flow, History detail and Tasks.
import { $, $$, esc, md, toast, fmtDate, fmtDay, fmtTime, todayIso, MODES, kindBadge, timeChips, toneChip, trustBadge } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";

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
  return `<a class="iconbtn cal" title="Add to Google Calendar" target="_blank" rel="noopener" href="${esc(gcalUrl(t))}">📅</a>
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
      <button class="iconbtn ok ${it.status === "approved" ? "active" : ""}" title="Keep">✓</button>
      <button class="iconbtn no ${it.status === "rejected" ? "active" : ""}" title="Reject">✕</button>
    </div>`;
}

export function bindItemRows(container, items, reload) {
  if (reload) bindDue(container, reload);
  $$(".item", container).forEach((el) => {
    const it = items.find((x) => x.id === el.dataset.id);
    const [ok, no] = [$(".ok", el), $(".no", el)];
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
  return `
    <h1 class="page">${esc(d.title || "Untitled dump")}</h1>
    ${detail ? `<div class="meta"><span>${fmtDate(d.created_at)}</span><span>${mode.icon} ${mode.label}</span><span>${n} item${n === 1 ? "" : "s"}</span>${toneChip(d.tone)}${trustBadge(d.provider)}</div>`
             : `<p class="sub">${mode.icon} ${mode.label} · ${fmtDate(d.created_at)}</p>`}
    ${d.summary ? `<div class="card">${md(d.summary)}</div>` : ""}
    ${d.reflection ? `<div class="reflection"><div class="tag">${mode.icon} ${mode.label} take</div>${md(d.reflection)}</div>` : ""}
    ${d.items.length ? `<div class="card"><h2>Extracted items <span class="muted small">(✓ keep · ✕ reject)</span></h2>
      <div id="items">${d.items.map(itemRow).join("")}</div>
      <div class="row"><button class="btn ghost" id="approve-all">Keep all</button></div></div>` : ""}
    ${d.related && d.related.length ? `<div class="card"><h2>Related dumps</h2>
      ${d.related.map((r) => `<div class="dump-row" style="padding:6px 0">
        <a href="#history/${r.id}" class="grow">🔗 ${esc(r.title || "Untitled")}</a>
        <span class="meta">${fmtDate(r.created_at)}</span></div>`).join("")}</div>` : ""}
    ${(d.concepts || []).length || (d.people || []).length ? `<div class="card"><h2>Concepts &amp; people</h2><div class="wl">
      ${(d.concepts || []).map((c) => `<a class="wl-chip" href="#graph/concept/${encodeURIComponent(c)}">${esc(c)}</a>`).join("")}
      ${(d.people || []).map((p) => `<a class="wl-chip p" href="#graph/person/${encodeURIComponent(p)}">@${esc(p)}</a>`).join("")}</div></div>` : ""}
    ${detail ? `<div class="card backlinks" id="backlinks"><span class="small muted">Looking for links…</span></div>` : ""}
    <details class="card"><summary class="muted">Raw text</summary>
      <p class="small" style="margin-top:10px;white-space:pre-wrap">${esc(d.raw_text)}</p></details>
    <div class="row">
      ${showBack ? `<a class="btn ghost" href="#history">← History</a>` : ""}
      ${showBack || detail ? `<button class="btn danger" id="delete-dump">Delete</button>` : ""}
      <div class="grow"></div>
      ${detail ? "" : `<a class="btn" href="#capture">New dump →</a>`}
    </div>`;
}

export function renderReview(d) {
  $("#view").innerHTML = reviewHtml(d);
  bindItemRows($("#view"), d.items, async () => {
    try { renderReview(await api.get("/dumps/" + d.id)); } catch {}
  });
  if ($("#approve-all")) $("#approve-all").onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) {
      await api.patch("/items/" + it.id, { status: "approved" });
      it.status = "approved";
    }
    $$("#items .item:not(.rejected) .ok").forEach((b) => b.classList.add("active"));
  };
}
