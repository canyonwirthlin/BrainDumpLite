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
  desc: "A spiral galaxy with one arm per topic: every dump gets its own slot, oldest in the middle and newest on the rim, and ideas that span topics sit between the arms.",
  // Targets are spread so no two nodes overlap (physics.spreadTargets), so every node is simply held on its target:
  // no repulsion, hardly any link pull, and a small slack so collisions can still settle.
  forces: { repulsion: 0, reach: 70, linkPull: 0.05, centerPull: 0.004, anchor: 0.14, collidePad: 8 },
  place: (api) => placeGalaxy(api.sim, api.env()),
  // The Spacing slider re-spreads the spiral: new targets, nodes glide there.
  relayout(api) {
    const was = api.nodes.map((n) => [n, n.x, n.y]);
    placeGalaxy(api.sim, api.env());
    was.forEach(([n, x, y]) => { n.x = x; n.y = y; });
    api.reheat({ keepView: true });
  },
  // Faint rings mark when the spiral reaches each quarter (or year, or month, depending on how long the history is).
  drawUnder(ctx, api) {
    const g = api.sim && api.sim.galaxy;
    if (!g || g.times.length < 8) return;
    const t = g.times.filter((x) => x > 0);
    if (t.length < 8) return;
    const t0 = Math.min(...t), t1 = Math.max(...t), days = (t1 - t0) / 864e5;
    const every = days > 1100 ? 12 : days > 200 ? 3 : 1, s = api.view.scale;   // months between rings
    const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + (every - (d.getMonth() % every)) % every + (d.getTime() < t0 ? every : 0));
    ctx.save();
    ctx.strokeStyle = api.colors.edge; ctx.fillStyle = api.colors.edge; ctx.font = `${10.5 / s}px sans-serif`; ctx.textAlign = "left";
    for (let guard = 0; d.getTime() < t1 && guard < 60; guard++, d.setMonth(d.getMonth() + every)) {
      const i = g.times.findIndex((x) => x >= d.getTime());
      if (i < 1) continue;
      const r = g.step * Math.sqrt(i + 2);
      if (r * s < 36) continue;
      ctx.globalAlpha = 0.16; ctx.lineWidth = 1 / s; ctx.setLineDash([3 / s, 5 / s]);
      ctx.beginPath(); ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.7;
      ctx.fillText(d.toLocaleDateString(undefined, { month: "short", year: "numeric" }), g.cx + 4 / s, g.cy - r - 3 / s);
    }
    ctx.restore();
  },
});
