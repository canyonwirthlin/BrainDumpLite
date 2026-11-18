// How big a node is and which nodes get a name written beside them, as plain functions (no DOM) so engine.js uses them
// and tests/test_graph_sizing.py can run them under Node.
//
// "Mentions" = how many dumps a concept or person turns up in. The more mentions, the bigger the dot, and the K most
// mentioned ones always carry their name (the View tab's "Size by mentions" and "Names shown" tools).
//
//   mentionCounts(nodes, edges) -> Map(id -> n)   hubs: distinct dumps that mention them; dumps: how many topics/people
//                                                 they mention; anything else: its number of links
//   radiusFor(n, mentions, max, on) -> px         the node's radius in world units
//   rankedForLabels(nodes, counts) -> [id...]     the nodes that deserve a name, most mentioned first

export const GRAPH_R = { dump: 7, concept: 5, person: 5 };
export const ITEM_R = 3.5;
export const SIZING_TAG = "sz2";   // bump when radii change, so a saved arrangement made with other sizes is laid out again

const isHubType = (t) => t === "concept" || t === "person";

export function mentionCounts(nodes, edges) {
  const type = new Map(nodes.map((n) => [n.id, n.type]));
  const seen = new Set(), out = new Map();
  const bump = (id) => out.set(id, (out.get(id) || 0) + 1);
  const links = new Map();   // id -> number of links of any kind (fallback)
  for (const e of edges) {
    links.set(e.source, (links.get(e.source) || 0) + 1);
    links.set(e.target, (links.get(e.target) || 0) + 1);
    const a = type.get(e.source), b = type.get(e.target);
    if (!a || !b) continue;
    const dumpEnd = a === "dump" ? e.source : b === "dump" ? e.target : null;
    const hubEnd = isHubType(a) ? e.source : isHubType(b) ? e.target : null;
    if (!dumpEnd || !hubEnd) continue;
    const k = dumpEnd + "\u0001" + hubEnd;
    if (seen.has(k)) continue;
    seen.add(k);
    bump(hubEnd); bump(dumpEnd);
  }
  const counts = new Map();
  for (const n of nodes) {
    const given = n.meta && Number.isFinite(n.meta.mentions) ? n.meta.mentions : null;   // a layout that rebuilt the data (concept map) says it itself
    counts.set(n.id, given != null ? given : out.get(n.id) || links.get(n.id) || 0);
  }
  return counts;
}

/** Radius for a node. `max` is the largest hub count on the map. Off = the classic look (a small bump per link). */
export function radiusFor(n, mentions, max, on) {
  const hub = isHubType(n.type);
  if (!on) return (GRAPH_R[n.type] || ITEM_R) + Math.min(9, mentions * (n.type in GRAPH_R ? 1.1 : 0.3));
  if (n.dump) return ITEM_R;                                   // tasks, ideas ... hang off their dump and stay small
  const t = max > 1 ? Math.min(1, Math.max(0, (mentions - 1) / (max - 1))) : 0;
  if (hub) return 4 + 24 * Math.pow(t, 0.7);                      // 1 mention = a dot, the busiest hub = a big disc
  if (n.type === "dump") return 6 + 5 * Math.min(1, mentions / 8);
  return (GRAPH_R[n.type] || ITEM_R) + Math.min(9, mentions * 0.3);
}

/** The largest hub mention count (what radiusFor scales against). */
export function maxHubMentions(nodes, counts) {
  let m = 1;
  for (const n of nodes) if (isHubType(n.type)) m = Math.max(m, counts.get(n.id) || 0);
  return m;
}

/** Ids that deserve a label, best first: concepts and people by mentions (ties by name, so the order never flickers);
 *  a map with no concepts or people falls back to its dumps. Items never compete for a name. */
export function rankedForLabels(nodes, counts) {
  const byRank = (a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.id < b.id ? -1 : 1);
  const hubs = nodes.filter((n) => isHubType(n.type)).sort(byRank);
  if (hubs.length) return hubs.map((n) => n.id);
  return nodes.filter((n) => !n.dump).sort(byRank).map((n) => n.id);
}
