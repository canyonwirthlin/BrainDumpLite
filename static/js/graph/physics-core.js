// The force simulation of physics.js re-implemented on typed arrays, for LARGE maps (see perf.js). It is a plain
// module with no DOM access, so the same code runs inside physics-worker.js and, as a fallback, on the main thread.
//
// Same forces as physics.step (1/d repulsion through a spatial grid, collision, springs, centre pull / anchors,
// damping, pins) - only the data layout differs: struct-of-arrays, a counting-sort grid instead of a Map of arrays,
// per-edge constants precomputed. Small maps keep using physics.step so their layouts stay bit-for-bit identical.

const PIN_NONE = 0;

/** Flatten the engine's node/edge objects into transferable typed arrays.
 *  `forces` is the layout's merged forces; a function-valued `anchor` is evaluated here, once per node (functions
 *  cannot be posted to a worker). `env` is { W, H, spacing }. */
export function packSim(nodes, edges, forces, env, alpha, decay) {
  const n = nodes.length;
  const idx = new Map();
  for (let i = 0; i < n; i++) idx.set(nodes[i].id, i);
  const out = {
    n, alpha, decay, env: { W: env.W, H: env.H, spacing: env.spacing },
    forces: {
      repulsion: forces.repulsion, reach: forces.reach, linkPull: forces.linkPull, linkLength: forces.linkLength,
      centerPull: forces.centerPull, collide: forces.collide, collidePad: forces.collidePad,
    },
    x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
    r: new Float64Array(n), w: new Float64Array(n), deg: new Float64Array(n),
    pinned: new Uint8Array(n), fx: new Float64Array(n), fy: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), anchor: new Float64Array(n),
    ea: null, eb: null, ekind: null,
  };
  const anchor = forces.anchor;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    out.x[i] = Number.isFinite(a.x) ? a.x : 0; out.y[i] = Number.isFinite(a.y) ? a.y : 0; out.r[i] = a.r; out.w[i] = a.w; out.deg[i] = a.deg;
    if (a.fx != null) { out.pinned[i] = 1; out.fx[i] = a.fx; out.fy[i] = a.fy; }
    if (a.tx != null) { out.tx[i] = a.tx; out.ty[i] = a.ty; if (anchor) out.anchor[i] = typeof anchor === "function" ? +anchor(a) || 0 : +anchor || 0; }
  }
  let m = 0;
  const ea = new Int32Array(edges.length), eb = new Int32Array(edges.length), ek = new Uint8Array(edges.length);
  for (const e of edges) {
    const s = idx.get(e.source), t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    ea[m] = s; eb[m] = t; ek[m] = e.type === "similar" ? 1 : e.type === "in" ? 2 : 0; m++;
  }
  out.ea = ea.slice(0, m); out.eb = eb.slice(0, m); out.ekind = ek.slice(0, m);
  return out;
}

/** Build the runnable simulation state from a packSim() result (own copies of every array, so it is safe to reuse
 *  the same init object for a fallback). */
export function createCore(init) {
  const n = init.n, m = init.ea.length;
  const s = {
    n, alpha: init.alpha, decay: init.decay, env: { ...init.env }, f: { ...init.forces },
    x: Float64Array.from(init.x), y: Float64Array.from(init.y), vx: Float64Array.from(init.vx), vy: Float64Array.from(init.vy),
    r: Float64Array.from(init.r), sw: new Float64Array(n),
    pinned: Uint8Array.from(init.pinned), fx: Float64Array.from(init.fx), fy: Float64Array.from(init.fy),
    tx: Float64Array.from(init.tx), ty: Float64Array.from(init.ty), anchor: Float64Array.from(init.anchor),
    ea: init.ea, eb: init.eb, m,
    etarget: new Float64Array(m), estr: new Float64Array(m),
    gx: new Int32Array(n), gy: new Int32Array(n), items: new Int32Array(n), start: new Int32Array(1024),
    sx: new Float64Array(n), sy: new Float64Array(n), sr: new Float64Array(n), ss: new Float64Array(n), fax: new Float64Array(n), fay: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) s.sw[i] = Math.sqrt(init.w[i]);
  for (let e = 0; e < m; e++) {
    const da = init.deg[s.ea[e]], db = init.deg[s.eb[e]], k = init.ekind[e];
    // busy hubs get longer spokes so their neighbours fit around them; springs are weaker on hubs
    s.etarget[e] = (k === 1 ? 130 : k === 2 ? 34 : 80) * (1 + 0.1 * Math.sqrt(Math.max(da, db))) * s.f.linkLength;
    s.estr[e] = (1 / Math.sqrt(Math.max(1, Math.min(da, db)))) * 0.06 * s.f.linkPull;
  }
  return s;
}

/** One physics step (mutates the state, cools alpha). */
export function coreStep(s) {
  const { n, x, y, vx, vy, r, sw, f, env, gx, gy, items } = s;
  const k = s.alpha, spacing = env.spacing;
  const reach = f.reach * spacing, reach2 = reach * reach;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    if (xi < minX) minX = xi; if (xi > maxX) maxX = xi;
    if (yi < minY) minY = yi; if (yi > maxY) maxY = yi;
  }
  // Grid cells are half the reach (a 5x5 block covers it), and each pair of cells is visited once through a "forward"
  // stencil; the nodes of a cell sit next to each other in the sorted copies below. Both cut the work per step ~3x.
  let cell = reach / 2, inv = 1 / cell, gw = Math.floor((maxX - minX) * inv) + 1, gh = Math.floor((maxY - minY) * inv) + 1;
  while (gw * gh > 1048576) { cell *= 2; inv = 1 / cell; gw = Math.floor((maxX - minX) * inv) + 1; gh = Math.floor((maxY - minY) * inv) + 1; }
  const cells = gw * gh;
  if (s.start.length < cells + 1) s.start = new Int32Array(Math.max(cells + 1, s.start.length * 2));
  const start = s.start;
  start.fill(0, 0, cells + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((x[i] - minX) * inv), cy = Math.floor((y[i] - minY) * inv);
    gx[i] = cx; gy[i] = cy;
    start[cy * gw + cx + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  // fill (using a moving cursor stored in a scratch copy so `start` stays the prefix table)
  const cursor = s.cursor && s.cursor.length >= cells ? s.cursor : (s.cursor = new Int32Array(Math.max(cells, 1024)));
  for (let c = 0; c < cells; c++) cursor[c] = start[c];
  for (let i = 0; i < n; i++) items[cursor[gy[i] * gw + gx[i]]++] = i;

  const N = n;
  const charge = 1500 * spacing * spacing * (N > 250 ? 1 + Math.log10(N / 250) : 1) * f.repulsion;
  const chargeK = charge * k * 0.05, rep = f.repulsion ? 1 : 0, col = f.collide, pad = f.collidePad;
  const { sx, sy, sr, ss, fax, fay } = s;
  for (let p = 0; p < n; p++) {
    const j = items[p];
    sx[p] = x[j]; sy[p] = y[j]; sr[p] = r[j]; ss[p] = sw[j]; fax[p] = 0; fay[p] = 0;
  }
  const R = Math.max(1, Math.ceil(reach / cell - 1e-9));   // cells to look across in each direction (2 unless the grid was coarsened)
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const c = cy * gw + cx, a0 = start[c], a1 = start[c + 1];
      if (a0 === a1) continue;
      // oy = 0: this cell with itself (p < q) and the cells to its right; oy > 0: the whole row of offsets, forward only
      for (let oy = 0; oy <= R; oy++) {
        const ny = cy + oy;
        if (ny >= gh) break;
        for (let ox = oy === 0 ? 0 : -R; ox <= R; ox++) {
          const nx = cx + ox;
          if (nx < 0 || nx >= gw) continue;
          const c2 = ny * gw + nx, b0 = start[c2], b1 = start[c2 + 1], same = c2 === c;
          if (b0 === b1) continue;
          for (let p = a0; p < a1; p++) {
            const xi = sx[p], yi = sy[p], ri = sr[p], si = ss[p];
            let ax = 0, ay = 0;
            for (let q = same ? p + 1 : b0; q < b1; q++) {
              let dx = xi - sx[q], dy = yi - sy[q];
              let d2 = dx * dx + dy * dy;
              if (d2 > reach2) continue;
              if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
              const d = Math.sqrt(d2);
              let fo = rep ? (chargeK / d) * si * ss[q] : 0;
              const gap = ri + sr[q] + pad;
              if (d < gap) fo += (gap - d) * col;       // collision: overlapping nodes shove apart
              if (fo === 0) continue;
              const m = fo / d, fx = dx * m, fy = dy * m;
              ax += fx; ay += fy; fax[q] -= fx; fay[q] -= fy;
            }
            fax[p] += ax; fay[p] += ay;
          }
        }
      }
    }
  }
  for (let p = 0; p < n; p++) { const j = items[p]; vx[j] += fax[p]; vy[j] += fay[p]; }
  const { ea, eb, etarget, estr, m } = s;
  for (let e = 0; e < m; e++) {
    const a = ea[e], b = eb[e];
    const dx = x[b] - x[a], dy = y[b] - y[a];
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const fo = ((d - etarget[e] * spacing) * estr[e] * k) / d;
    const fx = dx * fo, fy = dy * fo;
    vx[a] += fx; vy[a] += fy; vx[b] -= fx; vy[b] -= fy;
  }
  const gcx = env.W / 2, gcy = env.H / 2, cpk = f.centerPull * k, { anchor, tx, ty } = s;
  for (let i = 0; i < n; i++) {
    const g = anchor[i];
    if (g) { vx[i] += (tx[i] - x[i]) * g; vy[i] += (ty[i] - y[i]) * g; }
    else { vx[i] += (gcx - x[i]) * cpk; vy[i] += (gcy - y[i]) * cpk; }
  }
  const { pinned, fx: pfx, fy: pfy } = s;
  for (let i = 0; i < n; i++) {
    if (pinned[i] !== PIN_NONE) { x[i] = pfx[i]; y[i] = pfy[i]; vx[i] = 0; vy[i] = 0; continue; }
    let ux = vx[i] * 0.72, uy = vy[i] * 0.72;
    vx[i] = ux; vy[i] = uy;
    if (ux > 40) ux = 40; else if (ux < -40) ux = -40;
    if (uy > 40) uy = 40; else if (uy < -40) uy = -40;
    x[i] += ux; y[i] += uy;
  }
  s.alpha *= s.decay;
}

/** Step until the time budget is spent or the layout has settled (alpha <= 0.01). Always runs at least one step
 *  when not settled. Returns the number of steps taken. */
export function coreRun(s, budgetMs, now = () => performance.now()) {
  const t0 = now();
  let steps = 0;
  while (s.alpha > 0.01) {
    coreStep(s); steps++;
    if (now() - t0 >= budgetMs) break;
  }
  return steps;
}

/** Apply a pin change: pinned = hold the node at (x, y); not pinned = release it from where the caller says it is. */
export function corePin(s, i, pinned, x, y) {
  s.pinned[i] = pinned ? 1 : 0;
  if (pinned) { s.fx[i] = x; s.fy[i] = y; }
  s.x[i] = x; s.y[i] = y; s.vx[i] = 0; s.vy[i] = 0;
}

/** Interleaved Float32 [x0, y0, x1, y1 ...] snapshot of the positions. */
export function corePositions(s) {
  const out = new Float32Array(s.n * 2);
  for (let i = 0, j = 0; i < s.n; i++) { out[j++] = s.x[i]; out[j++] = s.y[i]; }
  return out;
}
