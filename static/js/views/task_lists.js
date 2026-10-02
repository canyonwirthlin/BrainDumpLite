// Task folders (separate lists) and recurring tasks, for the Tasks tab. tasks.js stays thin: it calls
// loadTaskLists() once per render, then barHtml()/bindBar() for the folder tabs and chipsHtml()/
// buttonsHtml()/bindRow() for each row. Server side: app/routes_tasks.py.
import { $, $$, esc, toast } from "../ui.js";
import { api } from "../api.js";

let folders = [];
let current = "";   // "" = every folder, "none" = tasks without a folder, else a folder id
let editing = null; // null | "new" | folder id being renamed
let confirmDel = false;

export async function loadTaskLists() {
  try { folders = await api.get("/task-folders"); } catch { folders = []; }
  if (current && current !== "none" && !folders.some((f) => f.id === current)) current = "";
  return { folders, current };
}
export const currentFolder = () => (current && current !== "none" ? current : null);
export const filterByFolder = (items) =>
  !current ? items : items.filter((t) => (current === "none" ? !t.folder_id : t.folder_id === current));

export function describeRecurrence(r) {
  if (!r) return "";
  const rec = typeof r === "string" ? JSON.parse(r) : r;
  const n = rec.every, u = rec.unit;
  const base = n === 1 ? ({ day: "daily", week: "weekly", month: "monthly" })[u] : `every ${n} ${u}s`;
  return rec.from === "done" ? `${base}, after done` : base;
}

// ── folder tabs ──────────────────────────────────────────────────────────────

export function barHtml() {
  const tab = (id, label, n) => `<button type="button" class="ftab ${current === id ? "on" : ""}" data-f="${esc(id)}">${esc(label)}${n != null ? ` <span class="count">${n}</span>` : ""}</button>`;
  const sel = folders.find((f) => f.id === current);
  const form = editing ? `<form class="ftab-form" id="f-form"><input type="text" maxlength="60" autocomplete="off" placeholder="Folder name" value="${esc(editing === "new" ? "" : (folders.find((f) => f.id === editing) || {}).name || "")}"><button class="btn small" type="submit">Save</button><button class="btn ghost small" type="button" id="f-cancel">Cancel</button></form>` : "";
  return `<div class="ftabs" id="ftabs" role="tablist" aria-label="Task folders">
    ${tab("", "All lists")}${folders.map((f) => tab(f.id, f.name, f.open_count)).join("")}${folders.length ? tab("none", "No folder") : ""}
    <button type="button" class="ftab add" id="f-new" title="New folder">＋ Folder</button>
    ${sel && !editing ? `<span class="small muted">· <a href="#" id="f-rename">Rename</a> · <a href="#" id="f-del">${confirmDel ? "Click again to delete (tasks are kept)" : "Delete"}</a></span>` : ""}
    ${form}</div>`;
}

export function bindBar(reload) {
  const bar = $("#ftabs");
  if (!bar) return;
  $$(".ftab[data-f]", bar).forEach((b) => b.onclick = () => { current = b.dataset.f; editing = null; confirmDel = false; reload(); });
  $("#f-new", bar).onclick = () => { editing = "new"; reload(); setTimeout(() => $("#f-form input")?.focus(), 0); };
  const ren = $("#f-rename", bar);
  if (ren) ren.onclick = (e) => { e.preventDefault(); editing = current; reload(); setTimeout(() => $("#f-form input")?.focus(), 0); };
  const del = $("#f-del", bar);
  if (del) del.onclick = async (e) => {
    e.preventDefault();
    if (!confirmDel) { confirmDel = true; reload(); return; }
    try { await api.del(`/task-folders/${current}`); toast("Folder deleted — its tasks are now unfiled"); current = ""; confirmDel = false; reload(); }
    catch (err) { toast(err.message, true); }
  };
  const form = $("#f-form", bar);
  if (form) {
    $("#f-cancel", form).onclick = () => { editing = null; reload(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = $("input", form).value.trim();
      if (!name) return;
      try {
        if (editing === "new") current = (await api.post("/task-folders", { name })).id;
        else await api.patch(`/task-folders/${editing}`, { name });
        editing = null; reload();
      } catch (err) { toast(err.message, true); }
    };
  }
}

// ── per-row bits ─────────────────────────────────────────────────────────────

export function chipsHtml(t) {
  if (t.kind !== "task") return "";
  const f = t.folder_id && folders.find((x) => x.id === t.folder_id);
  return `${f && !current ? `<span class="chip" title="Folder">📁 ${esc(f.name)}</span>` : ""}`
    + `${t.recurrence && !t.done ? `<span class="chip" title="Repeats">🔁 ${esc(describeRecurrence(t.recurrence))}</span>` : ""}`;
}

export function buttonsHtml(t) {
  if (t.kind !== "task" || t.done) return "";
  return `<button class="iconbtn folder-mv" title="Move to a folder">📁</button><button class="iconbtn repeat" title="Repeat this task">🔁</button>`;
}

function popover(anchor, title, buttons, extra = "") {
  document.querySelectorAll(".snooze-menu").forEach((m) => m.remove());
  const m = document.createElement("div");
  m.className = "snooze-menu";
  m.innerHTML = `<div class="small muted sm-title">${esc(title)}</div>${buttons.map(([l], i) => `<button type="button" data-i="${i}">${esc(l)}</button>`).join("")}${extra}`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(Math.max(8, r.left - 120), window.innerWidth - 250) + "px";
  const below = r.bottom + m.offsetHeight + 8 < window.innerHeight;
  m.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - m.offsetHeight - 6)) + "px";
  const close = () => m.remove();
  $$("button[data-i]", m).forEach((b) => b.onclick = () => { close(); buttons[+b.dataset.i][1](); });
  setTimeout(() => {
    document.addEventListener("mousedown", (e) => { if (!m.contains(e.target)) close(); }, { once: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }, { once: true });
  }, 0);
  return m;
}

export function bindRow(el, t, reload) {
  const mv = $(".folder-mv", el);
  if (mv) mv.onclick = (e) => {
    const put = (id) => async () => { try { await api.put(`/items/${t.id}/folder`, { folder_id: id }); reload(); } catch (err) { toast(err.message, true); } };
    const opts = [["No folder", put(null)], ...folders.map((f) => [f.name, put(f.id)])];
    popover(e.currentTarget, folders.length ? "Move to…" : "Move to… (create a folder first with ＋ Folder)", opts);
  };
  const rep = $(".repeat", el);
  if (rep) rep.onclick = (e) => {
    const set = (recurrence) => async () => {
      try { await api.put(`/items/${t.id}/recurrence`, { recurrence }); toast(recurrence ? "Repeats " + describeRecurrence(recurrence) : "Won't repeat"); reload(); }
      catch (err) { toast(err.message, true); }
    };
    const opts = [["Every day", set({ every: 1, unit: "day", from: "due" })], ["Every week", set({ every: 1, unit: "week", from: "due" })],
      ["Every month", set({ every: 1, unit: "month", from: "due" })], ["Every 2 weeks after done", set({ every: 2, unit: "week", from: "done" })]];
    if (t.recurrence) opts.push(["Stop repeating", set(null)]);
    const m = popover(e.currentTarget, t.recurrence ? "Repeats " + describeRecurrence(t.recurrence) : "Repeat…", opts,
      `<div class="sm-pick"><input type="number" min="1" max="365" value="3" style="width:52px" aria-label="Every"><select aria-label="Unit"><option value="day">days</option><option value="week">weeks</option><option value="month">months</option></select><select aria-label="Counted from"><option value="due">from due</option><option value="done">after done</option></select><button type="button" class="btn small" data-go>Set</button></div>`);
    $("[data-go]", m).onclick = () => {
      const [num, unit, frm] = [$("input", m).value, ...$$("select", m).map((s) => s.value)];
      m.remove(); set({ every: parseInt(num, 10) || 1, unit, from: frm })();
    };
  };
}
