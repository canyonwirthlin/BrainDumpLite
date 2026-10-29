// Concept map: the dumps step out of the way and what is left is the web of ideas and people themselves.
// Dots are concepts and people (bigger = mentioned in more dumps); two are linked when they appear in the same dump,
// and a thicker, stronger line means they turn up together more often. Hide People in the legend for concepts only.
import { registerLayout } from "./layouts.js";
import { placeOrganic } from "./physics.js";
import { buildModel, dumpTime, clamp, cmp, nodeInfo, esc } from "./layout-util.js";

let W = { max: 1, stats: new Map(), nDumps: 0 };   // heaviest link, per-hub mention counts and first-seen times

/** Dump-level co-occurrence -> a graph of hubs. Keeps the strongest links so a big map stays readable. */
function prepare(data) {
  const m = buildModel(data.nodes, data.edges);
  const pair = new Map();
  for (const [, hubs] of m.hubsOf) {
    const ids = [...new Set(hubs)].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + "\u0001" + ids[j];
      pair.set(k, (pair.get(k) || 0) + 1);
    }
  }
  const nodes = m.hubs.filter((h) => (m.dumpsOf.get(h.id) || []).length > 0);
  const stats = new Map(nodes.map((h) => {
    const ds = (m.dumpsOf.get(h.id) || []).map((id) => m.byId.get(id));
    const times = ds.map(dumpTime).filter((t) => t > 0);
    return [h.id, { mentions: ds.length, first: times.length ? Math.min(...times) : 0, last: times.length ? Math.max(...times) : 0 }];
  }));
  let all = [...pair].map(([k, w]) => { const [a, b] = k.split("\u0001"); return { source: a, target: b, type: "co", weight: w }; });
  all.sort((x, y) => y.weight - x.weight || cmp(x.source + x.target, y.source + y.target));
  const budget = Math.max(60, Math.round(nodes.length * 1.8));
  const kept = new Set(all.slice(0, budget));
  const hasEdge = new Set();
  kept.forEach((e) => { hasEdge.add(e.source); hasEdge.add(e.target); });
  for (const e of all) {   // nobody is left stranded: every topic keeps its single strongest link
    if (!hasEdge.has(e.source) || !hasEdge.has(e.target)) { kept.add(e); hasEdge.add(e.source); hasEdge.add(e.target); }
  }
  const edges = all.filter((e) => kept.has(e));
  W = { max: Math.max(1, ...edges.map((e) => e.weight)), stats, nDumps: m.dumps.length };
  return { nodes: nodes.map((n) => ({ ...n, meta: { ...(n.meta || {}), mentions: stats.get(n.id).mentions } })), edges };
}

nodeInfo("concepts", (n, api) => {
  const mentions = (n.meta && n.meta.mentions) || 0;
  const partners = api.edges.filter((e) => e.source === n.id || e.target === n.id)
    .map((e) => ({ n: api.byId[e.source === n.id ? e.target : e.source], w: e.weight || 1 }))
    .filter((p) => p.n).sort((a, b) => b.w - a.w || cmp(a.n.label, b.n.label));
  const open = `<a href="#graph/${n.type}/${encodeURIComponent(n.label)}">Open ${n.type} →</a>`;
  return `<b>${n.type === "concept" ? "💡" : "🧑"} ${esc(n.label)}</b>
    <div class="small muted" style="margin:6px 0">${mentions} dump${mentions === 1 ? "" : "s"} · ${open}</div>
    ${partners.length ? `<div class="small muted" style="margin-top:8px">Comes up together with</div>` : `<div class="small muted" style="margin-top:8px">Not linked to anything else yet.</div>`}
    ${partners.slice(0, 8).map((p) => `<div style="margin-top:3px">${esc(p.n.label)} <span class="small muted">· ${p.w} dump${p.w === 1 ? "" : "s"} together</span></div>`).join("")}`;
});

registerLayout({
  id: "concepts", label: "Concept map", icon: "🕸️",
  desc: "Hides the individual dumps and shows only your ideas and people. Bigger dots are mentioned more, and two dots are joined when they come up in the same dump, with thicker lines for pairs that appear together often. It's the cleanest view of what you actually think about.",
  forces: { repulsion: 1.15, reach: 420, linkPull: 1, linkLength: 1.15, centerPull: 0.009, anchor: 0, collidePad: 9 },
  hint: "Bigger dots are mentioned in more dumps. A line means two ideas turn up in the same dump, and thicker means they do it more often. Hide People in the key above for a concepts-only map.",
  prepare,
  place(api) {
    for (const n of api.nodes) {
      const st = W.stats.get(n.id);
      n.r = clamp(5.5 + 3 * Math.sqrt((n.meta && n.meta.mentions) || 1), 5, 24);
      if (st && st.first) n.born = st.first;
    }
    placeOrganic(api.sim, api.env());
  },
  edgeStyle(e) {
    const f = W.max > 1 ? Math.pow(((e.weight || 1) - 1) / (W.max - 1), 0.8) : 0.4;
    return { width: 0.9 + 5 * f, alpha: 1.5 + 2.6 * f };
  },
  note: (api) => {
    if (api.nodes.length < 2) return "<b>Nothing to connect yet.</b><br>Once your dumps mention a few concepts or people, they show up here linked together.";
    if (!api.edges.length) return "<b>No connections yet.</b><br>Ideas get linked here when they appear in the same dump.";
    return null;
  },
});

