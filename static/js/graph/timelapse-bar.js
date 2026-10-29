// The time-lapse transport bar: a floating, theme-aware strip at the bottom of the map (inside #graph-wrap) with
// play/pause, step, a scrub slider with month/year ticks and a dump-density sketch, speed, loop, follow-newest,
// Record and Close. It only draws and forwards clicks: all state lives in the controller (timelapse.js).
// The bar is DOM inside the map wrap, so a rebuilt map destroys it; the controller makes a fresh one.
import { esc } from "../ui.js";

export const SPEEDS = [0.5, 1, 2, 4];

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z" fill="currentColor"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM4 5v14l10.5-7z" fill="currentColor"/></svg>',
  loop: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  follow: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
  rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Month/year tick marks for the span [from, to] on a track `px` pixels wide:
 *  [{ pct, label }] (label "" = a bare mark). Pure; exported for tests. */
export function tickMarks(from, to, px) {
  const span = to - from;
  if (!(span > 0) || !(px > 0)) return [];
  const out = [];
  const d0 = new Date(from);
  let y = d0.getFullYear(), m = d0.getMonth();
  const first = new Date(y, m, 1).getTime() < from ? m + 1 : m;   // first month start inside the span
  const months = Math.max(1, Math.round(span / 2629800000));
  const perMonthPx = px / months;
  const step = [1, 2, 3, 6, 12, 24, 60].find((s) => s * perMonthPx >= 46) || 120;
  const showMarks = perMonthPx >= 3.2;
  for (let i = first, guard = 0; guard < 1200; i++, guard++) {
    const yy = y + Math.floor(i / 12), mm = ((i % 12) + 12) % 12;
    const t = new Date(yy, mm, 1).getTime();
    if (t > to) break;
    const idx = yy * 12 + mm;
    const labelled = idx % step === 0;
    if (!labelled && !showMarks) continue;
    out.push({ pct: ((t - from) / span) * 100, label: labelled ? (mm === 0 || step >= 12 ? String(yy) : MONTHS[mm]) : "", major: mm === 0 });
  }
  return out;
}

/** Create the bar, append it to `wrap` and return { el, update(), destroy() }. `ctl` is the time-lapse controller. */
export function createBar(wrap, ctl) {
  const tl = ctl.state;
  const el = document.createElement("div");
  el.id = "graph-tl-bar";
  el.className = "tl-bar";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Time-lapse controls");
  el.innerHTML = `
    <div class="tl-ctrl">
      <button type="button" class="tl-btn" data-act="back" title="Previous dump (Left arrow)" aria-label="Previous dump">${ICON.back}</button>
      <button type="button" class="tl-btn tl-play" data-act="play" title="Play (Space)" aria-label="Play">${ICON.play}</button>
      <button type="button" class="tl-btn" data-act="fwd" title="Next dump (Right arrow)" aria-label="Next dump">${ICON.fwd}</button>
    </div>
    <div class="tl-readout"><b class="tl-date"></b><span class="tl-count"></span></div>
    <div class="tl-track">
      <div class="tl-density" aria-hidden="true"></div>
      <input class="tl-range" type="range" min="0" max="1000" step="1" value="0" aria-label="Time-lapse position" title="Drag to scrub through time">
      <div class="tl-ticks" aria-hidden="true"></div>
    </div>
    <div class="tl-ctrl tl-right">
      <select class="tl-speed" aria-label="Playback speed" title="Playback speed">${SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join("")}</select>
      <button type="button" class="tl-btn tl-toggle" data-act="loop" title="Loop: start over when it ends" aria-label="Loop" aria-pressed="false">${ICON.loop}</button>
      <button type="button" class="tl-btn tl-toggle" data-act="follow" title="Follow the newest dump with the camera" aria-label="Follow newest" aria-pressed="false">${ICON.follow}</button>
      <button type="button" class="tl-btn tl-recbtn" data-act="rec" title="Record one playback as a video file (WebM)" aria-label="Record video"><i class="tl-recdot">${ICON.rec}</i><span class="tl-reclabel">Record</span></button>
      <button type="button" class="tl-btn" data-act="close" title="Close the time-lapse (Esc)" aria-label="Close time-lapse">${ICON.close}</button>
    </div>`;
  wrap.appendChild(el);

  const q = (s) => el.querySelector(s);
  const range = q(".tl-range"), speed = q(".tl-speed"), ticks = q(".tl-ticks"), density = q(".tl-density");
  const playBtn = q(".tl-play"), dateEl = q(".tl-date"), countEl = q(".tl-count");
  const recBtn = q(".tl-recbtn"), recLabel = q(".tl-reclabel");
  const btn = (a) => q(`[data-act="${a}"]`);
  let dragging = false, last = {};

  // Keep the pointer from reaching the map underneath (hover cards, node hit-testing).
  el.addEventListener("mousemove", (e) => e.stopPropagation());
  el.addEventListener("mouseenter", () => ctl.api.hover(null));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !el.contains(b)) return;
    ({ back: () => ctl.step(-1), fwd: () => ctl.step(1), play: () => (ctl.playing && tl.playing ? ctl.pause() : ctl.play()),
       loop: () => ctl.setLoop(!tl.loop), follow: () => ctl.setFollow(!tl.follow), rec: () => ctl.toggleRecording(), close: () => ctl.stop() })[b.dataset.act]?.();
  });
  range.addEventListener("pointerdown", () => { dragging = true; });
  const endDrag = () => { dragging = false; };
  range.addEventListener("pointerup", endDrag);
  range.addEventListener("pointercancel", endDrag);
  range.addEventListener("blur", endDrag);
  range.addEventListener("input", () => { ctl.pause(); ctl.seek(tl.from + ((tl.to - tl.from) * range.value) / 1000); });
  speed.addEventListener("change", () => { ctl.setSpeed(parseFloat(speed.value)); speed.blur(); });

  function paintStatic() {
    // dump-density sketch behind the slider
    const bins = 48, counts = new Array(bins).fill(0), span = tl.to - tl.from;
    for (const t of tl.times) counts[Math.min(bins - 1, Math.floor(((t - tl.from) / span) * bins))]++;
    const max = Math.max(1, ...counts);
    density.innerHTML = counts.map((c) => `<i style="height:${c ? Math.max(12, Math.round(Math.sqrt(c / max) * 100)) : 0}%"></i>`).join("");
    paintTicks();
  }
  function paintTicks() {
    const px = ticks.clientWidth || el.clientWidth * 0.4;
    const key = Math.round(px / 8) + ":" + tl.from + ":" + tl.to;
    if (key === last.ticks) return;
    last.ticks = key;
    ticks.innerHTML = tickMarks(tl.from, tl.to, px).map((t) => `<i class="tl-tick${t.major ? " major" : ""}" style="left:${t.pct.toFixed(2)}%"></i>${t.label ? `<span class="tl-tl${t.major ? " major" : ""}" style="left:${t.pct.toFixed(2)}%">${esc(t.label)}</span>` : ""}`).join("");
  }
  const publishHeight = () => { if (el.isConnected && el.offsetHeight) wrap.style.setProperty("--tl-off", el.offsetHeight + 28 + "px"); };
  let ro = null;
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => { paintTicks(); publishHeight(); }); ro.observe(el); }
  publishHeight();

  function set(key, value, apply) { if (last[key] !== value) { last[key] = value; apply(value); } }
  function update() {
    if (!el.isConnected) return;
    const span = tl.to - tl.from || 1;
    const frac = Math.min(1, Math.max(0, (tl.cur - tl.from) / span));
    if (!dragging) set("range", Math.round(frac * 1000), (v) => { range.value = v; });
    set("pct", Math.round(frac * 1000), (v) => { range.style.setProperty("--tl-pct", v / 10 + "%"); });
    const shown = ctl.shownCount();
    set("date", fmtDate(tl.cur), (v) => { dateEl.textContent = v; range.setAttribute("aria-valuetext", v); });
    set("count", `${shown}:${tl.unit}`, () => { countEl.textContent = ` · ${shown} ${ctl.noun(shown)}`; });
    const running = tl.playing;
    set("playing", running, (v) => {
      playBtn.innerHTML = v ? ICON.pause : ICON.play;
      playBtn.title = v ? "Pause (Space)" : (tl.cur >= tl.to ? "Play again (Space)" : "Play (Space)");
      playBtn.setAttribute("aria-label", v ? "Pause" : "Play");
    });
    set("canBack", tl.cur > tl.from, (v) => { btn("back").disabled = !v; });
    set("canFwd", tl.cur < tl.to, (v) => { btn("fwd").disabled = !v; });
    set("speed", tl.speed, (v) => { speed.value = String(v); });
    set("loop", tl.loop, (v) => { btn("loop").classList.toggle("on", v); btn("loop").setAttribute("aria-pressed", String(v)); });
    set("follow", tl.follow, (v) => { btn("follow").classList.toggle("on", v); btn("follow").setAttribute("aria-pressed", String(v)); });
    const secs = tl.rec ? Math.floor((performance.now() - tl.rec.session.started) / 1000) : -1;
    set("rec", secs, (s) => {
      recBtn.classList.toggle("recording", s >= 0);
      el.classList.toggle("is-recording", s >= 0);
      recLabel.textContent = s >= 0 ? `Stop · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "Record";
      recBtn.title = s >= 0 ? "Stop recording and save the video" : "Record one playback as a video file (WebM)";
      recBtn.setAttribute("aria-label", s >= 0 ? "Stop recording" : "Record video");
    });
  }

  paintStatic();
  update();
  return {
    el, update,
    destroy() { try { ro?.disconnect(); } catch {} el.remove(); wrap.style.removeProperty("--tl-off"); },
  };
}
