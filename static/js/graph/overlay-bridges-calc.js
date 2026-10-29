// Pure maths for the "Connectors" overlay (no DOM, no imports, so it can be run and tested under node).
//
// analyse(nodes, edges) -> { score: Map(id -> 0..1), top: [ids best first], comm: Map(id -> community #),
//                            connects(id) -> [{ comm, name, share }], N, pivots }
//
//  * Bridging = betweenness centrality (Brandes). Above ~800 nodes it is estimated from a fixed set of pivot
//    nodes, so a 2500-node map costs about 100 breadth-first searches, not 2500.
//  * "Areas" = communities found by weighted label propagation (hubs pull less than specific nodes), named after
//    their most characteristic concept.
//  * A concept/person only counts as a connector when the dumps around it really belong to different areas
//    (diversity of its neighbours' communities), so a plain hub inside one topic is not a connector.

const KINDS = new Set(["dump", "concept", "person"]);
const EXACT_BELOW = 800;
const PIVOTS = 110;

function lcg(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export function analyse(nodes0, edges0) {
  const nodes = nodes0.filter((n) => KINDS.has(n.type));
  const N = nodes.length;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const adjL = Array.from({ length: N }, () => []);
  for (const e of edges0) {
    const a = idx.get(e.source), b = idx.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    adjL[a].push(b); adjL[b].push(a);
  }
  const deg = adjL.map((l) => l.length);
  // CSR adjacency for the BFS hot loop
  const off = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Int32Array(off[N]);
  for (let i = 0; i < N; i++) { let p = off[i]; for (const j of adjL[i]) adj[p++] = j; }

  // ── betweenness (Brandes), exact for small maps, pivot-sampled for big ones ──
  const btw = new Float64Array(N);
  const pivots = N <= EXACT_BELOW ? N : Math.min(N, PIVOTS);
  const rnd = lcg(N * 2654435761);
  const sources = [];
  if (pivots === N) for (let i = 0; i < N; i++) sources.push(i);
  else { const seen = new Set(); while (sources.length < pivots) { const i = Math.floor(rnd() * N); if (!seen.has(i)) { seen.add(i); sources.push(i); } } }
  const dist = new Int32Array(N), sigma = new Float64Array(N), delta = new Float64Array(N), order = new Int32Array(N);
  for (const s of sources) {
    dist.fill(-1); sigma.fill(0); delta.fill(0);
    let head = 0, tail = 0;
    dist[s] = 0; sigma[s] = 1; order[tail++] = s;
    while (head < tail) {
      const v = order[head++];
      for (let p = off[v]; p < off[v + 1]; p++) {
        const w = adj[p];
        if (dist[w] < 0) { dist[w] = dist[v] + 1; order[tail++] = w; }
        if (dist[w] === dist[v] + 1) sigma[w] += sigma[v];
      }
    }
    for (let k = tail - 1; k > 0; k--) {
      const w = order[k];
      const c = (1 + delta[w]) / sigma[w];
      for (let p = off[w]; p < off[w + 1]; p++) {
        const v = adj[p];
        if (dist[v] === dist[w] - 1) delta[v] += sigma[v] * c;
      }
      btw[w] += delta[w];
    }
  }
  const scale = N / Math.max(1, pivots) / 2;   // undirected: each pair counted from both ends

  // ── communities: weighted label propagation on the concept/person graph, deterministic ──
  // Two names are tied by how many dumps mention both; hubs pull less than specific names (cosine-normalised).
  // A dump then belongs to the area most of its names belong to.
  const dumpIdx = nodes.map((n) => n.type === "dump");
  const pair = new Map(), cnt = new Float64Array(N);
  for (let d = 0; d < N; d++) {
    if (!dumpIdx[d]) continue;
    const names = [];
    for (let p = off[d]; p < off[d + 1]; p++) if (!dumpIdx[adj[p]]) names.push(adj[p]);
    names.length = Math.min(names.length, 12);
    for (const a of names) cnt[a]++;
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = Math.min(names[i], names[j]), b = Math.max(names[i], names[j]), k = a * N + b;
      pair.set(k, (pair.get(k) || 0) + 1);
    }
  }
  const nb = Array.from({ length: N }, () => []);   // [neighbour, weight]
  for (const [k, w] of pair) {
    const a = Math.floor(k / N), b = k % N, x = w / Math.sqrt(cnt[a] * cnt[b]);
    nb[a].push([b, x]); nb[b].push([a, x]);
  }
  const label = new Int32Array(N).fill(-1);
  const names = [];
  for (let i = 0; i < N; i++) if (!dumpIdx[i] && nb[i].length) { label[i] = i; names.push(i); }
  const r2 = lcg(7 + N);
  for (let it = 0; it < 15; it++) {
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    let changed = 0;
    for (const v of names) {
      const tally = new Map();
      for (const [u, w] of nb[v]) tally.set(label[u], (tally.get(label[u]) || 0) + w);
      let best = label[v], bw = -1;
      for (const [l, w] of tally) if (w > bw + 1e-12 || (Math.abs(w - bw) <= 1e-12 && l < best)) { best = l; bw = w; }
      if (best !== label[v]) { label[v] = best; changed++; }
    }
    if (!changed) break;
  }
  // dumps vote by their names' labels
  for (let d = 0; d < N; d++) {
    if (!dumpIdx[d]) continue;
    const tally = new Map();
    for (let p = off[d]; p < off[d + 1]; p++) { const u = adj[p]; if (!dumpIdx[u] && label[u] >= 0) tally.set(label[u], (tally.get(label[u]) || 0) + 1 / Math.sqrt(cnt[u])); }
    let best = -1, bw = 0;
    for (const [l, w] of tally) if (w > bw + 1e-12 || (Math.abs(w - bw) <= 1e-12 && l < best)) { best = l; bw = w; }
    label[d] = best;
  }
  // renumber, biggest first (by dumps); tiny leftovers (< 3 dumps) fold into "other" (-1)
  const sizes = new Map();
  for (let i = 0; i < N; i++) if (dumpIdx[i] && label[i] >= 0) sizes.set(label[i], (sizes.get(label[i]) || 0) + 1);
  const ranked = [...sizes.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const num = new Map(ranked.map((l, i) => [l, i]));
  const comm = new Int32Array(N);
  for (let i = 0; i < N; i++) comm[i] = label[i] >= 0 && num.has(label[i]) ? num.get(label[i]) : -1;

  // ── how many dumps of each community mention each concept/person (for names + "connects") ──
  const inComm = new Map();      // node i -> Map(comm -> count of neighbour dumps)
  const totalMent = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (dumpIdx[i]) continue;
    const m = new Map();
    for (let p = off[i]; p < off[i + 1]; p++) {
      const u = adj[p];
      if (!dumpIdx[u] || comm[u] < 0) continue;
      m.set(comm[u], (m.get(comm[u]) || 0) + 1);
      totalMent[i]++;
    }
    inComm.set(i, m);
  }
  // diversity (Gini-Simpson) of the areas around a concept/person
  const diversity = new Float64Array(N);
  for (const [i, m] of inComm) {
    let tot = 0; for (const c of m.values()) tot += c;
    if (tot < 2) continue;
    let s = 0; for (const c of m.values()) s += (c / tot) ** 2;
    diversity[i] = 1 - s;
  }

  // ── bridge score for concepts and people ──
  const cand = [];
  let maxRaw = 0;
  for (let i = 0; i < N; i++) {
    if (dumpIdx[i]) continue;
    const raw = diversity[i] >= 0.25 ? btw[i] * scale * diversity[i] : 0;
    if (raw > 0) { cand.push([i, raw]); if (raw > maxRaw) maxRaw = raw; }
  }
  cand.sort((a, b) => b[1] - a[1]);
  const pool = nodes.reduce((c, n, i) => c + (dumpIdx[i] ? 0 : 1), 0);
  const keep = Math.min(cand.length, Math.max(1, Math.round(pool * 0.1)), 60);
  const top = cand.slice(0, keep);
  const score = new Map(top.map(([i, raw]) => [nodes[i].id, raw / maxRaw]));

  // area names: the concept whose mentions are most concentrated in the community
  const nameCache = new Map();
  function areaName(c, avoid) {
    const key = c + "|" + (avoid ?? "");
    if (nameCache.has(key)) return nameCache.get(key);
    let best = null, bs = 0;
    for (const [i, m] of inComm) {
      if (nodes[i].type !== "concept" || i === avoid) continue;
      const here = m.get(c) || 0;
      if (here < 2) continue;
      const s = (here * here) / totalMent[i] * (1 + here / 10);
      if (s > bs) { bs = s; best = nodes[i].label; }
    }
    const name = best || `Area ${c + 1}`;
    nameCache.set(key, name);
    return name;
  }
  function connects(id) {
    const i = idx.get(id);
    const m = i === undefined ? null : inComm.get(i);
    if (!m) return [];
    let tot = 0; for (const c of m.values()) tot += c;
    return [...m.entries()].filter(([, c]) => c / tot >= 0.15).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, n]) => ({ comm: c, name: areaName(c, i), share: n / tot, dumps: n }));
  }
  return { score, top: top.map(([i]) => nodes[i].id), comm: new Map(nodes.map((n, i) => [n.id, comm[i]])), connects, N, pivots, communities: ranked.length };
}
