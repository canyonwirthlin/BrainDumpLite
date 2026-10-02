// "Just one thing": the Tasks list shrunk to a single task at a time, for when the backlog is too much to
// look at. Shows the most pressing open task with its first tiny step, an optional focus timer, and three
// ways out: done, not today (snooze to tomorrow) or skip (show me another).
import { esc, modal, toast, todayIso } from "../ui.js";
import { api } from "../api.js";
import { isoPlus } from "./snooze.js";
import { startTimer, finishTimed, hasTimer, getFactor, fmtMin } from "./focus.js";

// Overdue first, then due today, then by priority, then the smaller job.
function rank(t, today) {
  const day = (t.due_date || "").split("T")[0];
  let s = 0;
  if (day && day < today) s += 1000 + Math.min(200, (new Date(today) - new Date(day)) / 864e5);
  else if (day === today) s += 800;
  else if (day) s += Math.max(0, 300 - (new Date(day) - new Date(today)) / 864e5 * 10);
  s += (t.priority || 0) * 40 + (t.urgency || 0) * 25;
  s -= Math.min(120, (t.est_minutes || 30)) / 6;
  return s;
}

export function pickNext(items, skipped = new Set()) {
  const today = todayIso();
  const open = items.filter((t) => t.kind === "task" && !t.done && t.status !== "rejected" && !skipped.has(t.id)
    && !(t.snoozed_until && t.snoozed_until > today));
  return open.sort((a, b) => rank(b, today) - rank(a, today))[0] || null;
}

export function openJustOne(items, onChange) {
  const skipped = new Set();
  let doneCount = 0, changed = false, timer = null;
  const m = modal(`<div id="jot"></div>`);
  const stop = () => { clearInterval(timer); timer = null; };
  const close = () => { stop(); m.close(); if (changed) onChange(); };
  m.el.addEventListener("click", (e) => { if (e.target === m.el) close(); });

  const paint = () => {
    stop();
    const t = pickNext(items, skipped);
    const box = m.el.querySelector("#jot");
    if (!t) {
      box.innerHTML = `<div class="center"><div class="big">🎉</div><b>${doneCount ? `${doneCount} done — that's a win.` : "Nothing left to do right now."}</b>
        <div class="small muted" style="margin:6px 0 14px">${skipped.size ? "You've skipped the rest for now." : "Your open tasks are all finished or snoozed."}</div>
        ${skipped.size ? `<button class="btn ghost small" id="jot-reset">Show skipped ones again</button> ` : ""}<button class="btn small" id="jot-close">Close</button></div>`;
      box.querySelector("#jot-close").onclick = close;
      const rs = box.querySelector("#jot-reset"); if (rs) rs.onclick = () => { skipped.clear(); paint(); };
      return;
    }
    const day = (t.due_date || "").split("T")[0], today = todayIso();
    box.innerHTML = `<div class="small muted" style="margin-bottom:10px">Just one thing${doneCount ? ` · ${doneCount} done so far` : ""}</div>
      <div class="jot-card">
        <div class="jot-task">${esc(t.content)}</div>
        ${t.detail ? `<div class="jot-step">↳ first step: ${esc(t.detail)}</div>` : ""}
        <div class="jot-meta">
          ${day ? `<span class="chip ${day < today ? "overdue" : "due"}">${day < today ? "overdue" : day === today ? "due today" : "due " + day}</span>` : ""}
          ${t.est_minutes ? `<span class="chip est">~${t.est_minutes >= 60 ? t.est_minutes / 60 + "h" : t.est_minutes + "m"}</span>` : ""}
          ${t.est_minutes && getFactor().applied ? `<span class="chip est" title="You usually take ${getFactor().factor}× your guess">likely ~${fmtMin(Math.max(1, Math.round(t.est_minutes * getFactor().factor)))}</span>` : ""}
          ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
        </div>
        <div class="jot-timer"><span id="jot-clock">10:00</span>
          <button class="btn ghost small" id="jot-start">Start 10-minute timer</button></div>
      </div>
      <div class="row jot-actions">
        <button class="btn" id="jot-done">✓ Done</button>
        <button class="btn ghost" id="jot-snooze" title="Hide it until tomorrow">Not today</button>
        <button class="btn ghost" id="jot-skip">Skip</button>
        <div class="grow"></div>
        <button class="btn ghost small" id="jot-close">Close</button>
      </div>`;
    const clock = box.querySelector("#jot-clock"), start = box.querySelector("#jot-start");
    start.onclick = () => {
      if (timer) { stop(); start.textContent = "Start 10-minute timer"; clock.textContent = "10:00"; return; }
      let left = 600;
      if (!hasTimer(t.id)) startTimer(t.id).catch(() => {});   // so "Done" can record how long it really took
      start.textContent = "Stop timer";
      timer = setInterval(() => {
        left -= 1;
        clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
        if (left <= 0) { stop(); start.textContent = "Start 10-minute timer"; toast("Time's up — nice focus. Done, or another 10?"); }
      }, 1000);
    };
    box.querySelector("#jot-done").onclick = async () => {
      try {
        if (hasTimer(t.id)) toast(await finishTimed(t));   // timer was running: log the actual time
        else await api.patch("/items/" + t.id, { done: true, status: "approved" });
      } catch (e) { toast(e.message, true); return; }
      doneCount++; changed = true; t.done = true; paint();
    };
    box.querySelector("#jot-snooze").onclick = async () => {
      try { await api.post(`/items/${t.id}/snooze`, { until: isoPlus(1) }); } catch (e) { toast(e.message, true); return; }
      t.snoozed_until = isoPlus(1); changed = true; paint(); toast("Back tomorrow");
    };
    box.querySelector("#jot-skip").onclick = () => { skipped.add(t.id); paint(); };
    box.querySelector("#jot-close").onclick = close;
  };
  paint();
}
