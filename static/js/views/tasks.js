// Tasks as master/detail: "All" (open tasks, the default) plus due-date groups on the left, the group's tasks on the right.
import { $, $$, esc, todayIso, timeChips } from "../ui.js";
import { api } from "../api.js";
import { dueWrap, bindDue, calBtns } from "./review.js";

const GROUPS = [["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["someday", "Someday"], ["done", "Done"]];

export async function render(ctx) {
  ctx.setTitle("Tasks");
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split has-detail" id="tasks">
    <div class="master" id="task-groups"></div>
    <div class="detail" id="task-list"><div class="center">Loading…</div></div></div>`;
  let tasks;
  try { tasks = await api.get("/tasks"); }
  catch (e) { $("#task-list").innerHTML = `<div class="center">Couldn't load tasks: ${esc(e.message)}</div>`; return; }
  const today = todayIso(), dayOf = (t) => (t.due_date || "").split("T")[0] || null;
  const by = { all: [], overdue: [], today: [], upcoming: [], someday: [], done: [] };
  for (const t of tasks) {
    const day = dayOf(t);
    if (t.done) { by.done.push(t); continue; }
    by.all.push(t);  // everything still open — Done is the only thing "All" leaves out
    if (day && day < today) by.overdue.push(t);
    else if (day === today) by.today.push(t);
    else if (day) by.upcoming.push(t);
    else by.someday.push(t);
  }
  const group = GROUPS.some(([g]) => g === ctx.params[0]) ? ctx.params[0] : "all";
  const label = GROUPS.find(([g]) => g === group)[1];
  $("#task-groups").innerHTML = `<div class="glist">${GROUPS.map(([g, l]) => `
      <a href="#tasks/${g}" class="grow-row ${g === group ? "on" : ""}"><span>${l}</span><span class="count">${by[g].length}</span></a>`).join("")}</div>
    <div class="small muted" style="padding:12px 16px">${tasks.length} task${tasks.length === 1 ? "" : "s"} pulled from your dumps.</div>`;
  const list = by[group];
  $("#task-list").innerHTML = `<h1 class="page">${label}</h1>
    ${list.length ? `<div class="card">${list.map((t) => `
      <div class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <div class="body grow">
          <span class="content">${esc(t.content)}</span>
          ${dueWrap(t)}
          ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
          ${timeChips(t)}
          ${t.status === "suggested" ? `<span class="chip">unreviewed</span>` : ""}
          <div class="detail small muted">from <a href="#history/${t.dump_id}">${esc(t.dump_title || "dump")}</a></div>
        </div>
        ${calBtns(t)}
        <button class="iconbtn no" title="Reject">✕</button>
      </div>`).join("")}</div>`
    : `<div class="center"><div class="big">🧺</div>${group === "all" ? "No open tasks" : "Nothing in " + label.toLowerCase()}${tasks.length ? "" : " — tasks appear when your dumps contain them"}.</div>`}`;
  const reload = () => render(ctx);
  bindDue($("#task-list"), reload);
  $$(".task-row").forEach((el) => {
    const t = tasks.find((x) => x.id === el.dataset.id);
    $("input", el).onchange = async (e) => { await api.patch("/items/" + t.id, { done: e.target.checked, status: "approved" }); reload(); };
    $(".no", el).onclick = async () => { await api.patch("/items/" + t.id, { status: "rejected" }); reload(); };
  });
}
