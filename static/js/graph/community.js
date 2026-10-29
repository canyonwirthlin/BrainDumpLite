// Community detection for the Brain map: which dumps, concepts and people belong together.
//
//   import { communities } from "./community.js";
//   const { communityOf, list } = communities(api.nodes, api.edges);
//   communityOf.get(node.id)  -> "c0"            (c0 = the biggest community, c1 the next ...)
//   list[0] -> { id: "c0", nodeIds: [...], topLabel: "Sleep", size: 37 }
//
// Louvain (modularity local-moving + aggregation), fully deterministic: nodes are visited in id order and ties never
// depend on Math.random or on object key order, so the same data always gives the same communities and the same ids
// (colours and island positions therefore don't jump between reloads). Linear-ish in the number of links: a
// 2500-node map takes a few milliseconds. Item nodes (tasks, ideas ... anything with `dump`) take no part in the
// detection; they simply join the community of the dump they belong to.

const weightOf = (e) => (e.weight != null ? +e.weight : e.type === "similar" ? Math.max(0.1, +e.score || 0.5) : 1);

/** Louvain over an undirected weighted graph: n nodes, adj[i] = [[j, w], ...]. Returns the community index (0..k-1) of every node. */
function louvain(n, adj0, resolution) {
  let adj = adj0, size = n;
  let self = new Array(n).fill(0);
  let owner = Array.from({ length: n }, (_, i) => i);   // original node -> node of the current (aggregated) level
  for (let level = 0; level < 8; level++) {
    const k = new Array(size).fill(0);
    let m2 = 0;
    for (let i = 0; i < size; i++) { let s = 2 * self[i]; for (const [, w] of adj[i]) s += w; k[i] = s; m2 += s; }
    if (m2 <= 0) break;
    const comm = Array.from({ length: size }, (_, i) => i);
    const tot = k.slice();
    let movedAny = false;
    for (let pass = 0; pass < 25; pass++) {
      let moved = 0;
      for (let i = 0; i < size; i++) {
        const ci = comm[i];
        const toComm = new Map();
        for (const [j, w] of adj[i]) { const c = comm[j]; toComm.set(c, (toComm.get(c) || 0) + w); }
        tot[ci] -= k[i];
        let best = ci, bestGain = (toComm.get(ci) || 0) - resolution * tot[ci] * k[i] / m2;
        for (const [c, w] of toComm) {   // Map order follows the (sorted) adjacency list, so ties resolve the same way every run
          if (c === ci) continue;
          const gain = w - resolution * tot[c] * k[i] / m2;
          if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
        }
        tot[best] += k[i];
        if (best !== ci) { comm[i] = best; moved++; movedAny = true; }
      }
      if (!moved) break;
    }
    if (!movedAny) break;
    // renumber communities in order of first appearance (deterministic), then collapse them into the next level
    const rename = new Map();
    comm.forEach((c) => { if (!rename.has(c)) rename.set(c, rename.size); });
    const next = rename.size;
    owner = owner.map((o) => rename.get(comm[o]));
    const nAdj = Array.from({ length: next }, () => new Map());
    const nSelf = new Array(next).fill(0);
    for (let i = 0; i < size; i++) {
      const ci = rename.get(comm[i]);
      nSelf[ci] += self[i];
      for (const [j, w] of adj[i]) {
        const cj = rename.get(comm[j]);
        if (ci === cj) nSelf[ci] += w / 2;           // each internal link is seen from both ends
        else nAdj[ci].set(cj, (nAdj[ci].get(cj) || 0) + w);
      }
    }
    adj = nAdj.map((m) => [...m.entries()].sort((a, b) => a[0] - b[0]));
    self = nSelf;
    if (next === size) break;
    size = next;
  }
  return owner;
}

/**
 * Detect communities. `nodes` need { id, type, label, dump? }, `edges` need { source, target } (optional `weight`, or
 * `score` for "similar" links). Options: { resolution = 1 } (higher = more, smaller communities).
 * Returns { communityOf: Map(nodeId -> "c<rank>"), list: [{ id, nodeIds, topLabel, size }] } with the list sorted
 * biggest first (ties by smallest member id), so "c0" is always the largest community.
 */
export function communities(nodes, edges, opts = {}) {
  const resolution = opts.resolution || 1;
  const core = nodes.filter((n) => !n.dump).map((n) => n.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map(core.map((id, i) => [id, i]));
  const n = core.length;
  const weights = Array.from({ length: n }, () => new Map());
  const degree = new Map();
  for (const e of edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a == null || b == null || a === b) continue;
    const w = weightOf(e);
    weights[a].set(b, (weights[a].get(b) || 0) + w);
    weights[b].set(a, (weights[b].get(a) || 0) + w);
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const adj = weights.map((m) => [...m.entries()].sort((x, y) => x[0] - y[0]));
  const raw = n ? louvain(n, adj, resolution) : [];

  // group (items follow their dump), then rank: biggest first
  const groups = new Map();
  const put = (cid, id) => { (groups.get(cid) || groups.set(cid, []).get(cid)).push(id); };
  core.forEach((id, i) => put(raw[i], id));
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const homeless = [];
  for (const nd of nodes) {
    if (!nd.dump) continue;
    const di = index.get(nd.dump);
    if (di != null) put(raw[di], nd.id); else homeless.push(nd.id);
  }
  const ranked = [...groups.values()].map((ids) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  homeless.sort().forEach((id) => ranked.push([id]));   // an item whose dump is not on the map stands alone

  const communityOf = new Map();
  const list = ranked.map((ids, i) => {
    const id = "c" + i;
    ids.forEach((nid) => communityOf.set(nid, id));
    return { id, nodeIds: ids, topLabel: topLabelOf(ids, byId, degree), size: ids.length };
  });
  return { communityOf, list };
}

/** The most connected concept or person of a community (concepts win ties), else its busiest dump's title. */
function topLabelOf(ids, byId, degree) {
  let best = null, bestScore = -1;
  for (const id of ids) {
    const nd = byId.get(id);
    if (!nd || nd.dump) continue;
    const score = (nd.type === "concept" ? 2e6 : nd.type === "person" ? 1e6 : 0) + (degree.get(id) || 0);   // concepts name a group before people do
    if (score > bestScore || (score === bestScore && best && nd.label < best.label)) { best = nd; bestScore = score; }
  }
  return best ? best.label : "";
}
