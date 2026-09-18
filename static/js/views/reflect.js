// Daily / weekly reflections.
import { $, $$, md, esc, relTime, toneChip, toast, fmtTime } from "../ui.js";
import { api } from "../api.js";
import { refreshStatus } from "../state.js";

export function render(ctx) {
  ctx.setTitle("Reflect");
  $("#view").innerHTML = `
    <div id="resurface"></div>
    <h1>Reflect</h1>
    <p class="sub">Your second brain reads everything back to you.</p>
    <div class="card" id="plan-card">
      <div class="row" style="margin:0 0 6px">
        <h2 class="grow">🗓️ Plan my day</h2>
        <input type="date" id="plan-day" value="${new Date().toLocaleDateString("sv")}">
        <button class="btn ghost small" id="plan-go">Plan</button>
      </div>
      <div id="plan-body" class="muted small">Fits your open tasks into the free gaps of the day — around your Google Calendar events when it's connected.</div>
    </div>
    ${["daily", "weekly"].map((k) => `
      <div class="card">
        <div class="row" style="margin:0 0 6px">
          <h2 class="grow">${k === "daily" ? "☀️ Today" : "📆 This week"}</h2>
          <button class="btn ghost small" data-kind="${k}" data-force="0">Generate</button>
          <button class="btn ghost small" data-kind="${k}" data-force="1" title="Ignore cache">↻</button>
        </div>
        <div id="reflect-${k}" class="muted small">Press Generate.</div>
      </div>`).join("")}`;
  paintResurface();
  $("#plan-go").onclick = planDay;
  $$("[data-kind]").forEach((b) => b.onclick = async () => {
    const box = $("#reflect-" + b.dataset.kind);
    box.innerHTML = `<span class="spin"></span>`;
    try {
      const r = await api.post("/reflect", { kind: b.dataset.kind, force: b.dataset.force === "1" });
      box.className = "";
      box.innerHTML = md(r.content) + (r.cached ? `<div class="small muted" style="margin-top:6px">cached — ↻ to regenerate</div>` : "");
    } catch (e) {
      box.className = "muted small";
      box.textContent = "Failed: " + e.message;
    }
  });
}


async function paintResurface() {
  const box = $("#resurface");
  if (!box) return;
  let r;
  try { r = await api.get("/resurface"); } catch { return; }
  if (!r || !r.dump) return;
  box.innerHTML = `<div class="card click resurface" onclick="location.hash='history/${r.dump.id}'">
    <div class="sec" style="margin-top:0">🕰️ ${esc(r.reason)}</div>
    <b>${esc(r.dump.title)}</b> <span class="small muted">${relTime(r.dump.created_at)}</span> ${toneChip(r.dump.tone)}
    <p class="small muted" style="margin-top:6px">${esc(r.dump.raw_text)}</p></div>`;
}

async function planDay() {
  const box = $("#plan-body"), day = $("#plan-day").value;
  box.className = ""; box.innerHTML = `<span class="spin"></span>`;
  let p;
  try { p = await api.get("/plan?day=" + encodeURIComponent(day)); }
  catch (e) { box.className = "muted small"; box.textContent = "Failed: " + e.message; return; }
  const ev = p.events.filter((e) => !e.all_day);
  const hhmm = (iso) => (iso && iso.includes("T")) ? fmtTime(iso.slice(11, 16)) : "";
  box.innerHTML = `
    <div class="small muted" style="margin-bottom:8px">
      ${p.calendar ? `${ev.length} calendar event${ev.length === 1 ? "" : "s"}` : `<a href="#settings/integrations">Connect Google Calendar</a> to plan around real events`}
      · ${p.gaps.length} free gap${p.gaps.length === 1 ? "" : "s"} · ${p.backlog.length} open task${p.backlog.length === 1 ? "" : "s"}
      ${p.via === "ai" ? "· planned by AI" : p.via === "greedy" ? "· planned by fit" : ""}
    </div>
    ${ev.map((e) => `<div class="plan-row ev"><span class="mono">${hhmm(e.start)}–${hhmm(e.end)}</span><span class="grow">${esc(e.title)}</span><span class="chip">calendar</span></div>`).join("")}
    ${p.slots.length ? p.slots.map((s, i) => `<label class="plan-row"><input type="checkbox" data-slot="${i}" checked>
        <span class="mono">${fmtTime(s.start)}–${fmtTime(s.end)}</span><span class="grow">${esc(s.task || s.task_id)}</span>
        ${s.reason ? `<span class="small muted">${esc(s.reason)}</span>` : ""}</label>`).join("")
      : `<div class="small muted">${p.backlog.length ? "No gaps left to fill." : "No open tasks to plan — approve some in a dump's review first."}</div>`}
    ${p.slots.length ? `<div class="row" style="margin-top:10px"><div class="grow"></div>
        <button class="btn small" id="plan-push" ${p.calendar ? "" : "disabled title=\"Connect Google Calendar first\""}>Block on calendar → Inbox</button></div>` : ""}`;
  const push = $("#plan-push");
  if (push) push.onclick = async () => {
    const slots = $$("[data-slot]:checked", box).map((c) => p.slots[+c.dataset.slot]);
    if (!slots.length) return toast("Pick at least one slot", true);
    push.disabled = true;
    try {
      const r = await api.post("/plan/push", { day: p.day, slots });
      toast(`${r.created} time block${r.created === 1 ? "" : "s"} waiting in your Inbox`);
      await refreshStatus();
    } catch (e) { toast(e.message, true); push.disabled = false; }
  };
}
