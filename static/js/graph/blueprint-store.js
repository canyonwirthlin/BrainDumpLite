// Link mode data: the list of links the user made by hand (what the map draws as blueprint wires) and the two calls that
// change it. The backend is app/routes_graph_links.py. This module has no DOM.
//
//   links      [{ a, b, kind, a_label, b_label }]  kind: dump-dump | dump-concept | dump-person | pair
//   fetchLinks() / createLink(a, b, names?) / removeLink(a, b)   each updates `links` before it resolves
//
// It also registers a data filter that keeps concept <-> concept / person edges (kind "pair") in step with this list, so
// a link made in Link mode joins the map's own graph (neighbours, physics, Path) at once. The "Suggested links" overlay
// injects the same edges from its own copy of the list, which can be stale after an edit made here; this filter runs after
// it and drops any such edge that is no longer in the list.
import { api as http } from "../api.js";
import { registerFilter } from "./data.js";
import { pairKey } from "./blueprint-calc.js";

let links = [];
let loaded = false;
const listeners = new Set();

export const getLinks = () => links;
export const isLoaded = () => loaded;
export const onLinksChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const sig = (list) => list.map((l) => l.kind + ":" + pairKey(l.a, l.b)).sort().join("\n");

function set(list) {
  const changed = sig(list) !== sig(links) || !loaded;
  links = list; loaded = true;
  if (changed) for (const f of [...listeners]) f(links);
  return changed;
}

/** Load the list from the server. Resolves true when it differs from what we had. */
export async function fetchLinks() { return set((await http.get("/graph/blueprint/links")).links); }

/** Make a link. Resolves { created, kind, names }: created=false means it was already there (nothing changed). */
export async function createLink(a, b, names) {
  const r = await http.post("/graph/blueprint/link", names && names.length ? { a, b, names } : { a, b });
  set(r.links);
  return r;
}

/** Remove a link. Resolves { removed, kind, names } (names = what was taken off the note, so an undo can put it back). */
export async function removeLink(a, b) {
  const r = await http.del(`/graph/blueprint/link?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  set(r.links);
  return r;
}

export const hasLink = (kind, a, b) => links.some((l) => l.kind === kind && pairKey(l.a, l.b) === pairKey(a, b));

registerFilter({
  id: "blueprint-links",
  apply(nodes, edges) {
    if (!loaded) return { nodes, edges };
    const want = new Set(links.filter((l) => l.kind === "pair").map((l) => pairKey(l.a, l.b)));
    let out = edges;
    if (edges.some((e) => e.type === "manual" && !want.has(pairKey(e.source, e.target)))) out = edges.filter((e) => e.type !== "manual" || want.has(pairKey(e.source, e.target)));
    const have = new Set(out.filter((e) => e.type === "manual").map((e) => pairKey(e.source, e.target)));
    const ids = new Set(nodes.map((n) => n.id));
    const extra = links.filter((l) => l.kind === "pair" && ids.has(l.a) && ids.has(l.b) && !have.has(pairKey(l.a, l.b)))
      .map((l) => ({ source: l.a, target: l.b, type: "manual" }));
    return out === edges && !extra.length ? { nodes, edges } : { nodes, edges: out.concat(extra) };
  },
});
