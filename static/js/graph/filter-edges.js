// Edge controls: show/hide the two kinds of links on the Brain map and set how alike two dumps must be for a
// "similar" link to appear. Registered as a data filter (see data.js), so it applies before the map is built and
// path-finding, node sizes and the info box all agree with what is drawn. The control panel (panel.js) owns the UI.
//
//   mention links  dump <-> concept / person       (on by default)
//   similar links  dump <-> dump that read alike   (on by default, any score)
//   similarity threshold: similar links scoring below it are dropped (SIM_MIN = show every similar link)
//
// "in" links (a task / idea belongs to its dump) are structural and are never filtered here.
import { registerFilter } from "./data.js";
import { prefs } from "./prefs.js";

export const SIM_MIN = 0.5, SIM_MAX = 0.95;
/** Defaults = the behaviour before these controls existed: every link is drawn. */
export const EDGE_DEFAULTS = { edgeMention: true, edgeSimilar: true, edgeMinSimilar: SIM_MIN };

const flag = { parse: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined), serialize: (v) => (v ? "1" : "0") };
prefs.define("edgeMention", { key: "bdl-graph-edge-mention", def: EDGE_DEFAULTS.edgeMention, ...flag });
prefs.define("edgeSimilar", { key: "bdl-graph-edge-similar", def: EDGE_DEFAULTS.edgeSimilar, ...flag });
prefs.define("edgeMinSimilar", {
  key: "bdl-graph-edge-min-similar", def: EDGE_DEFAULTS.edgeMinSimilar,
  parse: (raw) => { const v = parseFloat(raw); return v >= 0 && v <= 1 ? v : undefined; },
});

export const edgesAreDefault = (p = prefs) => Object.entries(EDGE_DEFAULTS).every(([k, v]) => p.get(k) === v);
export function resetEdgePrefs(p = prefs) { Object.entries(EDGE_DEFAULTS).forEach(([k, v]) => p.set(k, v)); }

registerFilter({
  id: "edges",
  apply(nodes, edges, p) {
    const mention = p.get("edgeMention"), similar = p.get("edgeSimilar"), min = p.get("edgeMinSimilar");
    if (mention && similar && min <= SIM_MIN) return { nodes, edges };   // today's behaviour: leave the list alone
    return {
      nodes,
      edges: edges.filter((e) => e.type === "mention" ? mention : e.type === "similar" ? similar && (e.score ?? 1) >= min : true),
    };
  },
}, { after: "mentions" });
