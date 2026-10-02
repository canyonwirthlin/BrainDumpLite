// "Not today" / reschedule menu for tasks. One popover, used on a single task (snooze or, when it is
// overdue, reschedule) and on the Overdue list ("Reschedule all"). The server does the work:
// POST /items/<id>/snooze hides the task until the date and pushes an earlier due date to it.
import { $, $$, esc, toast } from "../ui.js";
import { api } from "../api.js";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isoPlus = (days) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + days); return iso(d); };
const nextMonday = () => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return isoPlus(add); };

export function fmtShort(isoDay) {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export const presets = () => {
  const seen = new Set();   // "In 3 days" and "Next week" can land on the same day - show it once
  return [["Tomorrow", isoPlus(1)], ["Next week", nextMonday()], ["In 3 days", isoPlus(3)], ["In 2 weeks", isoPlus(14)]]
    .filter(([, d]) => !seen.has(d) && seen.add(d))
    .sort((x, y) => x[1].localeCompare(y[1]));
};

// Opens the popover under `anchor`. `onPick(isoDay)` runs the API call; the menu closes first.
export function snoozeMenu(anchor, { title, onPick }) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "snooze-menu";
  m.innerHTML = `<div class="small muted sm-title">${esc(title)}</div>
    ${presets().map(([l, d]) => `<button type="button" data-d="${d}"><span>${l}</span><span class="small muted">${fmtShort(d)}</span></button>`).join("")}
    <div class="sm-pick"><input type="date" min="${isoPlus(0)}" aria-label="Pick a date"><button type="button" class="btn small" data-go>Go</button></div>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left), window.innerWidth - 250);
  const below = r.bottom + m.offsetHeight + 8 < window.innerHeight;
  m.style.left = left + "px";
  m.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - m.offsetHeight - 6)) + "px";
  const pick = (d) => { if (!d) return; closeMenus(); onPick(d); };
  $$("button[data-d]", m).forEach((b) => b.onclick = () => pick(b.dataset.d));
  $("[data-go]", m).onclick = () => pick($("input", m).value);
  setTimeout(() => {
    const away = (e) => { if (!m.contains(e.target)) closeMenus(); };
    document.addEventListener("mousedown", away, { once: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); }, { once: true });
  }, 0);
}

export function closeMenus() { $$(".snooze-menu").forEach((m) => m.remove()); }

export async function snoozeItem(id, day, reload) {
  try { await api.post(`/items/${id}/snooze`, { until: day }); toast(`Moved to ${fmtShort(day)}`); reload(); }
  catch (e) { toast(e.message, true); }
}

export async function rescheduleAllOverdue(day, reload) {
  try { const r = await api.post("/tasks/reschedule-overdue", { until: day }); toast(`${r.moved} task${r.moved === 1 ? "" : "s"} moved to ${fmtShort(day)}`); reload(); }
  catch (e) { toast(e.message, true); }
}
