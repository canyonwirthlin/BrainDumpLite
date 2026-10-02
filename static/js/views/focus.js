// Focus helpers for the Tasks tab: the "I have N minutes" filter, home/PC/errand tags, a per-task timer and the
// time-blindness correction ("you guessed 20m, it took 35m — you usually take 1.8× your guess").
// tasks.js calls loadFocus() once per render, then focusChips()/focusButtons()/bindFocusRow() for each row.
// Server side: app/routes_focus.py.
import { $, $$, esc, modal, toast } from "../ui.js";
import { api } from "../api.js";

export const TAGS = [["home", "🏠 Home"], ["pc", "💻 PC"], ["errand", "🛍 Errand"]];
let factor = { factor: 1, samples: 0, applied: false };
let timers = {};   // item id -> ISO start

export async function loadFocus() {
  try { factor = await api.get("/focus/factor"); } catch { factor = { factor: 1, samples: 0, applied: false }; }
  try { timers = await api.get("/focus/timers"); } catch { timers = {}; }
}
export async function startTimer(id) { const r = await api.post(`/items/${id}/timer/start`); timers[id] = r.started; }
export async function finishTimed(t) {   // the running timer becomes the actual time; returns the summary text
  const r = await api.post(`/items/${t.id}/actual`, {}); delete timers[t.id]; return summary(r);
}
export const hasTimer =(id) => !!timers[id];
export const getFactor = () => factor;

export const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);
const adj = (est) => (est && factor.applied ? Math.max(1, Math.round(est * factor.factor)) : est);
const elapsed = (id) => Math.max(1, Math.ceil((Date.now() - new Date(timers[id]).getTime()) / 60000));
export const tagsOf = (t) => { if (Array.isArray(t.tags)) return t.tags; try { const v = JSON.parse(t.tags || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

export function factorNote() {
  return factor.applied
    ? `You usually take <b>${factor.factor}×</b> your guess (${factor.samples} finished tasks) — estimates below are adjusted.`
    : `Finish a few tasks with an estimate and a time and I'll learn how your guesses compare.`;
}

// ── per-row bits ─────────────────────────────────────────────────────────────

export function focusChips(t) {
  if (t.kind !== "task") return "";
  let out = tagsOf(t).map((g) => `<span class="chip" title="Tag">${(TAGS.find((x) => x[0] === g) || [0, g])[1]}</span>`).join("");
  if (!t.done && t.est_minutes && factor.applied && adj(t.est_minutes) !== t.est_minutes)
    out += `<span class="chip est" title="You guessed ${t.est_minutes}m; you usually take ${factor.factor}× your guess">likely ~${fmtMin(adj(t.est_minutes))}</span>`;
  if (t.done && t.actual_minutes)
    out += `<span class="chip est" title="Actual time">${t.est_minutes ? `guessed ${fmtMin(t.est_minutes)}, took ${fmtMin(t.actual_minutes)}` : `took ${fmtMin(t.actual_minutes)}`}</span>`;
  if (!t.done && timers[t.id]) out += `<span class="chip on" title="Timer running">⏱ ${fmtMin(elapsed(t.id))}</span>`;
  return out;
}

export function focusButtons(t) {
  if (t.kind !== "task" || t.done) return "";
  return `<button class="iconbtn fx-tags" title="Tags (home / PC / errand) and time estimate">🏷</button>`
    + `<button class="iconbtn fx-timer" title="${timers[t.id] ? "Stop the timer and finish" : "Start a timer"}">${timers[t.id] ? "⏹" : "⏱"}</button>`;
}

export function bindFocusRow(el, t, reload) {
  const tg = $(".fx-tags", el);
  if (tg) tg.onclick = (e) => tagMenu(e.currentTarget, t, reload);
  const tm = $(".fx-timer", el);
  if (tm) tm.onclick = async () => {
    try {
      if (timers[t.id]) await completeTask(t, reload);
      else { await api.post(`/items/${t.id}/timer/start`); toast("Timer started"); reload(); }
    } catch (e) { toast(e.message, true); }
  };
}

function tagMenu(anchor, t, reload) {
  $$(".snooze-menu").forEach((m) => m.remove());
  const m = document.createElement("div");
  m.className = "snooze-menu";
  const cur = tagsOf(t);
  m.innerHTML = `<div class="small muted" style="margin-bottom:6px">Where can you do this?</div>${TAGS.map(([k, l]) =>
    `<label style="display:block;padding:3px 0"><input type="checkbox" value="${k}" ${cur.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}
    <div class="small muted" style="margin:8px 0 4px">How long will it take?</div>
    <div class="row" style="gap:6px;margin:0"><input type="number" class="fx-est" min="0" max="1440" value="${t.est_minutes || ""}" placeholder="minutes" style="width:90px" aria-label="Estimate in minutes"><button class="btn small fx-est-save">Set</button></div>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.cssText += `;position:fixed;top:${Math.min(r.bottom + 4, innerHeight - 150)}px;left:${Math.max(8, Math.min(r.left, innerWidth - 190))}px;z-index:60`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); } };
  setTimeout(() => document.addEventListener("mousedown", off, true));
  $(".fx-est-save", m).onclick = async () => {
    const v = parseInt($(".fx-est", m).value, 10) || 0;   // 0 clears
    try { await api.patch("/items/" + t.id, { est_minutes: v }); m.remove(); reload(); } catch (e) { toast(e.message, true); }
  };
  $$("input[type=checkbox]", m).forEach((cb) => cb.onchange = async () => {
    const tags = $$("input[type=checkbox]:checked", m).map((x) => x.value);
    try { await api.put(`/items/${t.id}/tags`, { tags }); t.tags = JSON.stringify(tags); reload(); } catch (e) { toast(e.message, true); }
  });
}

// ── finishing a task: record how long it really took ─────────────────────────

function summary(r) {
  const took = fmtMin(r.actual_minutes);
  let s = r.est_minutes ? `You guessed ${fmtMin(r.est_minutes)}, it took ${took}.` : `Took ${took}.`;
  if (r.factor && r.factor.applied) s += ` You typically take ${r.factor.factor}× your guess.`;
  return s;
}

// Uses the running timer if there is one, otherwise asks (skippable). `onDone` runs after the task is finished.
export async function completeTask(t, onDone) {
  if (timers[t.id]) {
    const r = await api.post(`/items/${t.id}/actual`, {});
    delete timers[t.id]; toast(summary(r)); await loadFocus(); onDone && onDone(); return;
  }
  const m = modal(`<h3 style="margin-top:0">How long did it take?</h3>
    <div class="small muted" style="margin-bottom:10px">${esc(t.content)}${t.est_minutes ? ` — you guessed ${fmtMin(t.est_minutes)}` : ""}. Optional, but it teaches the estimates.</div>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">${[5, 10, 15, 30, 60].map((n) => `<button class="btn ghost small fx-q" data-m="${n}">${fmtMin(n)}</button>`).join("")}
      <input type="number" id="fx-min" min="1" max="1440" placeholder="min" style="width:80px"></div>
    <div class="row" style="gap:8px"><button class="btn" id="fx-ok">Done</button><button class="btn ghost" id="fx-skip">Just mark done</button><div class="grow"></div><button class="btn ghost small" id="fx-cancel">Cancel</button></div>`);
  const finish = async (minutes) => {
    try {
      if (minutes) { const r = await api.post(`/items/${t.id}/actual`, { minutes }); toast(summary(r)); }
      else await api.patch("/items/" + t.id, { done: true, status: "approved" });
    } catch (e) { toast(e.message, true); }
    m.close(); await loadFocus(); onDone && onDone();
  };
  $$(".fx-q", m.el).forEach((b) => b.onclick = () => finish(+b.dataset.m));
  $("#fx-ok", m.el).onclick = () => { const v = parseInt($("#fx-min", m.el).value, 10); v > 0 ? finish(v) : toast("Enter the minutes, or use “Just mark done”", true); };
  $("#fx-skip", m.el).onclick = () => finish(0);
  $("#fx-cancel", m.el).onclick = () => { m.close(); onDone && onDone(); };
  setTimeout(() => $("#fx-min", m.el)?.focus());
}

// ── "I have N minutes" ───────────────────────────────────────────────────────

export function openFit(reload) {
  let minutes = 10, tag = "", changed = false;
  const m = modal(`<div id="fx-fit" style="min-width:min(520px,86vw)"></div>`);
  const close = () => { m.close(); if (changed) reload(); };
  m.el.addEventListener("click", (e) => { if (e.target === m.el) close(); });
  const box = m.el.querySelector("#fx-fit");
  const rowH = (t) => `<div class="task-row" data-id="${t.id}"><div class="body grow"><span class="content">${esc(t.content)}</span>
      ${t.est_minutes ? `<span class="chip est">~${fmtMin(t.est_minutes)}${t.adjusted_minutes !== t.est_minutes ? ` → likely ${fmtMin(t.adjusted_minutes)}` : ""}</span>` : `<span class="chip">no estimate</span>`}
      ${tagsOf(t).map((g) => `<span class="chip">${(TAGS.find((x) => x[0] === g) || [0, g])[1]}</span>`).join("")}</div>
      <button class="btn ghost small fx-go" title="${timers[t.id] ? "Finish" : "Start a timer on it"}">${timers[t.id] ? "✓ Done" : "▶ Start"}</button></div>`;
  const paint = async () => {
    let r;
    try { r = await api.get(`/focus/fit?minutes=${minutes}${tag ? "&tag=" + tag : ""}`); }
    catch (e) { box.innerHTML = `<div class="center">${esc(e.message)}</div>`; return; }
    factor = r.factor;
    const preset = [10, 20, 30].includes(minutes);
    box.innerHTML = `<h3 style="margin-top:0">I have… <span class="muted small">(what fits?)</span></h3>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">
        ${[10, 20, 30].map((n) => `<button class="btn small ${minutes === n ? "" : "ghost"} fx-m" data-m="${n}">${n} min</button>`).join("")}
        <input type="number" id="fx-custom" min="1" max="1440" placeholder="other" value="${preset ? "" : minutes}" style="width:76px" aria-label="Custom minutes">
        <select id="fx-tag" aria-label="Where"><option value="">Anywhere</option>${TAGS.map(([k, l]) => `<option value="${k}" ${tag === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="small muted" style="margin-bottom:8px">${factorNote()}</div>
      ${r.fits.length ? `<div class="card">${r.fits.map(rowH).join("")}</div>` : `<div class="small muted" style="margin:8px 0">Nothing with an estimate fits ${minutes} minutes${tag ? " here" : ""}${r.too_long ? ` (${r.too_long} longer task${r.too_long === 1 ? "" : "s"} skipped)` : ""}.</div>`}
      ${r.unknown.length ? `<div class="small muted" style="margin:12px 0 4px">No estimate yet — could be quick, could not:</div><div class="card">${r.unknown.map(rowH).join("")}</div>` : ""}
      <div class="row" style="margin-top:12px"><div class="grow"></div><button class="btn ghost small" id="fx-close">Close</button></div>`;
    $$(".fx-m", box).forEach((b) => b.onclick = () => { minutes = +b.dataset.m; paint(); });
    $("#fx-custom", box).onchange = (e) => { const v = parseInt(e.target.value, 10); if (v > 0) { minutes = Math.min(1440, v); paint(); } };
    $("#fx-tag", box).onchange = (e) => { tag = e.target.value; paint(); };
    $("#fx-close", box).onclick = close;
    $$(".fx-go", box).forEach((b) => b.onclick = async () => {
      const id = b.closest(".task-row").dataset.id;
      const t = [...r.fits, ...r.unknown].find((x) => x.id === id);
      try {
        if (timers[id]) { await completeTask(t, () => { changed = true; paint(); }); }
        else { await api.post(`/items/${id}/timer/start`); timers[id] = new Date().toISOString(); changed = true; toast("Timer started — hit Done here when finished"); paint(); }
      } catch (e) { toast(e.message, true); }
    });
  };
  paint();
}
