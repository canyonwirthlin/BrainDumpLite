// Daily / weekly reflections.
import { $, $$, md, esc, relTime, toneChip, toast, fmtTime, ICONS } from "../ui.js";
import { api } from "../api.js";
import { refreshStatus } from "../state.js";

export function render(ctx) {
  ctx.setTitle("Reflect");
  $("#view").innerHTML = `
    <div id="resurface"></div>
    <h1>Reflect <span class="wip-chip" title="Reflect is still being built — expect rough edges">${ICONS.wip} Work in progress</span></h1>
    <p class="sub">Your second brain reads everything back to you.</p>
    <div class="card digest" id="digest"><span class="spin"></span></div>
    <div class="card" id="plan-card">
      <div class="row" style="margin:0 0 6px">
        <h2 class="grow">🗓️ Plan my day</h2>
        <input type="date" id="plan-day" value="${new Date().toLocaleDateString("sv")}">
        <button class="btn ghost small" id="plan-go">Plan</button>
      </div>
      <div id="plan-body" class="muted small">Fits your open tasks into the free gaps of the day — around your Google Calendar events when it's connected.</div>
    </div>
    ${["daily"].map((k) => `
      <div class="card">
        <div class="row" style="margin:0 0 6px">
          <h2 class="grow">${k === "daily" ? "☀️ Today" : "📆 This week"}</h2>
          <button class="btn ghost small" data-kind="${k}" data-force="0">Generate</button>
          <button class="btn ghost small" data-kind="${k}" data-force="1" title="Ignore cache">↻</button>
        </div>
        <div id="reflect-${k}" class="muted small">Press Generate.</div>
      </div>`).join("")}`;
  paintResurface();
  paintDigest(0);
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


// One-screen summary of a Monday-Sunday week, computed from your own data (no AI needed).
const MOOD_FACE = (v) => (v == null ? "–" : v >= 1 ? "😊" : v >= 0.3 ? "🙂" : v > -0.3 ? "😐" : v > -1 ? "😕" : "😞");
const short = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const wkday = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "narrow" }); };

async function paintDigest(back) {
  const box = $("#digest");
  if (!box) return;
  let d;
  try { d = await api.get("/digest/weekly?weeks_back=" + back); }
  catch (e) { box.innerHTML = `<div class="small muted">Couldn't build the digest: ${esc(e.message)}</div>`; return; }
  const delta = (a, b) => (b == null || a == null || a === b ? "" : ` <span class="small ${a > b ? "" : "muted"}" title="vs the week before">${a > b ? "▲" : "▼"}${Math.abs(Math.round((a - b) * 10) / 10)}</span>`);
  const max = Math.max(1, ...d.days.map((x) => x.dumps));
  const t = d.tasks;
  box.innerHTML = `
    <div class="digest-head"><h2>📊 ${d.current ? "This week" : "Week"} at a glance</h2>
      <span class="small muted">${short(d.start)} – ${short(d.end)}</span>
      <button class="btn ghost small" id="dg-prev" title="Previous week">◀</button>
      <button class="btn ghost small" id="dg-next" title="Next week" ${d.current ? "disabled" : ""}>▶</button></div>
    ${d.dumps ? `
    <div class="dg-stats">
      <div class="dg-stat"><b>${d.dumps}${delta(d.dumps, d.dumps_prev)}</b><span>dump${d.dumps === 1 ? "" : "s"}</span></div>
      <div class="dg-stat"><b>${d.words.toLocaleString()}</b><span>words</span></div>
      <div class="dg-stat"><b>${d.active_days}/7</b><span>days you dumped</span></div>
      <div class="dg-stat"><b>${MOOD_FACE(d.mood.avg)}${d.mood.avg != null ? delta(d.mood.avg, d.mood.prev_avg) : ""}</b><span>${d.mood.labels.length ? d.mood.labels.map(([l]) => l).join(", ") : "mood"}</span></div>
    </div>
    <div class="dg-days">${d.days.map((x) => `<div class="dg-day" title="${short(x.day)} · ${x.dumps} dump${x.dumps === 1 ? "" : "s"}${x.mood != null ? " · mood " + MOOD_FACE(x.mood) : ""}">
      <div class="dg-bar ${x.dumps ? "" : "none"}" style="height:${x.dumps ? Math.max(12, Math.round(100 * x.dumps / max) * 0.62) : 4}px"></div><small>${wkday(x.day)}</small></div>`).join("")}</div>
    <div class="dg-cols">
      <div><h3>Themes</h3>${d.concepts.length ? d.concepts.map((c) => `<a class="chip ent" href="#search/type/concept/${encodeURIComponent(c.name)}">💡 ${esc(c.name)}${c.count > 1 ? ` · ${c.count}×` : ""}${c.new ? " ✨" : ""}</a>`).join("") : `<span class="small muted">None yet.</span>`}</div>
      <div><h3>People</h3>${d.people.length ? d.people.map((c) => `<a class="chip ent" href="#search/type/person/${encodeURIComponent(c.name)}">🧑 ${esc(c.name)}${c.count > 1 ? ` · ${c.count}×` : ""}</a>`).join("") : `<span class="small muted">None mentioned.</span>`}</div>
      <div><h3>Tasks</h3><div class="small">${t.added} added this week<br>${t.open} open${t.overdue ? ` · <a href="#tasks/overdue"><b>${t.overdue} overdue</b></a>` : ""}<br>${t.due_next_7_days} due in the next 7 days</div></div>
      ${d.current && d.habits.length ? `<div><h3>Habits</h3><div class="small">${d.habits.map((h) => `${esc(h.title)} — ${h.frequency === "weekly" ? `${h.week_count}/${h.target} this week` : h.streak ? `🔥 ${h.streak}-day streak` : "start today"}`).join("<br>")}</div></div>` : ""}
    </div>
    ${d.busiest ? `<div class="small muted" style="margin-top:12px">Longest dump: <a href="#history/${d.busiest.id}">${esc(d.busiest.title)}</a> · ✨ = a theme you hadn't mentioned before</div>` : ""}`
    : `<div class="small muted" style="margin:10px 0">No dumps ${d.current ? "yet this week" : "that week"}. ${d.current ? "Capture one and it will show up here." : ""}</div>`}`;
  $("#dg-prev", box).onclick = () => paintDigest(back + 1);
  paintNarrative(box, d, back);
  $("#dg-next", box).onclick = () => paintDigest(Math.max(0, back - 1));
}

// AI-written narrative for the week (cached server-side), regenerate, copy as Markdown, save as a dump.
async function paintNarrative(box, d, back) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "margin-top:14px;border-top:1px solid var(--border,#8884);padding-top:10px";
  box.appendChild(wrap);
  const empty = !d.dumps;
  let n = null;
  try { n = await api.get("/digest/weekly/narrative?weeks_back=" + back); } catch { /* stats-only is fine */ }
  const paint = (content, note) => {
    wrap.innerHTML = `
      <div class="row" style="margin:0 0 6px"><h3 class="grow" style="margin:0">✨ Week in words</h3>
        ${n && n.ai_available && !empty ? `<button class="btn ghost small" id="dg-gen">${content ? "↻ Regenerate" : "Write it"}</button>` : ""}
        <button class="btn ghost small" id="dg-copy" title="Copy this week as Markdown">Copy Markdown</button>
        <button class="btn ghost small" id="dg-save" ${empty ? "disabled" : ""} title="Save this week as a new dump">Save as dump</button></div>
      <div id="dg-body" class="${content ? "" : "muted small"}">${content ? md(content) : esc(note)}</div>`;
    const gen = $("#dg-gen", wrap);
    if (gen) gen.onclick = async () => {
      gen.disabled = true; $("#dg-body", wrap).innerHTML = `<span class="spin"></span>`;
      try {
        const r = await api.post("/digest/weekly/narrative", { weeks_back: back, force: true });
        paint(r.content, "Nothing to write about this week yet.");
      } catch (e) { paint(content, "Couldn't write it: " + e.message); }
    };
    $("#dg-copy", wrap).onclick = async () => {
      try {
        const r = await api.get("/digest/weekly/markdown?weeks_back=" + back);
        await navigator.clipboard.writeText(r.markdown);
        toast("Copied as Markdown");
      } catch (e) { toast("Couldn't copy: " + e.message, true); }
    };
    $("#dg-save", wrap).onclick = async () => {
      try {
        const r = await api.post("/digest/weekly/save", { weeks_back: back });
        toast("Saved as a dump");
        await refreshStatus();
        location.hash = "history/" + r.id;
      } catch (e) { toast("Couldn't save: " + e.message, true); }
    };
  };
  paint(n && n.content, empty ? "Nothing to write about yet."
    : n && !n.ai_available ? "Turn on an AI in Settings to get a written summary. The stats above work without one."
    : "Press Write it for a themes, wins and next-week summary.");
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
        <button class="btn small" id="plan-push" ${p.calendar ? "" : "disabled title=\"Connect Google Calendar first\""}>Block on calendar</button></div>` : ""}`;
  const push = $("#plan-push");
  if (push) push.onclick = async () => {
    const slots = $$("[data-slot]:checked", box).map((c) => p.slots[+c.dataset.slot]);
    if (!slots.length) return toast("Pick at least one slot", true);
    push.disabled = true;
    try {
      const r = await api.post("/plan/push", { day: p.day, slots });
      toast(r.failed ? `${r.created} blocked, ${r.failed} failed` : `${r.created} time block${r.created === 1 ? "" : "s"} added to your calendar`, !!r.failed && !r.created);
      await refreshStatus();
    } catch (e) { toast(e.message, true); push.disabled = false; }
  };
}
