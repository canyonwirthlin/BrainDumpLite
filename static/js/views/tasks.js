// Tasks as master/detail. Tasks are things you can finish ("call the dentist"); ongoing aims
// ("get stronger") and speculative thoughts live under Goals and Ideas so they don't clutter the
// backlog. Every row can be edited (✎), and the box at the top adds your own.
import { $, $$, esc, todayIso, timeChips, toast } from "../ui.js";
import { api } from "../api.js";
import { dueWrap, bindDue, calBtns, editItem } from "./review.js";
import { snoozeMenu, snoozeItem, rescheduleAllOverdue, fmtShort } from "./snooze.js";
import { openJustOne, pickNext } from "./jot.js";
import { renderHabits } from "./habits.js";

const GROUPS = [["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["someday", "Someday"], ["snoozed", "Snoozed"], ["done", "Done"]];
const KIND_GROUPS = [["goals", "Goals", "goal"], ["ideas", "Ideas", "idea"], ["habits", "Habits", "habit"]];
const BLURB = {
  snoozed: "Tasks you pushed to later with “Not today”. Each one comes back on its date — or bring it back now.",
  goals: "Ongoing aims — things you work toward but can't tick off in one go. When one has a concrete next step, turn it into a task.",
  ideas: "Speculative thoughts, not commitments. Promote one to a task when you decide to do it.",
};

export async function render(ctx) {
  ctx.setTitle("Tasks");
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split has-detail" id="tasks">
    <div class="master" id="task-groups"></div>
    <div class="detail" id="task-list"><div class="center">Loading…</div></div></div>`;
  let items;
  try { items = await api.get("/tasks"); }
  catch (e) { $("#task-list").innerHTML = `<div class="center">Couldn't load tasks: ${esc(e.message)}</div>`; return; }
  const today = todayIso(), dayOf = (t) => (t.due_date || "").split("T")[0] || null;
  let habitCount = 0;
  try { habitCount = (await api.get("/habits")).length; } catch {}
  const by = { all: [], overdue: [], today: [], upcoming: [], someday: [], snoozed: [], done: [], goals: [], ideas: [], habits: Array.from({ length: habitCount }, () => ({})) };
  for (const t of items) {
    if (t.kind === "goal") { by.goals.push(t); continue; }
    if (t.kind === "idea") { if (!t.done) by.ideas.push(t); continue; }
    const day = dayOf(t);
    if (t.done) { by.done.push(t); continue; }
    if (t.snoozed_until && t.snoozed_until > today) { by.snoozed.push(t); continue; }   // "not today": out of the way until its date
    by.all.push(t);  // everything still open — Done is the only thing "All" leaves out
    if (day && day < today) by.overdue.push(t);
    else if (day === today) by.today.push(t);
    else if (day) by.upcoming.push(t);
    else by.someday.push(t);
  }
  const all = [...GROUPS, ...KIND_GROUPS];
  const group = all.some(([g]) => g === ctx.params[0]) ? ctx.params[0] : "all";
  const label = all.find(([g]) => g === group)[1];
  const kindGroup = KIND_GROUPS.find(([g]) => g === group);
  const row = ([g, l]) => `<a href="#tasks/${g}" class="grow-row ${g === group ? "on" : ""}"><span>${l}</span><span class="count">${by[g].filter((t) => !t.done || g === "done").length}</span></a>`;
  $("#task-groups").innerHTML = `<div class="glist">${GROUPS.map(row).join("")}
      <div class="glist-sep">Not tasks</div>${KIND_GROUPS.map(row).join("")}</div>
    <div class="small muted" style="padding:12px 16px">Tasks are things you can finish. Ongoing aims and loose ideas are kept apart from them.</div>`;

  if (group === "habits") return renderHabits($("#task-list"), () => render(ctx));
  const list = by[group];
  const kindOfNew = kindGroup ? kindGroup[2] : "task";
  const canJot = !kindGroup && group !== "done" && group !== "snoozed" && !!pickNext(items);
  $("#task-list").innerHTML = `<h1 class="page">${label}${canJot ? ` <button class="btn ghost small" id="jot-open" title="Hide everything but the one task you should do next">🎯 Just one thing</button>` : ""}</h1>
    ${BLURB[group] ? `<p class="sub">${BLURB[group]}</p>` : ""}
    ${group === "overdue" && list.length ? `<div class="row" style="margin:0 0 10px"><span class="small muted grow">${list.length} overdue — pick a new day for all of them at once, or one by one below.</span><button class="btn small" id="resched-all">Reschedule all…</button></div>` : ""}
    <form class="add-task" id="add-task">
      <input type="text" id="add-content" maxlength="500" autocomplete="off" placeholder="${kindGroup ? `Add a ${kindGroup[2]}…` : "Add a task… (Enter)"}">
      ${kindGroup ? "" : `<input type="date" id="add-due" value="${group === "today" ? today : ""}" title="Due date (optional)">`}
      <button class="btn small" type="submit">Add</button>
    </form>
    ${list.length ? `<div class="card">${list.map((t) => rowHtml(t)).join("")}</div>`
    : `<div class="center"><div class="big">🧺</div>${emptyText(group, label, items.length)}</div>`}`;

  const reload = () => render(ctx);
  if ($("#jot-open")) $("#jot-open").onclick = () => openJustOne(items, reload);
  if ($("#resched-all")) $("#resched-all").onclick = (e) => snoozeMenu(e.currentTarget, { title: "Move all overdue tasks to…", onPick: (d) => rescheduleAllOverdue(d, reload) });
  $("#add-task").onsubmit = async (e) => {
    e.preventDefault();
    const content = $("#add-content").value.trim();
    if (!content) return;
    try {
      await api.post("/tasks", { content, kind: kindOfNew, due_date: $("#add-due")?.value || null });
      reload();
    } catch (err) { toast("Couldn't add: " + err.message, true); }
  };
  bindDue($("#task-list"), reload);
  $$(".task-row").forEach((el) => {
    const t = items.find((x) => x.id === el.dataset.id);
    const cb = $("input[type=checkbox]", el);
    if (cb) cb.onchange = async (e) => { await api.patch("/items/" + t.id, { done: e.target.checked, status: "approved" }); reload(); };
    $(".edit", el).onclick = () => editItem(el, t, reload, { kinds: ["task", "goal", "idea"] });
    $(".no", el).onclick = async () => { await api.patch("/items/" + t.id, { status: "rejected" }); reload(); };
    const promote = $(".promote", el);
    if (promote) promote.onclick = async () => { await api.patch("/items/" + t.id, { kind: "task", status: "approved" }); toast("Now a task"); reload(); };
    const snz = $(".snz", el);
    if (snz) snz.onclick = (e) => snoozeMenu(e.currentTarget, {
      title: (dayOf(t) && dayOf(t) < today) ? "Reschedule to…" : "Not today — hide until…", onPick: (d) => snoozeItem(t.id, d, reload) });
    const unsnz = $(".unsnz", el);
    if (unsnz) unsnz.onclick = async () => { await api.post(`/items/${t.id}/unsnooze`); toast("Back on your list"); reload(); };
    const achieved = $(".achieved", el);
    if (achieved) achieved.onclick = async () => { await api.patch("/items/" + t.id, { done: !t.done, status: "approved" }); reload(); };
  });
}

function emptyText(group, label, total) {
  if (group === "snoozed") return "Nothing snoozed. Use 💤 on a task to hide it until later.";
  if (group === "goals") return "No goals yet — ongoing aims from your dumps appear here, or add your own above.";
  if (group === "ideas") return "No ideas yet — speculative thoughts from your dumps appear here, or jot one above.";
  return (group === "all" ? "No open tasks" : "Nothing in " + label.toLowerCase()) + (total ? "" : " — add one above, or tasks appear when your dumps contain them") + ".";
}

function rowHtml(t) {
  const isTask = t.kind === "task";
  const today = todayIso(), day = (t.due_date || "").split("T")[0];
  const snoozed = isTask && !t.done && t.snoozed_until && t.snoozed_until > today;
  const overdue = isTask && !t.done && day && day < today;
  return `<div class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
    ${isTask ? `<input type="checkbox" ${t.done ? "checked" : ""} aria-label="Done">` : `<span class="kglyph" title="${t.kind === "goal" ? "Goal — ongoing" : "Idea"}">${t.kind === "goal" ? "🎯" : "💡"}</span>`}
    <div class="body grow">
      <span class="content">${esc(t.content)}</span>
      ${isTask ? dueWrap(t) : ""}
      ${snoozed ? `<span class="chip snoozed" title="Hidden from your lists until then">💤 until ${fmtShort(t.snoozed_until)}</span>` : ""}
      ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
      ${timeChips(t)}
      ${t.status === "suggested" ? `<span class="chip">unreviewed</span>` : ""}
      ${t.detail ? `<div class="detail small">${t.kind === "task" ? "↳ first step:" : "↳ next step:"} ${esc(t.detail)}</div>` : ""}
      <div class="detail small muted">${t.manual ? "added by you" : `from <a href="#history/${t.dump_id}">${esc(t.dump_title || "dump")}</a>`}</div>
    </div>
    ${t.kind === "goal" ? `<button class="btn ghost small achieved" title="Mark achieved / reopen">${t.done ? "Reopen" : "Achieved ✓"}</button>` : ""}
    ${t.kind !== "task" && !t.done ? `<button class="btn ghost small promote" title="Turn into a task you can check off">→ Task</button>` : ""}
    ${isTask ? calBtns(t) : ""}
    ${snoozed ? `<button class="btn ghost small unsnz" title="Bring it back now">Unsnooze</button>`
      : overdue ? `<button class="btn ghost small snz" title="Pick a new day for this task">Reschedule ▾</button>`
      : isTask && !t.done ? `<button class="iconbtn snz" title="Not today — hide until later">💤</button>` : ""}
    <button class="iconbtn edit" title="Edit">✎</button>
    <button class="iconbtn no" title="Remove">✕</button>
  </div>`;
}
