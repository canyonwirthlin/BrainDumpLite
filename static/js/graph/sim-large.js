// Main-thread driver for the large-map simulation (see perf.js). It owns either a module Web Worker running
// physics-worker.js, or - when a worker cannot be created or never answers - an inline copy of the same core that is
// stepped in small time slices from the animation loop. Either way the engine sees the same small api:
//
//   drv.alpha / drv.setAlpha(a)   temperature (a setter is wired onto sim.alpha, so plugins can still reheat)
//   drv.pull()                    copy the newest positions into the node objects; true when anything moved
//   drv.run(budgetMs)             inline mode only: spend up to budgetMs on physics steps
//   drv.syncPins()                tell the simulation about nodes whose fx/fy changed (drag, double-click release)
//   drv.setEnv(env)               canvas size / spacing changed
//   drv.mode                      "worker" | "inline" ; drv.dispose() terminates the worker
import { packSim, createCore, coreRun, corePin, corePositions } from "./physics-core.js";

const WATCHDOG_MS = 6000;   // no message from a fresh worker for this long: assume it cannot run here

export function createLargeSim({ nodes, edges, forces, getEnv, alpha, decay, useWorker = true }) {
  const n = nodes.length;
  const init = packSim(nodes, edges, forces, getEnv(), alpha, decay);
  let cur = alpha, epoch = 0, disposed = false;
  let worker = null, core = null, pending = null, watchdog = 0, heard = false;
  const sentPin = Uint8Array.from(init.pinned), sentX = Float64Array.from(init.fx), sentY = Float64Array.from(init.fy);
  const sentEnv = { ...init.env };

  const drv = {
    mode: "inline", n,
    get alpha() { return cur; },
    setAlpha(a) {
      cur = a; epoch++;
      if (worker) worker.postMessage({ t: "alpha", a, epoch });
      else if (core) core.alpha = a;
    },
    setEnv(env) {
      if (env.W === sentEnv.W && env.H === sentEnv.H && env.spacing === sentEnv.spacing) return;
      sentEnv.W = env.W; sentEnv.H = env.H; sentEnv.spacing = env.spacing;
      if (worker) worker.postMessage({ t: "env", env: { ...sentEnv } });
      else if (core) { core.env.W = env.W; core.env.H = env.H; core.env.spacing = env.spacing; }
    },
    syncPins() {
      let list = null;
      for (let i = 0; i < n; i++) {
        const nd = nodes[i], pinned = nd.fx != null ? 1 : 0;
        if (pinned === sentPin[i] && (!pinned || (nd.fx === sentX[i] && nd.fy === sentY[i]))) continue;
        sentPin[i] = pinned; sentX[i] = pinned ? nd.fx : 0; sentY[i] = pinned ? nd.fy : 0;
        (list ||= []).push(i, pinned, pinned ? nd.fx : nd.x, pinned ? nd.fy : nd.y);
      }
      if (!list) return;
      if (worker) worker.postMessage({ t: "pin", list });
      else if (core) for (let k = 0; k < list.length; k += 4) corePin(core, list[k], list[k + 1], list[k + 2], list[k + 3]);
    },
    run(budgetMs) {
      if (!core || core.alpha <= 0.01) return false;
      coreRun(core, budgetMs);
      cur = core.alpha;
      pending = corePositions(core);
      return true;
    },
    pull() {
      const xy = pending;
      if (!xy) return false;
      pending = null;
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const nd = nodes[i];
        if (nd.fx != null) { nd.x = nd.fx; nd.y = nd.fy; continue; }   // a pinned node stays under the pointer, no round trip
        nd.x = xy[j]; nd.y = xy[j + 1];
      }
      return true;
    },
    dispose() {
      disposed = true; clearTimeout(watchdog);
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
      core = null; pending = null;
    },
  };

  function toInline() {
    if (disposed || core) return;
    clearTimeout(watchdog);
    if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
    // continue from where the nodes are now (the worker's velocities are lost, which only means a slightly calmer start)
    const resume = packSim(nodes, edges, forces, { W: sentEnv.W, H: sentEnv.H, spacing: sentEnv.spacing }, cur, decay);
    core = createCore(resume);
    drv.mode = "inline";
  }

  if (useWorker && typeof Worker === "function") {
    try {
      worker = new Worker(new URL("./physics-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (disposed || !m || m.t !== "pos") return;
        heard = true; clearTimeout(watchdog);
        pending = m.xy;
        if (m.epoch === epoch) cur = m.alpha;   // a stale reply must not undo a reheat that is still on its way
      };
      worker.onerror = () => toInline();
      worker.onmessageerror = () => toInline();
      worker.postMessage({ t: "init", init });
      watchdog = setTimeout(() => { if (!heard) toInline(); }, WATCHDOG_MS);
      drv.mode = "worker";
    } catch { worker = null; }
  }
  if (!worker) { core = createCore(init); drv.mode = "inline"; }
  return drv;
}
