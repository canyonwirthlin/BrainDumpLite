// Time-lapse: the finished layout stays put while nodes appear as their first dump is reached.
//
// installTimelapse(api) is called once per api (the view does it). It owns the playback state, registers the
// `alive(n)` predicate with the engine (api.setNodeVisibility) and is driven by the engine's "tick" event. The
// transport bar (timelapse-bar.js) is drawn inside the map wrap while a time-lapse is active or paused.
//
// Controller, exposed as `api.timelapse` (what a start button / other modules should use):
//   start() -> bool         begin at the first dump and play (restarts if already running); false when < 2 dumps
//   stop()                  close the time-lapse (also Esc); toggle() -> start or stop
//   play() / pause()        resume (replays from the start when it already reached the end) / pause
//   seek(t) step(+1|-1)     jump to a time (ms) / to the next or previous dump; both pause nothing by themselves
//   setSpeed(0.5|1|2|4) setLoop(bool) setFollow(bool)    persisted preferences
//   toggleRecording()       record one full playback to a WebM file, or stop and save the one in progress
//   shownCount()            dumps visible at the current time
//   active / playing        a time-lapse is open (playing kept for older callers: it means "active")
//   running                 actually advancing (open and not paused)
//   onChange(fn(active))    subscribe to open/close/play/pause; returns an unsubscribe function
//   state                   { on, playing, cur, from, to, speed, loop, follow, rec, times ... }
// Keys while it is active (and not typing): Space play/pause, Left/Right step, Esc close.
// The old one-button UI is still available as mountTimelapseUI(container, api) and is also mounted into
// #graph-slot-timelapse by this module when that slot exists and is empty.
import { $, toast } from "../ui.js";
import { hide } from "./infobox.js";
import { prefs } from "./prefs.js";
import { createBar, SPEEDS } from "./timelapse-bar.js";
import { canRecordCanvas, startCanvasRecording } from "./timelapse-record.js";
import { dateStamp } from "./export-common.js";
import { saveBlob } from "./export-save.js";

const DAY = 864e5, PULSE_MS = 900, MAX_NEW_PULSES = 40, MAX_PULSES = 150;
const bool = { parse: (raw) => raw === "1", serialize: (v) => (v ? "1" : "0") };
prefs.define("tlSpeed", { key: "bdl-graph-tl-speed", def: 1, parse: (raw) => { const v = parseFloat(raw); return SPEEDS.includes(v) ? v : undefined; } });
prefs.define("tlLoop", { key: "bdl-graph-tl-loop", def: false, ...bool });
prefs.define("tlFollow", { key: "bdl-graph-tl-follow", def: false, ...bool });

const controllers = new WeakMap();   // api -> controller
const upper = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m + 1; else hi = m; } return lo; };   // how many entries are <= t
const fmtLong = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function installTimelapse(api) {
  const tl = {
    on: false, playing: false, cur: 0, from: 0, to: 0, ms: 0, last: 0, holdUntil: 0, holdKind: "",
    speed: prefs.get("tlSpeed"), loop: prefs.get("tlLoop"), follow: prefs.get("tlFollow"),
    dumps: [], unit: "dump", times: [], borns: [], byBorn: [], target: null, rec: null, origView: null, lastSet: null, followed: false, interrupted: false,
  };
  const listeners = new Set();
  let bar = null, pulses = [];
  const emitState = () => listeners.forEach((fn) => { try { fn(tl.on); } catch (e) { console.error("time-lapse listener failed:", e); } });
  const live = () => !!(api.canvas && api.canvas.isConnected);

  /** Layouts that hide dumps (concept map, people x concepts grid) leave concepts and people with no dump on the map to take
   *  their first-seen time from: look it up in the unfiltered dataset, like the engine does for the full map. */
  function fillBorn() {
    const missing = api.nodes.filter((n) => !n.born);
    const data = api.viewState && api.viewState.data;
    if (!missing.length || !data) return;
    const when = new Map();
    for (const d of data.nodes) if (d.type === "dump") { const t = Date.parse(d.created_at || ""); if (!Number.isNaN(t)) when.set(d.id, t); }
    const first = new Map();
    const note = (id, dumpId) => { const t = when.get(dumpId); if (t && !(first.get(id) <= t)) first.set(id, t); };
    for (const e of data.edges) { if (when.has(e.source)) note(e.target, e.source); if (when.has(e.target)) note(e.source, e.target); }
    for (const n of missing) { const t = first.get(n.id); if (t) n.born = t; }
  }

  /** Read the (filtered) map: when each dump was written and the order everything appears in. When the layout shows no
   *  dumps the topics themselves are the timeline. false if there are fewer than two dated things. */
  function prepare() {
    fillBorn();
    let dumps = api.nodes.filter((n) => n.type === "dump" && n.born);
    tl.unit = "dump";
    if (dumps.length < 2) { dumps = api.nodes.filter((n) => n.born > 0); tl.unit = "topic"; }
    dumps.sort((a, b) => a.born - b.born);
    if (dumps.length < 2) return false;
    tl.dumps = dumps;
    tl.times = dumps.map((n) => n.born);
    tl.from = tl.times[0] - DAY;
    tl.to = tl.times[tl.times.length - 1];
    tl.ms = Math.min(14000, 3500 + dumps.length * 350);   // one pass at 1x
    tl.byBorn = api.nodes.slice().sort((a, b) => a.born - b.born);
    tl.borns = tl.byBorn.map((n) => n.born);
    return true;
  }

  function resetPass() { pulses = []; tl.target = null; tl.holdUntil = 0; }
  function destroyBar() { bar?.destroy(); bar = null; }
  function showBar() {
    destroyBar();
    const wrap = api.wrap;
    if (wrap) bar = createBar(wrap, ctl);
  }

  /** Move the playhead. Forward moves make the nodes they pass pulse (unless it is a big jump). */
  function setCur(t) {
    const prev = tl.cur;
    tl.cur = Math.min(tl.to, Math.max(tl.from, t));
    if (tl.cur > prev) {
      const a = upper(tl.borns, prev), b = upper(tl.borns, tl.cur);
      if (b > a) {
        const fresh = tl.byBorn.slice(a, b);
        const dumps = tl.unit === "topic" ? fresh : fresh.filter((n) => n.type === "dump");
        tl.target = dumps.length ? dumps[dumps.length - 1] : fresh[fresh.length - 1];
        if (fresh.length <= MAX_NEW_PULSES) { const t0 = performance.now(); fresh.forEach((n) => pulses.push({ n, t0 })); if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES); }
      }
    } else if (tl.cur < prev) pulses = pulses.filter((p) => p.n.born <= tl.cur);
    api.requestDraw();
  }

  function restoreCamera() {
    if (tl.followed && !tl.interrupted && tl.origView && live()) { api.view.scale = tl.origView.scale; api.view.panX = tl.origView.panX; api.view.panY = tl.origView.panY; }
    tl.origView = null; tl.lastSet = null; tl.followed = false; tl.interrupted = false;
  }

  async function finishRecording(save) {
    const r = tl.rec;
    if (!r) return;
    tl.rec = null;
    clearInterval(r.watch);
    bar?.update();
    const blob = await (save ? r.session.stop() : r.session.cancel());
    if (!save) return;
    if (!blob || !blob.size) { toast("The recording came out empty. Try again.", true); return; }
    await saveBlob(blob, { name: `brain-map-timelapse-${dateStamp()}.webm`, ext: "webm", label: "time-lapse video" });
  }

  const ctl = {
    api, state: tl,
    get active() { return tl.on; },
    get playing() { return tl.on; },
    get running() { return tl.on && tl.playing; },
    /** True when node n has "appeared" at the current playback time (always true while no time-lapse is open). */
    alive: (n) => !tl.on || n.born <= tl.cur,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    shownCount: () => (tl.on ? upper(tl.times, tl.cur) : 0),
    /** "dump(s)", or "topic(s)" in layouts that show no dumps */
    noun: (n) => `${tl.unit === "topic" ? "topic" : "dump"}${n === 1 ? "" : "s"}`,
    label: () => `${fmtLong(tl.cur)} · ${ctl.shownCount()} ${ctl.noun(ctl.shownCount())}`,
    start() {
      if (tl.on) { tl.on = false; destroyBar(); }   // restart cleanly
      if (!live()) return false;
      if (!prepare()) { toast("Needs at least two dated dumps to play back."); return false; }
      Object.assign(tl, { on: true, playing: true, cur: tl.from, last: performance.now(), interrupted: false, followed: false, origView: null, lastSet: null });
      resetPass();
      api.select(null); hide();
      // The start button keeps focus after a click, and Space would then press it again (closing the time-lapse).
      try { if (document.activeElement && document.activeElement !== document.body && !document.activeElement.closest?.("#graph-tl-bar")) document.activeElement.blur(); } catch {}
      showBar();
      emitState();
      api.requestDraw();
      return true;
    },
    stop() {
      if (!tl.on) return;
      if (tl.rec) { finishRecording(false); toast("Recording cancelled."); }
      tl.on = false; tl.playing = false; tl.holdUntil = 0;
      destroyBar();
      pulses = [];
      restoreCamera();
      emitState();
      api.requestDraw();
    },
    toggle() { return tl.on ? (ctl.stop(), false) : ctl.start(); },
    play() {
      if (!tl.on) return;
      if (tl.cur >= tl.to) { resetPass(); setCur(tl.from); }
      tl.holdUntil = 0; tl.playing = true; tl.last = performance.now();
      bar?.update(); emitState();
    },
    pause() {
      if (!tl.on || !tl.playing) { tl.holdUntil = 0; return; }
      tl.playing = false; tl.holdUntil = 0;
      bar?.update(); emitState(); api.requestDraw();
    },
    seek(t) { if (!tl.on) return; tl.holdUntil = 0; setCur(t); bar?.update(); },
    step(dir) {
      if (!tl.on) return;
      ctl.pause();
      const c = upper(tl.times, tl.cur);
      if (dir > 0) setCur(c < tl.times.length ? tl.times[c] : tl.to);
      else { const i = c > 0 && Math.abs(tl.times[c - 1] - tl.cur) < 1 ? c - 2 : c - 1; setCur(i >= 0 ? tl.times[i] : tl.from); }
      if (dir < 0) tl.target = tl.dumps[upper(tl.times, tl.cur) - 1] || null;
      bar?.update();
    },
    setSpeed(v) { if (SPEEDS.includes(v)) { tl.speed = v; prefs.set("tlSpeed", v); bar?.update(); } },
    setLoop(v) { tl.loop = !!v; prefs.set("tlLoop", tl.loop); bar?.update(); },
    setFollow(v) {
      tl.follow = !!v; prefs.set("tlFollow", tl.follow);
      if (tl.follow) { tl.interrupted = false; tl.lastSet = null; if (!tl.origView && live()) tl.origView = { scale: api.view.scale, panX: api.view.panX, panY: api.view.panY }; }
      else tl.followed = false;
      bar?.update();
    },
    toggleRecording() {
      if (tl.rec) return finishRecording(true);
      if (!tl.on || !live()) return;
      let session = null;
      try { session = canRecordCanvas() ? startCanvasRecording(api.canvas) : null; } catch (e) { console.warn("recording failed to start", e); }
      if (!session) { toast("This window can't record video. Your computer's screen recorder will work instead.", true); return; }
      const canvas = api.canvas;
      tl.rec = { session, watch: setInterval(() => { if (!canvas.isConnected) { clearInterval(tl.rec?.watch); finishRecording(false); } }, 1000) };
      resetPass(); setCur(tl.from);
      tl.playing = true; tl.last = performance.now();
      toast("Recording one full playback. It saves when it reaches the end.");
      bar?.update(); emitState();
    },
  };
  controllers.set(api, ctl);
  api.timelapse = ctl;
  api.setNodeVisibility(ctl.alive, "timelapse");

  // A rebuilt map (filter, layout, Focus ...) keeps the time-lapse where it was; it only stops when too few dumps remain.
  api.on("nodesChanged", () => {
    destroyBar();
    if (!tl.on) return;
    if (tl.rec) { finishRecording(false); toast("Recording cancelled because the map changed."); }
    const cur = tl.cur, was = tl.playing;
    if (!prepare()) { tl.on = false; tl.playing = false; pulses = []; tl.origView = null; tl.followed = false; emitState(); toast("The time-lapse closed: with these filters fewer than two dumps are left."); return; }
    pulses = []; tl.target = null; tl.holdUntil = 0; tl.lastSet = null;
    tl.cur = Math.min(tl.to, Math.max(tl.from, cur));
    tl.playing = was && tl.cur < tl.to;
    tl.last = performance.now();
    showBar();
    api.requestDraw();
  });

  api.on("keydown", ({ e }) => {
    if (!tl.on || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = e.target && e.target.tagName === "BUTTON";
    if ((e.key === " " || e.code === "Space") && !onButton) { e.preventDefault(); tl.playing ? ctl.pause() : ctl.play(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); ctl.step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); ctl.step(-1); }
    else if (e.key === "Escape") { e.preventDefault(); ctl.stop(); }
  });

  /** Ease the camera to the newest node; gives up (and turns Follow off) as soon as the user pans or zooms. */
  function follow(dt) {
    const n = tl.target;
    if (!tl.follow || !n || !live() || tl.interrupted) return;
    if (api.sim && api.sim.alpha > 0.01 && !api.layout?.fixed) return;   // physics is still re-framing the map
    const v = api.view, ls = tl.lastSet;
    if (ls && (Math.abs(v.panX - ls.panX) > 0.75 || Math.abs(v.panY - ls.panY) > 0.75 || Math.abs(v.scale - ls.scale) > 0.004)) {
      tl.follow = false; tl.interrupted = true; bar?.update(); return;
    }
    if (!tl.origView) tl.origView = { scale: v.scale, panX: v.panX, panY: v.panY };
    const k = 1 - Math.exp(-dt / 260);
    const s = v.scale + (Math.max(tl.origView.scale, 1.1) - v.scale) * k;
    const gx = api.width / 2 - s * n.x, gy = api.height / 2 - s * n.y;
    const dx = (gx - v.panX) * k, dy = (gy - v.panY) * k;
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(s - v.scale) < 0.0005) return;
    v.scale = s; v.panX += dx; v.panY += dy;
    tl.lastSet = { scale: v.scale, panX: v.panX, panY: v.panY };
    tl.followed = true;
  }

  api.on("tick", () => {
    if (!tl.on) return;
    if (!live()) return;
    const now = performance.now();
    const dt = Math.min(100, Math.max(0, now - (tl.last || now)));
    tl.last = now;
    let busy = false;
    if (tl.holdUntil) {
      busy = true;
      if (now >= tl.holdUntil) {
        const kind = tl.holdKind;
        tl.holdUntil = 0;
        if (kind === "rec") finishRecording(true);
        else if (kind === "loop" && tl.loop) { resetPass(); setCur(tl.from); tl.playing = true; }
      }
    } else if (tl.playing) {
      busy = true;
      setCur(tl.cur + (dt * tl.speed * (tl.to - tl.from)) / tl.ms);
      if (tl.cur >= tl.to) {
        tl.playing = false;
        if (tl.rec) { tl.holdUntil = now + 900; tl.holdKind = "rec"; }
        else if (tl.loop) { tl.holdUntil = now + 1000; tl.holdKind = "loop"; }
        emitState();
      }
    }
    follow(dt);
    if (pulses.length) { pulses = pulses.filter((p) => now - p.t0 < PULSE_MS); busy = true; }
    if (busy || tl.rec) api.requestDraw();
    bar?.update();
  });

  // Growth rings on nodes that just appeared, and (while recording) the date burned into the video frames.
  api.on("afterDraw", ({ ctx }) => {
    if (!tl.on) return;
    if (pulses.length) {
      const now = performance.now(), sc = Math.max(0.05, api.view.scale), C = api.colors;
      ctx.save();
      for (const p of pulses) {
        const k = (now - p.t0) / PULSE_MS;
        if (k >= 1 || !api.isVisible(p.n)) continue;
        ctx.globalAlpha = 0.85 * (1 - k) * (1 - k);
        ctx.strokeStyle = C.colors[p.n.type] || C.dump;
        ctx.lineWidth = 2.2 / sc;
        ctx.beginPath(); ctx.arc(p.n.x, p.n.y, p.n.r + (3 + 20 * k) / sc, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    if (tl.rec) {
      const k = ctx.canvas.width / (api.width || 1), C = api.colors;
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.globalAlpha = 1;
      ctx.font = "600 15px sans-serif";
      const text = ctl.label(), w = ctx.measureText(text).width + 24, h = 32, x = 16, y = api.height - h - 16;
      ctx.fillStyle = C.bg; ctx.globalAlpha = 0.88;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 16); else ctx.rect(x, y, w, h); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = C.text; ctx.textBaseline = "middle";
      ctx.fillText(text, x + 12, y + h / 2 + 0.5);
      ctx.restore();
    }
  });
  return ctl;
}

/** The one-button start/stop control (kept for the toolbar and for #graph-slot-timelapse). */
export function mountTimelapseUI(container, api) {
  container.__tlOff?.();
  container.innerHTML = `<button class="btn ghost small" id="graph-tl-btn" title="Watch your map grow, dump by dump">▶ Time-lapse</button>`;
  const btn = $("#graph-tl-btn", container);
  const ctl = controllers.get(api) || api.timelapse;
  const paint = (on) => { btn.textContent = on ? "■ Stop" : "▶ Time-lapse"; };
  btn.onclick = () => ctl.toggle();
  container.__tlOff = ctl.onChange(paint);
  paint(ctl.active);
  return btn;
}

// New control panel: it renders an empty #graph-slot-timelapse and fires "bdl-graph-panel-rendered" after each
// render. Fill the slot (once, and again after a re-render) unless a start button is already there.
function mountIntoSlot() {
  const slot = document.getElementById("graph-slot-timelapse"), api = window.__bdlGraph;
  if (!slot || !api || !api.timelapse || slot.children.length || document.getElementById("graph-tl-btn")) return;
  mountTimelapseUI(slot, api);
}
if (typeof window !== "undefined" && !window.__bdlTlSlotHook) {
  window.__bdlTlSlotHook = true;
  window.addEventListener("bdl-graph-panel-rendered", mountIntoSlot);
}
