// Large-map switches for the Brain map. A map with more nodes than PERF_NODES takes the "large" paths:
//   * physics runs in a Web Worker (or, if that is unavailable, in small time slices on the main thread) instead of
//     being settled synchronously before the first frame (physics-core.js, sim-large.js, physics-worker.js)
//   * the draw loop batches edges and nodes into a few paths, skips everything off screen, and drops labels while the
//     map is being panned / zoomed / settling (engine.js)
// Maps at or below PERF_NODES keep the original code paths untouched, so they look exactly as they always did.
//
// For testing, localStorage "bdl-graph-perf-nodes" overrides the threshold (0 forces the large paths on any map,
// 100000 forces the original ones on a big map).
export const DEFAULT_PERF_NODES = 1500;

function threshold() {
  try {
    const raw = localStorage.getItem("bdl-graph-perf-nodes");
    const v = raw === null ? NaN : parseInt(raw, 10);
    if (v >= 0) return v;
  } catch { /* storage unavailable: use the default */ }
  return DEFAULT_PERF_NODES;
}
export const PERF_NODES = threshold();

/** True when a map of `nodeCount` nodes should use the large-map code paths. */
export const isLargeMap = (nodeCount) => nodeCount > PERF_NODES;

/** After the last pan / zoom / drag / physics movement, wait this long before restoring full detail (labels). */
export const LOD_IDLE_MS = 140;

/** While the map moves, a map with more edges than this draws only about this many of them (evenly thinned). */
export const LOD_EDGES = 1500;

/** Main-thread fallback only: how long one animation frame may spend on physics steps. */
export const INLINE_STEP_BUDGET_MS = 7;

/** Large maps stroke their edges in this many interleaved batches per style: one batch would merge overlapping
 *  lines into a single flat shape, many batches keep the "denser where more links cross" look. */
export const EDGE_BATCHES = 6;
