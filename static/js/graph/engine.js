// The canvas engine: node/edge model, pan/zoom, draw loop, hit-testing, input events and the plugin api + event bus.
//
// createGraphApi() builds ONE persistent `api` per visit to the Brain map view. api.mount(canvas, data) is called
// every time the filtered dataset changes (a fresh canvas each time); the api object, its event subscriptions and
// its overlay state survive those rebuilds, and "nodesChanged" fires after each one. Always read live values through
// `api` (api.nodes, api.view.scale ...) rather than caching them across a rebuild.
//
// Draw layers, bottom to top (all in WORLD coordinates, inside the pan/zoom transform):
//   beforeDraw event -> layout.drawUnder -> edges -> HULL_PAINTERS -> overlay.drawUnder -> nodes
//   -> overlay.drawOver -> labels -> afterDraw event
import { colorCss } from "../ui.js";
import { go } from "../router.js";
import { prefs, MIN_ZOOM, loadView, storeView, sessionViews, loadPins, savePins } from "./prefs.js";
import { getLayout } from "./layouts.js";
import { DEFAULT_FORCES, makeSim, step as physicsStep, hash01 } from "./physics.js";
import { HULL_PAINTERS, createOverlayRuntime } from "./overlays.js";
import { isLargeMap, LOD_IDLE_MS, LOD_EDGES, INLINE_STEP_BUDGET_MS, EDGE_BATCHES } from "./perf.js";
import { createLargeSim } from "./sim-large.js";

const GRAPH_R = { dump: 7, concept: 5, person: 5 };
const ITEM_R = 3.5;

export const edgeKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

// Node/label colors follow the active theme; item-type colors come from /graph/types.
export function resolveColor(c) {
  const css = colorCss(c);
  if (css.startsWith("var(")) return getComputedStyle(document.documentElement).getPropertyValue(css.slice(4, -1)).trim() || "#999";
  return css;
}
export function graphColors(types) {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  const colors = {};
  for (const t of types) colors[t.id] = resolveColor(t.color);
  return { colors, bg: v("--bg", "#0b0e14"), text: v("--text", "#e6e9f2"), edge: v("--dim", "#8b93a8"), dump: colors.dump || v("--accent", "#8b7cf6") };
}

/** env: { getTypes() -> node types }. Returns the persistent api (see docs/graph-architecture.md). */
export function createGraphApi({ getTypes }) {
  const handlers = {};
  let E = null;                       // the currently mounted engine instance
  let highlight = null;               // { nodes: Set(id), edges: Set(edgeKey) } - everything else dims (Path uses this)
  const visibility = new Map();       // id -> pred(node): a node is drawn only while every predicate passes

  const on = (evt, fn) => { (handlers[evt] ||= new Set()).add(fn); return () => handlers[evt].delete(fn); };
  const emit = (evt, payload = {}) => {
    const set = handlers[evt];
    if (set && set.size) for (const fn of [...set]) { try { fn(payload, api); } catch (e) { console.error(`graph "${evt}" handler failed:`, e); } }
    return payload;
  };
  const live = (get, dflt) => (E ? get(E) : dflt);

  const view = {
    get scale() { return live((e) => e.scale, 1); }, set scale(v) { if (E) E.scale = v; },
    get panX() { return live((e) => e.panX, 0); }, set panX(v) { if (E) E.panX = v; },
    get panY() { return live((e) => e.panY, 0); }, set panY(v) { if (E) E.panY = v; },
    /** client (viewport) coordinates -> world coordinates */
    toWorld: (cx, cy) => (E ? E.toWorld(cx, cy) : { x: 0, y: 0 }),
    /** world coordinates -> client (viewport) coordinates, the same space as MouseEvent.clientX/Y */
    toScreen: (x, y) => {
      if (!E) return { x: 0, y: 0 };
      const rect = E.canvas.getBoundingClientRect();
      return { x: rect.left + E.panX + E.scale * x, y: rect.top + E.panY + E.scale * y };
    },
  };

  const api = {
    on, emit, view, prefs,
    get nodes() { return live((e) => e.nodes, []); },
    get edges() { return live((e) => e.edges, []); },
    get byId() { return live((e) => e.byId, {}); },
    get nbrIds() { return live((e) => e.sim.nbrIds, {}); },
    get sim() { return live((e) => e.sim, null); },
    /** Timing counters of the mounted map (node/edge counts, settle steps, ms per step / frame): for tuning and tests. */
    get perf() { return live((e) => e.stats, null); },
    get canvas() { return live((e) => e.canvas, null); },
    get wrap() { return live((e) => e.wrap, null); },
    get colors() { return live((e) => e.colors, graphColors(getTypes())); },
    get layout() { return live((e) => e.layout, null); },
    get width() { return live((e) => e.W(), 0); },
    get height() { return live((e) => e.H(), 0); },
    get selectedId() { return live((e) => e.selectedId, null); },
    get hoverId() { return live((e) => e.hoverId, null); },
    get spacing() { return prefs.get("spacing"); },
    get highlight() { return highlight; },
    /** { W, H, spacing } - what physics.js placement/step functions want as `env` */
    env: () => (E ? E.syncEnv() : { W: 0, H: 0, spacing: prefs.get("spacing") }),
    neighborsOf: (id, hops = 1) => (E ? E.neighborsOf(id, hops) : new Set([id])),
    select: (id) => E?.select(id),
    hover: (id) => E?.setHover(id),
    requestDraw: () => E?.requestDraw(),
    reheat: () => E?.reheat(),
    fit: () => E?.refit(),
    /** Select a node and centre/zoom on it. Returns false when it isn't on the map (filtered out). */
    focusOn: (id) => (E ? E.focusOn(id) : false),
    /** setNodeVisibility(pred, id = "default"): draw only nodes for which every registered pred returns true; pred = null removes it. */
    setNodeVisibility(pred, id = "default") { if (pred) visibility.set(id, pred); else visibility.delete(id); E?.requestDraw(); },
    /** True when node n passes every registered visibility predicate (what the draw loop uses; export tools read it). */
    isVisible(n) { for (const p of visibility.values()) if (!p(n)) return false; return true; },
    /** setHighlight({ nodes: Set(id), edges: Set(edgeKey(a,b)) } | null): emphasise those, dim everything else. */
    setHighlight(h) { highlight = h || null; E?.requestDraw(); },
    edgeKey,
    snapshot: () => E?.snapshot(),
    mount(canvas, data) { return mountInstance(canvas, data); },
  };
  api.overlays = createOverlayRuntime(api);
  on("nodesChanged", () => api.overlays.reload());   // first subscriber, so overlay state loads before plugin handlers run

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  function mountInstance(canvas, data0) {
    E?.dispose();
    const wrap = canvas.parentElement;
    const ctx = canvas.getContext("2d");
    const GC = graphColors(getTypes());
    const H = () => wrap.clientHeight;
    const W = () => wrap.clientWidth;
    const layout = getLayout(prefs.get("layout"));
    const forces = { ...DEFAULT_FORCES, ...(layout.forces || {}) };
    const fixed = !!layout.fixed;
    const data = layout.prepare ? layout.prepare(data0, api) || data0 : data0;

    const degree = {};
    data.edges.forEach((e) => { degree[e.source] = (degree[e.source] || 0) + 1; degree[e.target] = (degree[e.target] || 0) + 1; });
    const nodes = data.nodes.map((n) => ({
      ...n, vx: 0, vy: 0, fx: null, fy: null, x: 0, y: 0, tx: null, ty: null, deg: degree[n.id] || 0, meta: n.meta || {},
      r: (GRAPH_R[n.type] || ITEM_R) + Math.min(9, (degree[n.id] || 0) * (n.type in GRAPH_R ? 1.1 : 0.3)),
    }));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const edges = data.edges.filter((e) => byId[e.source] && byId[e.target]);
    const N = nodes.length;
    const big = isLargeMap(N);   // large-map code paths (perf.js): worker physics, batched drawing, level of detail
    nodes.forEach((n) => { n.w = 1 + 0.45 * Math.sqrt(n.deg); });   // mass: a dump with a dozen leaves claims more room
    const sim = makeSim(nodes, edges, byId);
    const nbrIds = sim.nbrIds;
    // When each node "appears" (time-lapse; also handy for layouts): a dump when it was written, a
    // concept/person/item when the first dump that mentions it was written.
    const stamp = (n) => (n.type === "dump" ? Date.parse(n.created_at || "") : NaN);
    nodes.forEach((n) => {
      let t = stamp(n);
      if (Number.isNaN(t)) for (const id of nbrIds[n.id] || []) { const m = byId[id], v = m && stamp(m); if (v && (Number.isNaN(t) || v < t)) t = v; }
      n.born = Number.isNaN(t) ? 0 : t;
    });

    let scale = 1, panX = 0, panY = 0;
    let hoverId = null, selectedId = null;
    let needsDraw = true, userMoved = false, dead = false;
    let drv = null;                       // large maps: the worker / time-sliced physics driver (sim-large.js)
    let lastMotion = 0, lodOn = false;    // large maps: simplified drawing while the map moves (pan, zoom, drag, settling)
    const markMoving = () => { lastMotion = performance.now(); needsDraw = true; };
    // Window-level listeners are removed when the graph view unmounts / the map is rebuilt.
    const ac = new AbortController();
    const sig = { signal: ac.signal };
    const envObj = { W: 0, H: 0, spacing: 1 };
    const syncEnv = () => { envObj.W = W(); envObj.H = H(); envObj.spacing = prefs.get("spacing"); return envObj; };
    const warm = (a) => { if (!fixed) sim.alpha = Math.max(sim.alpha, a); };

    const inst = {
      nodes, edges, byId, sim, canvas, wrap, layout, colors: GC, W, H, syncEnv,
      get scale() { return scale; }, set scale(v) { scale = v; needsDraw = true; if (big) lastMotion = performance.now(); },
      get panX() { return panX; }, set panX(v) { panX = v; needsDraw = true; if (big) lastMotion = performance.now(); },
      get panY() { return panY; }, set panY(v) { panY = v; needsDraw = true; if (big) lastMotion = performance.now(); },
      get selectedId() { return selectedId; }, get hoverId() { return hoverId; },
      requestDraw: () => { needsDraw = true; },
      reheat: () => { if (!fixed) sim.alpha = 1; userMoved = false; needsDraw = true; },
      refit: () => { userMoved = false; fit(); persistSoon(); },
      neighborsOf, toWorld, select, setHover, focusOn, snapshot,
      dispose() { dead = true; clearTimeout(saveTimer); ac.abort(); drv?.dispose(); if (E === inst) E = null; },
    };
    E = inst;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = W() + "px";
      canvas.style.height = H() + "px";
      canvas.width = W() * dpr;
      canvas.height = H() * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      needsDraw = true;
    }
    resize();
    window.addEventListener("resize", resize, sig);

    // Zoom/pan so every node is in view — the first thing a big graph needs.
    function fit() {
      if (!nodes.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      nodes.forEach((n) => { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); });
      const pad = 50, bw = Math.max(x1 - x0, 60), bh = Math.max(y1 - y0, 60);
      scale = Math.min(1.6, Math.max(MIN_ZOOM, Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh)));
      panX = W() / 2 - scale * (x0 + x1) / 2;
      panY = H() / 2 - scale * (y0 + y1) / 2;
      needsDraw = true;
    }

    function neighborsOf(id, hops = 1) {
      if (big) {   // large maps: walk the adjacency lists instead of scanning every edge once per hop
        const seen = new Set([id]);
        let frontier = [id];
        for (let h = 0; h < hops && frontier.length; h++) {
          const next = [];
          for (const f of frontier) for (const m of nbrIds[f] || []) if (!seen.has(m)) { seen.add(m); next.push(m); }
          frontier = next;
        }
        return seen;
      }
      let s = new Set([id]);
      for (let h = 0; h < hops; h++) {
        const next = new Set(s);
        edges.forEach((e) => { if (s.has(e.source)) next.add(e.target); if (s.has(e.target)) next.add(e.source); });
        s = next;
      }
      return s;
    }

    function select(id) {
      selectedId = id;
      needsDraw = true;
      emit("select", { id, node: id ? byId[id] || null : null });
    }
    function setHover(id) {
      if (id === hoverId) return;
      const prev = hoverId;
      hoverId = id;
      needsDraw = true;
      emit("hover", { id, prev, node: id ? byId[id] || null : null });
    }

    // Starting positions come from the layout; then the remembered arrangement (positions, pan/zoom) and pins win.
    const layoutId = layout.id;
    const syncPlace = () => layout.place(api);
    let restored = null;   // the remembered arrangement, when this map is a rebuild of one already seen
    function place() {
      syncEnv();
      syncPlace();
      const snap = layout.locked ? null : loadView(layoutId);   // locked layouts compute every position from the data
      if (snap) {
        let hit = 0;
        nodes.forEach((n) => { const q = snap.pos.get(n.id); if (q) { n.x = q.x; n.y = q.y; hit++; } });
        if (hit >= Math.max(1, nodes.length * 0.5)) {
          restored = snap;
          nodes.forEach((n) => {   // anything new starts beside a node that was already there
            if (snap.pos.has(n.id)) return;
            const near = (nbrIds[n.id] || []).map((id) => snap.pos.get(id)).filter(Boolean)[0];
            if (near) { n.x = near.x + (hash01(n.id) - 0.5) * 70; n.y = near.y + (hash01(n.id + "y") - 0.5) * 70; }
          });
        }
      }
      const pins = layout.locked ? {} : loadPins();
      nodes.forEach((n) => { const q = pins[n.id]; if (q) { n.fx = n.x = q.x; n.fy = n.y = q.y; } });
    }
    // Cheap counters for tuning/testing (api.perf): where the time goes on a big map.
    const stats = { nodes: N, edges: edges.length, mountMs: 0, presettleSteps: 0, presettleMs: 0, firstDrawAt: 0, stepN: 0, stepMs: 0, stepMsMax: 0, drawN: 0, drawMs: 0, drawMsLast: 0, drawMsMax: 0 };
    inst.stats = stats;
    const stepSim = () => { const t0 = performance.now(); physicsStep(sim, forces, syncEnv()); const dt = performance.now() - t0; stats.stepN++; stats.stepMs += dt; if (dt > stats.stepMsMax) stats.stepMsMax = dt; };

    const mountT0 = performance.now(); stats.mountAt = mountT0;
    place();
    if (fixed) sim.alpha = 0;
    if (restored) {
      // Same map as last time: keep it exactly as it was, and only let physics run (briefly) if there are
      // new nodes that need to find their spot - re-heating a settled layout would shuffle everything.
      const fresh = nodes.some((n) => !restored.pos.has(n.id));
      if (!fixed) {
        sim.alpha = fresh ? 0.15 : 0.012;
        if (big && restored.alpha > sim.alpha) sim.alpha = restored.alpha;   // left while still settling: keep cooling from there
        if (fresh && !big) for (let i = 0; i < 90 && sim.alpha > 0.06; i++) stepSim();
      }
      if (restored.userMoved) { scale = restored.scale; panX = restored.panX; panY = restored.panY; userMoved = true; } else fit();
    } else {
      // Settle most of the way before the first frame so the map opens already laid out, not exploding.
      // (Large maps skip this: they open at once and settle in a worker, see startLargeSim.)
      if (!big) for (let i = 0; i < 420 && sim.alpha > 0.07; i++) { stepSim(); stats.presettleSteps++; }
      fit();
    }
    // Large maps: the physics runs off the main thread (a module worker, or small time slices if that fails). The
    // simulation hangs off sim.alpha, so plugins that reheat or read the temperature keep working unchanged.
    if (big && !fixed) {
      drv = createLargeSim({ nodes, edges, forces, getEnv: syncEnv, alpha: sim.alpha, decay: sim.decay });
      Object.defineProperty(sim, "alpha", { get: () => drv.alpha, set: (v) => drv.setAlpha(v), configurable: true, enumerable: true });
      stats.simMode = drv.mode;
    }
    stats.mountMs = performance.now() - mountT0;
    function snapshot() { sessionViews.set(layoutId, { pos: new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }])), scale, panX, panY, userMoved, alpha: big ? sim.alpha : undefined }); }
    // Persist the view (pan/zoom/positions) shortly after any interaction and when the window closes.
    let saveTimer = 0;
    const persist = () => { clearTimeout(saveTimer); if (canvas.isConnected) { snapshot(); storeView(layoutId, sessionViews.get(layoutId)); } };
    function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }
    window.addEventListener("pagehide", persist, sig);
    window.addEventListener("beforeunload", persist, sig);

    let ticks = 0, settledSaved = false;
    function tick() {
      if (dead) return;
      // View switched away → stop the loop and drop window listeners.
      if (!canvas.isConnected) { if (E === inst) { snapshot(); storeView(layoutId, sessionViews.get(layoutId)); E = null; } clearTimeout(saveTimer); ac.abort(); drv?.dispose(); return; }
      emit("tick", { alpha: sim.alpha });
      if (drv) {
        // Large map: positions arrive from the worker (or from a few time-sliced steps when it is unavailable).
        drv.setEnv(syncEnv());
        drv.syncPins();
        if (drv.mode === "inline") drv.run(INLINE_STEP_BUDGET_MS);
        if (drv.pull()) {
          if (!userMoved && (++ticks % 3 === 0 || drv.alpha <= 0.01)) fit();
          markMoving();
          settledSaved = false;
        } else if (drv.alpha <= 0.01 && !settledSaved) { settledSaved = true; persistSoon(); }
      } else if (sim.alpha > 0.01) {
        stepSim();
        if (!userMoved && ++ticks % 6 === 0) fit();   // keep everything framed until the user takes over
        needsDraw = true;
        settledSaved = false;
      } else if (!settledSaved) { settledSaved = true; persistSoon(); }   // the layout just settled: remember it for next launch
      if (lodOn && performance.now() - lastMotion > LOD_IDLE_MS) needsDraw = true;   // the map came to rest: redraw with full detail
      // Once the physics settle, redraw only on interaction — idle cost ~0.
      if (needsDraw) {
        const t0 = performance.now();
        draw(); needsDraw = false;
        const dt = performance.now() - t0;
        if (!stats.drawN) stats.firstDrawAt = t0;
        stats.drawN++; stats.drawMs += dt; stats.drawMsLast = dt; if (dt > stats.drawMsMax) stats.drawMsMax = dt;
      }
      requestAnimationFrame(tick);
    }

    const labelled = new Set([...nodes].sort((a, b) => b.deg - a.deg).slice(0, Math.max(6, Math.min(30, Math.ceil(N * 0.06)))).map((n) => n.id));
    // ── Large maps (perf.js): batched, culled, level-of-detail drawing ─────────────────────────────
    // Same picture as the plain loops below, but edges and plain nodes are collected into a few Path2D batches instead
    // of one canvas call each, anything off screen is skipped, and while the map moves labels (and half the edges of a
    // very dense map) are left out until it comes to rest. Small maps never touch any of this.
    const TAU = Math.PI * 2;
    const eA = big ? edges.map((e) => byId[e.source]) : null;
    const eB = big ? edges.map((e) => byId[e.target]) : null;
    const eBase = big ? new Int32Array(edges.length) : null;   // index into edgeBases: (colour, dashed, line width) of each edge
    const edgeBases = [];
    if (big) {
      const seen = new Map();
      edges.forEach((e, i) => {
        const similar = e.type === "similar";
        const color = similar ? GC.dump : e.type === "in" ? (GC.colors[byId[e.source].type] || GC.edge) : GC.edge;
        const lw = similar ? Math.round(Math.max(0.6, (e.score || 0.5) * 2) * 4) / 4 : 1;
        const key = color + "|" + similar + "|" + lw;
        let at = seen.get(key);
        if (at === undefined) { at = edgeBases.length; seen.set(key, at); edgeBases.push({ color, similar, lw }); }
        eBase[i] = at;
      });
    }
    const nColor = big ? nodes.map((n) => GC.colors[n.type] || "#999") : null;
    const nColorDim = big ? nColor.map((c) => c + "~") : null;
    const byDeg = big ? [...nodes].sort((a, b) => b.deg - a.deg) : null;   // label priority order, sorted once per mount
    const edgePaths = [], specNodes = [];

    /** World-space rectangle currently on screen, grown by `m` world units. */
    const viewRect = (m) => ({ x0: -panX / scale - m, y0: -panY / scale - m, x1: (W() - panX) / scale + m, y1: (H() - panY) / scale + m });

    function drawEdgesBig(f) {
      const { hl, hood, focus, alive, preds, thin, view: v } = f;
      const E_N = edges.length, stride = f.lod && E_N > LOD_EDGES ? Math.ceil(E_N / LOD_EDGES) : 1, lwScale = 1 / Math.max(1, scale);
      const custom = new Map();   // layout.edgeStyle edges: string-keyed batches
      let onPath = null;
      edgePaths.length = 0;
      for (let i = 0; i < E_N; i += stride) {
        const a = eA[i], b = eB[i];
        if ((a.x < v.x0 && b.x < v.x0) || (a.x > v.x1 && b.x > v.x1) || (a.y < v.y0 && b.y < v.y0) || (a.y > v.y1 && b.y > v.y1)) continue;
        if (preds && (!alive(a) || !alive(b))) continue;
        const e = edges[i];
        const path = hl && hl.edges.has(edgeKey(e.source, e.target));
        const dim = (hood && !(hood.has(e.source) && hood.has(e.target))) || (hl && !path);
        if (dim && focus && selectedId) continue;
        if (path) { (onPath ||= new Path2D()).moveTo(a.x, a.y); onPath.lineTo(b.x, b.y); continue; }
        const base = edgeBases[eBase[i]], batch = i % EDGE_BATCHES;
        if (layout.edgeStyle) {
          const es = layout.edgeStyle(e, a, b, api);
          if (es === false) continue;
          const color = (es && es.color) || base.color;
          const alpha = (base.similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25)) * (dim ? 1 : thin) * (es && es.alpha != null ? es.alpha : 1);
          const lw = (base.similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1) * (es && es.width != null ? es.width : 1);
          const key = color + "|" + alpha + "|" + lw + "|" + base.similar + "|" + batch;
          let g = custom.get(key);
          if (!g) custom.set(key, g = { path: new Path2D(), color, alpha, lw, dash: base.similar });
          g.path.moveTo(a.x, a.y); g.path.lineTo(b.x, b.y);
        } else {
          const key = ((eBase[i] * 2) + (dim ? 1 : 0)) * EDGE_BATCHES + batch;
          const p = edgePaths[key] || (edgePaths[key] = new Path2D());
          p.moveTo(a.x, a.y); p.lineTo(b.x, b.y);
        }
      }
      for (let key = 0; key < edgePaths.length; key++) {
        const p = edgePaths[key];
        if (!p) continue;
        const dim = Math.floor(key / EDGE_BATCHES) % 2 === 1, base = edgeBases[Math.floor(key / (EDGE_BATCHES * 2))];
        ctx.strokeStyle = base.color;
        ctx.globalAlpha = (base.similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25)) * (dim ? 1 : thin);
        ctx.lineWidth = base.lw * lwScale;
        ctx.setLineDash(base.similar ? [4, 3] : []);
        ctx.stroke(p);
      }
      for (const g of custom.values()) {
        ctx.strokeStyle = g.color; ctx.globalAlpha = g.alpha; ctx.lineWidth = g.lw * lwScale; ctx.setLineDash(g.dash ? [4, 3] : []);
        ctx.stroke(g.path);
      }
      if (onPath) { ctx.globalAlpha = 1; ctx.strokeStyle = GC.text; ctx.lineWidth = 2.5 / Math.max(1, scale); ctx.setLineDash([]); ctx.stroke(onPath); }
      edgePaths.length = 0;
    }

    function drawNodesBig(f, paintNode) {
      const { hl, hood, focusing, alive, preds, styled, view: v } = f;
      const batches = new Map(), tiny = 0.8 / scale;
      specNodes.length = 0;
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        if (n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1) continue;
        if (preds && !alive(n)) continue;
        const dim = (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id));
        if (dim && focusing) continue;
        const st = styled ? api.overlays.nodeStyle(n) : null;
        if (st || n.fx != null || n.id === hoverId || n.id === selectedId || (hl && hl.nodes.has(n.id))) { specNodes.push(n, st, dim); continue; }
        const key = dim ? nColorDim[i] : nColor[i];
        let p = batches.get(key);
        if (!p) batches.set(key, p = new Path2D());
        if (n.r * scale < 1.1) p.rect(n.x - tiny, n.y - tiny, tiny * 2, tiny * 2);
        else { p.moveTo(n.x + n.r, n.y); p.arc(n.x, n.y, n.r, 0, TAU); }
      }
      for (const [key, p] of batches) {
        const dim = key.charCodeAt(key.length - 1) === 126;   // "~" marks the dimmed batch
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillStyle = dim ? key.slice(0, -1) : key;
        ctx.fill(p);
      }
      for (let k = 0; k < specNodes.length; k += 3) paintNode(specNodes[k], specNodes[k + 1], specNodes[k + 2]);
      specNodes.length = 0;
    }

    function drawLabelsBig(f, px) {
      const { hl, hood, focusing, alive, preds, view: v } = f;
      const hoverTitles = prefs.get("hoverTitles");
      const placed = [];
      let tries = 0;
      const consider = (n, force) => {
        if (n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1) return;
        if (preds && !alive(n)) return;
        const dim = (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id));
        if (dim && focusing) return;
        const inHl = hl && hl.nodes.has(n.id);
        if (!inHl && !force) {
          if (f.lod) return;   // simplified while moving: only the hovered / selected / path labels
          if (!(hoverTitles ? n.id === hoverId : !dim && (hood || labelled.has(n.id) || n.r * scale > 9 || (scale > 1.3 && n.deg >= 2) || scale > 2.6))) return;
        }
        tries++;
        const text = n.label.slice(0, 30), w = ctx.measureText(text).width, x = n.x + n.r + 4 / scale, y = n.y + 4 / scale;
        const x0 = x, x1 = x + w, y0 = y - px, y1 = y + px * 0.3;
        if (!force) for (let q = 0; q < placed.length; q++) { const b = placed[q]; if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) return; }
        placed.push({ x0, x1, y0, y1 });
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.lineWidth = 3 / scale; ctx.strokeStyle = GC.bg;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = GC.text;
        ctx.fillText(text, x, y);
      };
      const hv = hoverId && byId[hoverId], sel = selectedId && selectedId !== hoverId ? byId[selectedId] : null;
      if (hv) consider(hv, true);
      if (sel) consider(sel, true);
      for (let i = 0; i < N && tries < 700; i++) { const n = byDeg[i]; if (n !== hv && n !== sel) consider(n, false); }
    }

    function draw() {
      ctx.clearRect(0, 0, W(), H());
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(scale, scale);
      emit("beforeDraw", { ctx });
      if (layout.drawUnder) { try { layout.drawUnder(ctx, api); } catch (e) { console.error("graph layout drawUnder failed:", e); } }
      const focus = prefs.get("focus");
      const hl = highlight;
      const preds = [...visibility.values()];
      const alive = preds.length ? (n) => preds.every((p) => p(n)) : () => true;
      const activeId = hoverId || selectedId;
      const hood = activeId ? neighborsOf(activeId, focus && selectedId ? 2 : 1) : null;
      const thin = Math.min(1, Math.max(0.35, 220 / (edges.length + 1)));   // many edges -> fainter lines, so a dense map stays readable
      const lod = big && performance.now() - lastMotion <= LOD_IDLE_MS;
      lodOn = lod;
      const frame = big ? { hl, hood, focus, alive, preds: preds.length ? preds : null, thin, lod, view: viewRect(40 / scale), focusing: false, styled: false } : null;
      let tPhase = performance.now();
      if (big) drawEdgesBig(frame); else edges.forEach((e) => {
        const a = byId[e.source], b = byId[e.target];
        if (!alive(a) || !alive(b)) return;
        const onPath = hl && hl.edges.has(edgeKey(e.source, e.target));
        const dim = (hood && !(hood.has(e.source) && hood.has(e.target))) || (hl && !onPath);
        if (dim && focus && selectedId) return;
        if (onPath) { ctx.globalAlpha = 1; ctx.strokeStyle = GC.text; ctx.lineWidth = 2.5 / Math.max(1, scale); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return; }
        const es = layout.edgeStyle ? layout.edgeStyle(e, a, b, api) : null;   // layout hook: false = skip, or { alpha, width, color } multipliers
        if (es === false) return;
        const similar = e.type === "similar";
        ctx.strokeStyle = (es && es.color) || (similar ? GC.dump : e.type === "in" ? (GC.colors[byId[e.source].type] || GC.edge) : GC.edge);
        ctx.globalAlpha = (similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25)) * (dim ? 1 : thin) * (es && es.alpha != null ? es.alpha : 1);
        ctx.lineWidth = (similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1) * (es && es.width != null ? es.width : 1) / Math.max(1, scale);
        ctx.setLineDash(similar ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const paint of HULL_PAINTERS) { try { paint(ctx, api); } catch (e) { console.error("graph hull painter failed:", e); } }
      ctx.globalAlpha = 1;
      api.overlays.under(ctx);
      ctx.globalAlpha = 1;
      const focusing = focus && selectedId;   // Focus mode: everything beyond two hops of the selection is hidden, not just dimmed
      const styled = api.overlays.hasStyles();
      if (big) { frame.focusing = !!focusing; frame.styled = styled; }
      const paintNode = (n, st, dim) => {
        ctx.globalAlpha = st && st.alpha != null ? (dim ? 0.2 : 1) * st.alpha : dim ? 0.2 : 1;
        const r = st && st.scale != null ? n.r * st.scale : n.r;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = (st && st.color) || GC.colors[n.type] || "#999";
        if (n.id === hoverId) { ctx.shadowColor = GC.colors[n.type] || GC.dump; ctx.shadowBlur = 14; }
        else if (st && st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = 10; }
        ctx.fill();
        ctx.shadowBlur = 0;  // glow on the hovered node only (plus overlay glows) — cheap for one arc
        if (n.id === selectedId || (hl && hl.nodes.has(n.id))) { ctx.lineWidth = 2; ctx.strokeStyle = GC.text; ctx.stroke(); }
        if (st && st.ring) {
          const ring = typeof st.ring === "string" ? { color: st.ring } : st.ring;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 2 / scale + 1 + (ring.gap || 0) / scale, 0, Math.PI * 2);
          ctx.lineWidth = (ring.width || 2) / scale; ctx.strokeStyle = ring.color;
          if (ring.dash) ctx.setLineDash(ring.dash.map((d) => d / scale));   // optional: dashed ring, dash = [on, off] in px
          ctx.stroke();
          if (ring.dash) ctx.setLineDash([]);
        }
        if (n.fx != null && !dim) {   // pinned: a dashed ring (double-click to release)
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 / scale + 1, 0, Math.PI * 2);
          ctx.setLineDash([2 / scale, 2 / scale]); ctx.lineWidth = 1 / scale; ctx.strokeStyle = GC.edge; ctx.stroke(); ctx.setLineDash([]);
        }
        if (st && st.badge) {
          // badge: a short string, or { text, color, bg } for a coloured pill
          const b = typeof st.badge === "object" ? st.badge : { text: String(st.badge) };
          const fs = 10 / scale, bx = n.x + r * 0.7, by = n.y - r * 0.7;
          ctx.font = `${b.bg ? "600 " : ""}${fs}px sans-serif`;
          if (b.bg) {
            const tw = ctx.measureText(b.text).width, pw = tw + 6 / scale, ph = fs + 3 / scale;
            ctx.fillStyle = b.bg; ctx.beginPath(); ctx.roundRect(bx - 1 / scale, by - ph + 2 / scale, pw, ph, ph / 2); ctx.fill();
            ctx.fillStyle = b.color || GC.text; ctx.fillText(b.text, bx + 2 / scale, by - 0.5 / scale);
          } else { ctx.fillStyle = b.color || GC.text; ctx.fillText(b.text, bx, by); }
        }
        ctx.globalAlpha = 1;
      };
      stats.edgeMs = performance.now() - tPhase; tPhase = performance.now();
      if (big) drawNodesBig(frame, paintNode);
      else nodes.forEach((n) => {
        if (!alive(n)) return;
        const dim = (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id));
        if (dim && focusing) return;
        paintNode(n, styled ? api.overlays.nodeStyle(n) : null, dim);
      });
      api.overlays.over(ctx);
      ctx.globalAlpha = 1;
      // Labels: the busiest hubs always, more as you zoom in, always for hover/selection neighbours.
      // Drawn in a second pass, most important first, and skipped if they would overlap one already placed.
      const hoverTitles = prefs.get("hoverTitles");
      const px = 12 / scale;   // constant on-screen size whatever the zoom
      ctx.font = `${px}px sans-serif`;
      ctx.lineJoin = "round";
      stats.nodeMs = performance.now() - tPhase;
      if (big) drawLabelsBig(frame, px);
      else {
      const wanted = nodes.filter((n) => {
        if (!alive(n)) return false;
        const dim = (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id));
        if (dim && focusing) return false;
        if (hl && hl.nodes.has(n.id)) return true;
        return hoverTitles ? n.id === hoverId : !dim && (hood || labelled.has(n.id) || n.r * scale > 9 || (scale > 1.3 && n.deg >= 2) || scale > 2.6);
      }).sort((a, b) => (b.id === hoverId) - (a.id === hoverId) || (b.id === selectedId) - (a.id === selectedId) || b.deg - a.deg);
      const placed = [];
      wanted.forEach((n) => {
        const text = n.label.slice(0, 30), w = ctx.measureText(text).width, x = n.x + n.r + 4 / scale, y = n.y + 4 / scale;
        const box = { x0: x, x1: x + w, y0: y - px, y1: y + px * 0.3 };
        const force = n.id === hoverId || n.id === selectedId;
        if (!force && placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) return;
        placed.push(box);
        ctx.globalAlpha = (hood && !hood.has(n.id)) || (hl && !hl.nodes.has(n.id)) ? 0.2 : 1;
        ctx.lineWidth = 3 / scale; ctx.strokeStyle = GC.bg;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = GC.text;
        ctx.fillText(text, x, y);
      });
      }
      ctx.globalAlpha = 1;
      emit("afterDraw", { ctx });
      ctx.restore();
    }

    function toWorld(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      return { x: (cx - rect.left - panX) / scale, y: (cy - rect.top - panY) / scale };
    }
    function nodeAt(x, y) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], dx = n.x - x, dy = n.y - y;
        if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
      }
      return null;
    }
    const layoutHit = (p) => { try { return layout.hitTest ? layout.hitTest(p.x, p.y, api) : null; } catch (e) { console.error("graph layout hitTest failed:", e); return null; } };

    let dragging = null, panning = false, lastPan = null, moved = false, downAt = null, wasPinned = false, dragOrigin = null;
    canvas.addEventListener("mousedown", (e) => {
      moved = false;
      downAt = { x: e.clientX, y: e.clientY };
      const p = toWorld(e.clientX, e.clientY);
      const n = layout.locked ? null : nodeAt(p.x, p.y);   // locked layouts: dragging from a node pans instead
      if (n) { dragging = n; wasPinned = n.fx != null; dragOrigin = { x: n.x, y: n.y }; n.fx = n.x; n.fy = n.y; warm(0.3); userMoved = true; emit("dragstart", { node: n, e }); }
      else { panning = true; userMoved = true; lastPan = { x: e.clientX, y: e.clientY }; }
    });
    window.addEventListener("mousemove", (e) => {
      moved = true;
      if (dragging) {
        const p = toWorld(e.clientX, e.clientY);
        dragging.fx = p.x; dragging.fy = p.y;
        if (fixed) { dragging.x = p.x; dragging.y = p.y; needsDraw = true; }   // no physics to move it for us
        if (big) { dragging.x = p.x; dragging.y = p.y; markMoving(); }
        warm(0.3);
        emit("drag", { node: dragging, e, point: p });
      } else if (panning) {
        panX += e.clientX - lastPan.x; panY += e.clientY - lastPan.y;
        lastPan = { x: e.clientX, y: e.clientY };
        needsDraw = true;
        if (big) markMoving();
      } else {
        const rect = canvas.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        const pw = inside ? toWorld(e.clientX, e.clientY) : null;
        const n = pw ? nodeAt(pw.x, pw.y) : null;
        setHover(n ? n.id : null);
        if (inside) canvas.style.cursor = n || (pw && layoutHit(pw)) ? "pointer" : "grab";
      }
    }, sig);
    window.addEventListener("mouseup", (e) => {
      if (dragging) {
        const dragged = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
        // A plugin (drag-to-merge) can set `restore` to say "this drop wasn't a move": the node goes back where it was.
        const end = emit("dragend", { node: dragging, e, dragged: !!dragged, restore: false });
        const pins = loadPins();
        if (end.restore && dragOrigin) {
          dragging.x = dragOrigin.x; dragging.y = dragOrigin.y;
          dragging.fx = wasPinned ? dragOrigin.x : null; dragging.fy = wasPinned ? dragOrigin.y : null;
          warm(0.3); needsDraw = true;
        }
        else if (dragged) { pins[dragging.id] = { x: dragging.fx, y: dragging.fy }; savePins(pins); }   // dropped = pinned
        else if (!wasPinned) { dragging.fx = null; dragging.fy = null; }                           // a plain click doesn't pin
      }
      dragging = null; panning = false;
      persistSoon();
    }, sig);
    canvas.addEventListener("dblclick", (e) => {
      const p = toWorld(e.clientX, e.clientY);
      const n = nodeAt(p.x, p.y);
      if (emit("dblclick", { node: n, e, point: p, handled: false }).handled) return;
      if (n) { n.fx = null; n.fy = null; warm(0.3); const pins = loadPins(); delete pins[n.id]; savePins(pins); needsDraw = true; }
    });
    canvas.addEventListener("click", (e) => {
      const p = toWorld(e.clientX, e.clientY);
      const n = nodeAt(p.x, p.y);
      // Plugins get first refusal: set payload.handled = true to stop the default behaviour (Path mode does).
      if (emit("click", { node: n, e, point: p, handled: false }).handled) return;
      if (!n) {
        const hit = layoutHit(p);
        if (hit && layout.onClick) { try { layout.onClick(hit, api); } catch (err) { console.error("graph layout onClick failed:", err); } needsDraw = true; return; }
        select(null); needsDraw = true; return;
      }
      // first click on a dump/item opens it; in Focus mode, on a second click, or when an active overlay has something to say
      // about this node (Lonely dumps, Open loops ...) it selects instead, so the info box (with its Open link) is reachable
      if (!(prefs.get("focus") || selectedId === n.id || api.overlays.infoHtml(n))) {
        if (n.type === "dump") { go("history/" + n.id); return; }
        if (n.dump) { go("history/" + n.dump); return; }
      }
      select(n.id);
    });
    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      emit("keydown", { e, node: byId[hoverId || selectedId] || null });
    }, sig);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      userMoved = true;
      const next = Math.min(4, Math.max(MIN_ZOOM, scale * factor));
      panX = mx - (mx - panX) * (next / scale);
      panY = my - (my - panY) * (next / scale);
      scale = next;
      needsDraw = true;
      if (big) markMoving();
      persistSoon();
    }, { passive: false });

    // "Find a node" and plugins: select it, zoom in on it and show its neighbourhood.
    function focusOn(id) {
      const n = byId[id];
      if (!n) return false;
      userMoved = true;
      scale = Math.max(scale, 1.4);
      panX = W() / 2 - scale * n.x; panY = H() / 2 - scale * n.y;
      select(id);
      return true;
    }

    highlight = null;
    emit("nodesChanged", { nodes, edges });
    tick();
    return api;
  }
  return api;
}
