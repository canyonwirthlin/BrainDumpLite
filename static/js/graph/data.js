// Loading the graph and the ordered filter pipeline that decides which nodes/edges the map shows.
//
// A filter is { id, apply(nodes, edges, prefs, ctx) -> { nodes, edges } }. Filters run in array order on
// the output of the previous one. ctx = { all: { nodes, edges } (the unfiltered dataset), types }.
// Register yours with registerFilter() (optionally { before: "<id>" } / { after: "<id>" }) and read your own
// persisted pref through prefs.get(); prefs.define() creates one. Always return edges whose endpoints survive:
// keep(nodes, edges) does that for you.
import { api } from "../api.js";
import { RANGES } from "./prefs.js";

export const FALLBACK_TYPES = [
  { id: "dump", label: "Dumps", color: "accent", builtin: true },
  { id: "concept", label: "Concepts", color: "amber", builtin: true },
  { id: "person", label: "People", color: "blue", builtin: true },
];

export async function fetchTypes() { return api.get("/graph/types"); }

/** True when item nodes (tasks, ideas ...) must be fetched: some item type is switched on, or an active
 *  overlay declares needs: ["items"]. */
export const needItems = (types, hidden, overlayNeedsItems = false) => overlayNeedsItems || types.some((t) => !t.builtin && !hidden.has(t.id));

/** GET /graph (with item nodes on request). Returns the dataset plus `hasItems`. Throws on failure. */
export async function loadGraph(withItems) {
  const data = await api.get("/graph" + (withItems ? "?items=1" : ""));
  data.hasItems = withItems;
  return data;
}

/** Drop edges whose endpoints are no longer in `nodes`. */
export function keep(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

export const filters = [
  // 1. node types toggled off in the legend
  { id: "types", apply: (nodes, edges, prefs) => keep(nodes.filter((n) => !prefs.hidden.has(n.type)), edges) },
  // 2. date range: a dump outside the range takes its items with it (judged against the full dataset, so
  //    items still go when their dump's own type is hidden)
  { id: "range", apply(nodes, edges, prefs, ctx) {
    const days = RANGES[prefs.get("range")]?.[1] || 0;
    const cutoff = days ? new Date(Date.now() - days * 864e5).toISOString() : "";
    if (!cutoff) return { nodes, edges };
    const outOfRange = new Set(ctx.all.nodes.filter((n) => n.type === "dump" && (n.created_at || "") < cutoff).map((n) => n.id));
    return keep(nodes.filter((n) => !outOfRange.has(n.id) && !(n.dump && outOfRange.has(n.dump))), edges);
  } },
  // 3. concepts/people mentioned in fewer than minMentions of the remaining dumps drop out. Always runs
  //    (threshold at least 1) so a concept/person whose dumps were all filtered out by the date range goes too.
  { id: "mentions", apply(nodes, edges, prefs) {
    const dumpIds = new Set(nodes.filter((n) => n.type === "dump").map((n) => n.id));
    const seen = {};
    edges.forEach((e) => {
      if (dumpIds.has(e.source)) (seen[e.target] ||= new Set()).add(e.source);
      if (dumpIds.has(e.target)) (seen[e.source] ||= new Set()).add(e.target);
    });
    const min = Math.max(1, prefs.get("minMentions"));
    return keep(nodes.filter((n) => (n.type !== "concept" && n.type !== "person") || (seen[n.id]?.size || 0) >= min), edges);
  } },
];

/** Add a filter. opts.before / opts.after: id of an existing filter to sit next to (default: at the end). */
export function registerFilter(filter, opts = {}) {
  const at = filters.findIndex((f) => f.id === (opts.before || opts.after));
  if (at < 0) filters.push(filter);
  else filters.splice(opts.before ? at : at + 1, 0, filter);
  return filter;
}

/** Run the whole pipeline over the raw dataset: -> { nodes, edges }. */
export function applyFilters(raw, prefs) {
  let cur = { nodes: raw.nodes, edges: raw.edges };
  const ctx = { all: raw };
  for (const f of filters) cur = f.apply(cur.nodes, cur.edges, prefs, ctx);
  return cur;
}
