// Habits (Tasks → Habits): things you repeat rather than finish. Check in for today with the big circle;
// click any of the last 14 dots to fix a day you forgot. Daily habits track a day streak; weekly ones
// ("gym 3×/week") track how many weeks in a row you hit the target. All local, no AI.
import { $, $$, esc, toast } from "../ui.js";
import { api } from "../api.js";

const FREQ = (h) => (h.frequency === "daily" ? "Every day" : `${h.target}× a week`);
const dow = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" }); };

function rowHtml(h) {
  const weekly = h.frequency === "weekly";
  return `<div class="habit-row" data-id="${h.id}">
    <button class="habit-check ${h.done_today ? "on" : ""}" title="${h.done_today ? "Done today — click to undo" : "Check in for today"}" aria-pressed="${h.done_today}">${h.done_today ? "✓" : ""}</button>
    <div class="grow">
      <div><b class="habit-title">${esc(h.title)}</b> <span class="chip">${FREQ(h)}</span>
        ${h.streak ? `<span class="chip streak" title="Best: ${h.best}">🔥 ${h.streak} ${weekly ? "week" : "day"}${h.streak === 1 ? "" : "s"}</span>` : ""}
        ${weekly ? `<span class="small muted">this week ${h.week_count}/${h.target}${h.week_count >= h.target ? " ✓" : ""}</span>` : ""}</div>
      ${h.notes ? `<div class="small muted">${esc(h.notes)}</div>` : ""}
      <div class="hdots" aria-label="Last 14 days">${h.days.map((d) => `<button class="hdot ${d.done ? "on" : ""}" data-day="${d.day}" title="${dow(d.day)} ${d.day}${d.done ? " — done" : ""}"></button>`).join("")}</div>
    </div>
    <button class="iconbtn edit" title="Edit">✎</button>
    <button class="iconbtn no" title="Remove">✕</button>
  </div>`;
}

export async function renderHabits(box, reload) {
  let habits;
  try { habits = await api.get("/habits"); }
  catch (e) { box.innerHTML = `<div class="center">Couldn't load habits: ${esc(e.message)}</div>`; return; }
  const doneToday = habits.filter((h) => h.done_today).length;
  box.innerHTML = `<h1 class="page">Habits</h1>
    <p class="sub">Things you repeat rather than finish. Check in each day; the streak counts the days (or weeks) in a row.${habits.length ? ` <b>${doneToday}/${habits.length}</b> done today.` : ""}</p>
    <form class="add-task" id="add-habit">
      <input type="text" id="hb-title" maxlength="120" autocomplete="off" placeholder="New habit… e.g. Stretch, Read 10 pages">
      <select id="hb-freq" aria-label="How often"><option value="daily">Every day</option><option value="weekly">Some days a week</option></select>
      <input type="number" id="hb-target" min="1" max="7" value="3" style="width:64px;display:none" title="Times per week" aria-label="Times per week">
      <button class="btn small" type="submit">Add</button>
    </form>
    ${habits.length ? `<div class="card">${habits.map(rowHtml).join("")}</div>`
      : `<div class="center"><div class="big">🔁</div>No habits yet — add one above. Small and specific works best.</div>`}`;

  $("#hb-freq", box).onchange = (e) => { $("#hb-target", box).style.display = e.target.value === "weekly" ? "" : "none"; };
  $("#add-habit", box).onsubmit = async (e) => {
    e.preventDefault();
    const title = $("#hb-title", box).value.trim();
    if (!title) return;
    const frequency = $("#hb-freq", box).value;
    try { await api.post("/habits", { title, frequency, target: frequency === "weekly" ? +$("#hb-target", box).value || 3 : 1 }); reload(); }
    catch (err) { toast(err.message, true); }
  };
  $$(".habit-row", box).forEach((row) => {
    const h = habits.find((x) => x.id === row.dataset.id);
    const check = async (day, done) => {
      try { await api.post(`/habits/${h.id}/check`, { day, done }); reload(); } catch (err) { toast(err.message, true); }
    };
    $(".habit-check", row).onclick = () => check(undefined, !h.done_today);
    $$(".hdot", row).forEach((d) => d.onclick = () => check(d.dataset.day, !d.classList.contains("on")));
    $(".no", row).onclick = async () => {
      if (!confirm(`Remove “${h.title}”? Its history is kept in case you want it back, but it leaves this list.`)) return;
      try { await api.del("/habits/" + h.id); reload(); } catch (err) { toast(err.message, true); }
    };
    $(".edit", row).onclick = () => {
      const body = $(".grow", row);
      body.innerHTML = `<div class="row" style="margin:0;gap:8px;flex-wrap:wrap">
        <input type="text" class="hb-t" value="${esc(h.title)}" maxlength="120" style="flex:1;min-width:160px">
        <select class="hb-f"><option value="daily" ${h.frequency === "daily" ? "selected" : ""}>Every day</option><option value="weekly" ${h.frequency === "weekly" ? "selected" : ""}>Some days a week</option></select>
        <input type="number" class="hb-n" min="1" max="7" value="${h.target}" style="width:64px;${h.frequency === "weekly" ? "" : "display:none"}">
        <input type="text" class="hb-notes" value="${esc(h.notes || "")}" placeholder="note (optional)" maxlength="300" style="flex:1 1 100%">
        <button class="btn small hb-save">Save</button><button class="btn ghost small hb-cancel">Cancel</button></div>`;
      $(".hb-f", row).onchange = (e) => { $(".hb-n", row).style.display = e.target.value === "weekly" ? "" : "none"; };
      $(".hb-cancel", row).onclick = reload;
      $(".hb-save", row).onclick = async () => {
        try {
          await api.patch("/habits/" + h.id, { title: $(".hb-t", row).value, frequency: $(".hb-f", row).value, target: +$(".hb-n", row).value || 1, notes: $(".hb-notes", row).value });
          reload();
        } catch (err) { toast(err.message, true); }
      };
    };
  });
}
