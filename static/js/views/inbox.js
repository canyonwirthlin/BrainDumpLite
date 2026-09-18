// AI Suggestions inbox (Phase 8): every proposed action waits here. Accept
// (optionally after editing the title/date), dismiss, or clear a whole kind.
import { $, $$, esc, relTime, toast, fmtDay } from "../ui.js";
import { api } from "../api.js";
import { refreshStatus } from "../state.js";

const KINDS = {
  calendar_push: { icon: "📅", label: "Google Calendar", verb: "Add event" },
  todoist_push: { icon: "✅", label: "Todoist", verb: "Send task" },
};
const kindOf = (k) => KINDS[k] || { icon: "✨", label: k, verb: "Run" };

export async function render(ctx) {
  ctx.setTitle("Inbox");
  ctx.setLayout("stage");
  $("#view").innerHTML = `<div class="center">Loading…</div>`;
  let data;
  try { data = await api.get("/suggestions"); }
  catch (e) { $("#view").innerHTML = `<div class="center">Couldn't load the inbox: ${esc(e.message)}</div>`; return; }
  const { pending, recent } = data;
  const kinds = [...new Set(pending.map((s) => s.kind))];
  $("#view").innerHTML = `
    <h1>Inbox</h1>
    <p class="sub">Things the AI would like to do for you. Nothing happens until you say so.</p>
    ${pending.length ? `
      <div class="row" style="margin:0 0 10px">
        <span class="small muted grow">${pending.length} waiting</span>
        ${kinds.map((k) => `<button class="btn ghost small" data-clear="${k}">Dismiss all ${esc(kindOf(k).label)}</button>`).join("")}
      </div>
      <div class="inbox">${pending.map(card).join("")}</div>`
    : `<div class="card center"><div class="big">📭</div>Inbox zero. Suggestions appear here when a dump has tasks or events and an integration is connected
        — set one up in <a href="#settings/integrations">Settings → Integrations</a>.</div>`}
    ${recent.length ? `<div class="sec">Recently handled</div>
      <div class="card"><div class="recent">${recent.slice(0, 20).map((s) => `
        <div class="recent-row ${s.status}">
          <span>${kindOf(s.kind).icon}</span>
          <span class="grow">${esc(s.title)}</span>
          ${s.status === "accepted" && s.result?.link ? `<a class="small" target="_blank" rel="noopener" href="${esc(s.result.link)}">open ↗</a>` : ""}
          ${s.status === "failed" ? `<span class="small bad" title="${esc(s.result?.error || "")}">failed</span>` : `<span class="small muted">${s.status}</span>`}
          <span class="small muted">${relTime(s.resolved_at || s.created_at)}</span>
        </div>`).join("")}</div></div>` : ""}`;
  const reload = async () => { await refreshStatus(); render(ctx); };
  $$("[data-clear]").forEach((b) => b.onclick = async () => {
    await api.post("/suggestions/dismiss-all?kind=" + encodeURIComponent(b.dataset.clear)); reload();
  });
  $$(".sugg").forEach((el) => {
    const s = pending.find((x) => x.id === el.dataset.id);
    $(".accept", el).onclick = async () => {
      const edits = { title: $(".e-title", el).value.trim() || undefined, due: $(".e-due", el)?.value || undefined };
      el.classList.add("busy");
      try {
        const r = await api.post(`/suggestions/${s.id}/accept`, edits);
        if (r.status === "failed") toast("Couldn't send: " + (r.result?.error || "unknown error"), true);
        else toast(`${kindOf(s.kind).verb} done` + (r.result?.link ? " — open it from Recently handled" : ""));
      } catch (e) { toast(e.message, true); }
      reload();
    };
    $(".dismiss", el).onclick = async () => { await api.post(`/suggestions/${s.id}/dismiss`); reload(); };
  });
}

function card(s) {
  const k = kindOf(s.kind), p = s.payload || {};
  const [d, tm] = (p.due || "").split("T");
  return `<div class="card sugg" data-id="${s.id}">
    <div class="row" style="margin:0 0 8px">
      <span class="chip">${k.icon} ${esc(k.label)}</span>
      <span class="small muted grow">${s.source === "pipeline" ? "from a dump" : s.source === "planner" ? "from Plan my day" : esc(s.source)} · ${relTime(s.created_at)}</span>
      ${s.dump_id ? `<a class="small" href="#history/${s.dump_id}">source ↗</a>` : ""}
    </div>
    <input class="e-title" value="${esc(p.title || "")}" placeholder="Title">
    <div class="row" style="margin:8px 0 0">
      ${s.kind === "calendar_push" || s.kind === "todoist_push"
        ? `<input class="e-due" type="${tm ? "datetime-local" : "date"}" value="${esc(p.due || "")}" title="${d ? fmtDay(d) : "Pick a date"}">` : ""}
      <div class="grow"></div>
      <button class="btn ghost small dismiss">Dismiss</button>
      <button class="btn small accept">${k.verb}</button>
    </div>
    ${p.description ? `<div class="small muted" style="margin-top:6px">${esc(p.description).slice(0, 200)}</div>` : ""}
  </div>`;
}
