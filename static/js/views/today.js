// Today stream: the day's dumps in order with their items, quick capture on top,
// and a day-by-day walk backwards. The graph-averse view.
import { $, $$, esc, toast, kindBadge, timeChips, toneChip, trustBadge, MODES, todayIso, fmtDay } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { go } from "../router.js";
import { attach as attachWikilinks } from "../wikilinks.js";

const shift = (day, n) => { const d = new Date(day + "T12:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export async function render(ctx) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params[0] || "") ? ctx.params[0] : todayIso();
  const isToday = day === todayIso();
  ctx.setTitle("Today", `<a class="btn ghost small" href="#today/${shift(day, -1)}">‹</a><span>${isToday ? "Today" : fmtDay(day)}</span>${isToday ? "" : `<a class="btn ghost small" href="#today/${shift(day, 1)}">›</a><a class="btn ghost small" href="#today">Today</a>`}`);
  $("#view").innerHTML = `
    ${isToday ? `<div class="card quick">
      <textarea id="quick-text" class="editor" rows="2" placeholder="Quick thought… (Ctrl+Enter to save as a ${state.curMode} dump)"></textarea>
      <div class="row" style="margin-top:8px"><span class="small muted">Saved as a normal dump and processed like any other.</span><div class="grow"></div><button class="btn small" id="quick-go">Save</button></div>
    </div>` : ""}
    <div id="today-list" class="center">Loading…</div>`;
  if (isToday) {
    const ta = $("#quick-text");
    attachWikilinks(ta);
    const save = async () => {
      const text = ta.value.trim(); if (!text) return;
      $("#quick-go").disabled = true;
      try { await api.post("/dumps", { text, mode: state.curMode }); ta.value = ""; toast("Saved — processing in the background"); setTimeout(() => render(ctx), 1500); }
      catch (e) { toast(e.message, true); }
      finally { $("#quick-go").disabled = false; }
    };
    $("#quick-go").onclick = save;
    ta.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };
  }
  let t;
  try { t = await api.get("/today?date=" + day); } catch (e) { $("#today-list").textContent = "Couldn't load: " + e.message; return; }
  const box = $("#today-list");
  box.className = "";
  box.innerHTML = t.dumps.length ? t.dumps.map((d) => {
    const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
    const time = new Date(d.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `<div class="card today-card">
      <div class="row" style="margin:0 0 6px"><span class="small muted mono">${time}</span><a href="#history/${d.id}"><b>${esc(d.title)}</b></a><span class="tag">${mode.icon} ${mode.label}</span>${toneChip(d.tone)}${trustBadge(d.provider)}</div>
      ${d.items.length ? `<div class="today-items">${d.items.map((it) => `<div class="mi ${it.done ? "done" : ""}">${kindBadge(it.kind)} <span>${esc(it.content)}</span>${timeChips(it)}</div>`).join("")}</div>` : `<p class="small muted">${esc(d.raw_text)}</p>`}
    </div>`;
  }).join("") : `<div class="center"><div class="big">${isToday ? "☀️" : "🗓️"}</div>${isToday ? "Nothing captured yet today." : "Nothing on this day."}</div>`;
  if (t.processing) box.insertAdjacentHTML("afterbegin", `<div class="small muted" style="margin-bottom:10px">${t.processing} dump${t.processing === 1 ? "" : "s"} still processing…</div>`);
}
