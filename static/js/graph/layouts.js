// Layout registry. A layout decides where nodes start, which forces act on them, and (optionally) paints its
// own background and handles clicks on it. See docs/graph-architecture.md for the full contract.
//
//   LAYOUTS.push({
//     id, label, icon, desc,                   // desc: 1-2 sentences, shown to the user by the control panel
//     prepare?(data, api) -> { nodes, edges }, // transform the (already filtered) dataset before nodes are built
//     place(api),                              // set initial n.x/n.y (and n.tx/n.ty targets) on api.nodes
//     forces?: { repulsion, reach, linkPull, linkLength, centerPull, anchor, collide, collidePad },  // see physics.js
//     fixed?: true,                            // no physics at all: positions come straight from place()
//     drawUnder?(ctx2d, api),                  // background in WORLD coordinates, beneath edges and nodes
//     hitTest?(x, y, api) -> hit | null,       // x,y in WORLD coordinates; runs when no node is under the pointer
//     onClick?(hit, api),                      // a click that hitTest claimed
//   })
//
// Put a new layout in its own file (static/js/graph/layout-<name>.js) that pushes onto LAYOUTS, and import that file
// from static/js/graph/plugins.js.
import { placeOrganic, placeGalaxy } from "./physics.js";

export const LAYOUTS = [];

export function registerLayout(def) {
  const at = LAYOUTS.findIndex((l) => l.id === def.id);
  if (at >= 0) LAYOUTS[at] = def; else LAYOUTS.push(def);
  return def;
}

/** The registered layout for an id, falling back to "organic" (so a stale saved id never breaks the map). */
export const getLayout = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS.find((l) => l.id === "organic");
export const layoutId = (id) => getLayout(id).id;

registerLayout({
  id: "organic", label: "Organic", icon: "🫧",
  desc: "Force-directed clusters: nodes that share topics pull together and unrelated ones drift apart, so the shape of your thinking appears on its own.",
  // anchor 0: no targets, everything is pulled gently to the middle; repulsion pushes clusters apart.
  forces: { repulsion: 1, reach: 380, linkPull: 1, centerPull: 0.007, anchor: 0 },
  place: (api) => placeOrganic(api.sim, api.env()),
});

registerLayout({
  id: "galaxy", label: "Galaxy (by time)", icon: "🌌",
  desc: "Every dump gets its own slot on a time-ordered spiral, oldest in the middle and newest on the rim; concepts and people sit among the dumps that mention them.",
  // No repulsion (slots do the spacing), weak links, and every node is held towards its spiral target:
  // dumps and their items tightly, hubs (concepts, people) loosely so they fan out instead of stacking.
  forces: { repulsion: 0, reach: 60, linkPull: 0.25, centerPull: 0.007, anchor: (n) => (n.type === "dump" || n.dump ? 0.12 : 0.03) },
  place: (api) => placeGalaxy(api.sim, api.env()),
});
