// Tasks grouped by due date (master/detail arrives in Task 8).
import { $, $$, esc, todayIso } from "../ui.js";
import { api } from "../api.js";
import { dueWrap, bindDue, calBtns } from "./review.js";

export async function render(ctx) {
  ctx.setTitle("Tasks");
  const reload = () => render(ctx);
  $("#view").innerHTML = `<h1>Tasks</h1><p class="sub">Tasks and goals pulled from your dumps.</p><div id="list" class="center">Loading…</div>`;
  const tasks = await api.get("/tasks");
  if (!tasks.length) {
    $("#list").innerHTML = `<div class="center"><div class="big">🧺</div>No tasks yet — they appear when your dumps contain them.</div>`;
    return;
  }
  const today = todayIso();
  const dayOf = (t) => (t.due_date || "").split("T")[0] || null;  // date part only
  const groups = { Overdue: [], Today: [], Upcoming: [], Someday: [], Done: [] };
  for (const t of tasks) {
    const day = dayOf(t);
    if (t.done) groups.Done.push(t);
    else if (day && day < today) groups.Overdue.push(t);
    else if (day === today) groups.Today.push(t);
    else if (day) groups.Upcoming.push(t);
    else groups.Someday.push(t);
  }
  $("#list").className = "";
  $("#list").innerHTML = Object.entries(groups).filter(([, v]) => v.length).map(([g, list]) => `
    <div class="group-label">${g} · ${list.length}</div>
    <div class="card">${list.map((t) => `
      <div class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <div class="body grow">
          <span class="content">${esc(t.content)}</span>
          ${dueWrap(t)}
          ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
          ${t.status === "suggested" ? `<span class="chip">unreviewed</span>` : ""}
          <div class="detail small muted">from <a href="#dump/${t.dump_id}">${esc(t.dump_title || "dump")}</a></div>
        </div>
        ${calBtns(t)}
        <button class="iconbtn no" title="Reject">✕</button>
      </div>`).join("")}</div>`).join("");
  bindDue($("#list"), reload);
  $$(".task-row").forEach((el) => {
    const t = tasks.find((x) => x.id === el.dataset.id);
    $("input", el).onchange = async (e) => {
      await api.patch("/items/" + t.id, { done: e.target.checked, status: "approved" });
      reload();
    };
    $(".no", el).onclick = async () => {
      await api.patch("/items/" + t.id, { status: "rejected" });
      reload();
    };
  });
}
