// Web Worker that settles a large Brain map's layout off the main thread (see perf.js, sim-large.js).
//
// Protocol (all messages are plain objects):
//   main -> worker  { t: "init", init }               packSim() result: starts the simulation
//                   { t: "alpha", a, epoch }          set the temperature (reheat / warm); wakes an idle worker
//                   { t: "pin", list: [i, pinned, x, y, ...] }   pin / release nodes (released = free from x, y)
//                   { t: "env", env }                 canvas size / spacing changed
//   worker -> main  { t: "pos", xy: Float32Array(2n), alpha, epoch }   latest positions (transferred), ~every 14 ms
// The worker never runs while the layout is settled; it sleeps until a message raises alpha again.
import { createCore, coreStep, corePin, corePositions } from "./physics-core.js";

let core = null, epoch = 0, lastPost = 0, dirty = false, scheduled = false;
const SLICE_MS = 12, POST_EVERY_MS = 14;
const chan = new MessageChannel();   // yields between slices without the 4 ms timer clamp, so incoming messages still get through
chan.port1.onmessage = pump;

function wake() { if (!scheduled) { scheduled = true; chan.port2.postMessage(0); } }

function post() {
  const xy = corePositions(core);
  self.postMessage({ t: "pos", xy, alpha: core.alpha, epoch }, [xy.buffer]);
  lastPost = performance.now(); dirty = false;
}

function pump() {
  scheduled = false;
  if (!core) return;
  const t0 = performance.now();
  while (core.alpha > 0.01 && performance.now() - t0 < SLICE_MS) { coreStep(core); dirty = true; }
  if (dirty && (performance.now() - lastPost >= POST_EVERY_MS || core.alpha <= 0.01)) post();
  if (core.alpha > 0.01) wake();
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (!m) return;
  if (m.t === "init") { core = createCore(m.init); epoch = 0; post(); wake(); }
  else if (!core) return;
  else if (m.t === "alpha") { core.alpha = m.a; epoch = m.epoch; dirty = true; if (core.alpha <= 0.01) post(); wake(); }
  else if (m.t === "env") { core.env.W = m.env.W; core.env.H = m.env.H; core.env.spacing = m.env.spacing; }
  else if (m.t === "pin") { for (let k = 0; k < m.list.length; k += 4) corePin(core, m.list[k], m.list[k + 1], m.list[k + 2], m.list[k + 3]); dirty = true; wake(); }
};
