// Overlay "Suggested links": ghost (dashed) edges between concepts that never share a dump but keep showing up in the
// same surroundings. Selecting one of the two concepts explains why and offers "Link these" / "Not related".
//
//  * suggestions: GET /api/graph/insights/suggested-links  (server ranks them, app/graph_insights.py)
//  * "Link these": POST /api/graph/insights/links -> kept in the vault settings as graph_manual_links. A data filter
//    (registered below, always on) injects every accepted link as a solid edge of type "manual", so it shows in every
//    layout whether or not this overlay is switched on. No dump is ever changed.
//  * "Not related": POST /api/graph/insights/dismiss -> never suggested again.
import { registerOverlay } from "./overlays.js";
import { registerFilter } from "./data.js";
import { onGraphReady } from "./hooks.js";
import { toast } from "../ui.js";
import { api as http } from "../api.js";
import { palette, fetchInsight, onAction, wireActions, legend, key, note, section, esc } from "./overlay-common.js";

const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

// ── accepted links (module state; refreshed from the server each visit) ─────────────────────────
let manual = [];
const sameLinks = (a, b) => a.length === b.length && a.every((l, i) => pairKey(l.a, l.b) === pairKey(b[i].a, b[i].b));

registerFilter({
  id: "manual-links",
  apply(nodes, edges) {
    if (!manual.length) return { nodes, edges };
    const ids = new Set(nodes.map((n) => n.id));
    const extra = manual.filter((l) => ids.has(l.a) && ids.has(l.b)).map((l) => ({ source: l.a, target: l.b, type: "manual" }));
    return extra.length ? { nodes, edges: edges.concat(extra) } : { nodes, edges };
  },
});

// ── suggestions (module cache so a rebuild of the map doesn't make the ghost edges blink) ───────
let cache = null;   // { t, links: [...] } minus anything accepted or dismissed since
const FRESH_MS = 5 * 60000;
const stateFrom = (links) => ({ links, byNode: links.reduce((m, l, i) => { (m[l.a] ||= []).push(i); (m[l.b] ||= []).push(i); return m; }, {}) });

let ctx = null;          // { api, state } of the current visit
let focusPair = null;    // the suggestion the user clicked on the map, shown first in the info box
const forceDraw = () => ctx?.api.requestDraw();

function drop(a, b) {
  if (!cache) return;
  const k = pairKey(a, b);
  cache.links = cache.links.filter((l) => pairKey(l.a, l.b) !== k);
  if (focusPair === k) focusPair = null;
  const live = ctx?.api.overlays.state("links");
  if (live && live.links) Object.assign(live, stateFrom(cache.links));   // the map is showing this very object
}
/** Rebuild the map (so accepted links appear/disappear as edges) and re-open the info box on the same node. */
function remount(selectId) {
  const { api, state } = ctx;
  state.mount();
  // overlay state reloads asynchronously after a rebuild, so wait a tick before re-rendering the info box
  if (selectId) setTimeout(() => { if (api.byId[selectId]) api.select(selectId); }, 0);
}
async function act(label, fn) {
  try { return await fn(); } catch (e) { toast(`${label}: ${e.message || "something went wrong"}`); return null; }
}

onAction("ov-link", async (d) => {
  if (!ctx) return;
  const r = await act("Couldn't link them", () => http.post("/graph/insights/links", { a: d.a, b: d.b }));
  if (!r) return;
  manual = r.links; drop(d.a, d.b);
  toast("Linked. You can undo it any time from the node's info box.");
  remount(ctx.api.selectedId);
});
onAction("ov-notrel", async (d) => {
  if (!ctx) return;
  const r = await act("Couldn't hide that suggestion", () => http.post("/graph/insights/dismiss", { a: d.a, b: d.b }));
  if (!r) return;
  drop(d.a, d.b);
  const id = ctx.api.selectedId;
  forceDraw();
  if (id) ctx.api.select(id);   // re-renders the info box
  toast("Okay, it won't be suggested again.");
});
onAction("ov-unlink", async (d) => {
  if (!ctx) return;
  const r = await act("Couldn't remove the link", () => http.del(`/graph/insights/links?a=${encodeURIComponent(d.a)}&b=${encodeURIComponent(d.b)}`));
  if (!r) return;
  manual = r.links; cache = null;
  remount(ctx.api.selectedId);
});

// ── geometry for clicking / hovering a ghost edge ───────────────────────────────────────────────
function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
function visiblePair(api, l) {
  const a = api.byId[l.a], b = api.byId[l.b];
  return a && b && api.isVisible(a) && api.isVisible(b) ? [a, b] : null;
}
function edgeAt(api, s, x, y) {
  const tol = 7 / api.view.scale;
  let best = null, bd = tol;
  for (const l of s.links) {
    const ab = visiblePair(api, l);
    if (!ab) continue;
    const d = Math.min(segDist(x, y, ab[0], ab[1]), Math.hypot(x - (ab[0].x + ab[1].x) / 2, y - (ab[0].y + ab[1].y) / 2) - 3 / api.view.scale);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

onGraphReady((api, state) => {
  ctx = { api, state };
  focusPair = null;
  wireActions();
  // accepted links: refresh from the server, rebuild the map if they changed since the first draw
  let alive = true;
  fetchInsight("/graph/insights/links", { fresh: true }).then((r) => {
    if (!alive || sameLinks(manual, r.links)) return;
    manual = r.links;
    if (state.data) state.mount();
  }, () => {});

  const offClick = api.on("click", (p) => {
    if (p.handled || p.node || !api.overlays.isActive("links")) return;
    const s = api.overlays.state("links");
    if (!s || !s.links) return;
    const l = edgeAt(api, s, p.point.x, p.point.y);
    if (!l) return;
    p.handled = true;
    focusPair = pairKey(l.a, l.b);
    api.select(l.a);
    setTimeout(() => document.querySelector("#graph-info .ov-sug.on")?.scrollIntoView({ block: "nearest" }), 0);   // the info box can be long
  });
  // a tooltip on the ghost edge under the pointer (the canvas is replaced on every rebuild, so re-attach each time)
  const offNodes = api.on("nodesChanged", () => {
    const c = api.canvas;
    if (!c) return;
    c.addEventListener("mousemove", (e) => {
      const s = api.overlays.isActive("links") && api.overlays.state("links");
      if (!s || !s.links) { if (c.title) c.title = ""; return; }
      const w = api.view.toWorld(e.clientX, e.clientY), l = edgeAt(api, s, w.x, w.y);
      const t = l ? `Suggested: ${l.a_label} and ${l.b_label}. ${l.reason} Click to see options.` : "";
      if (c.title !== t) c.title = t;
    });
  });
  return () => { alive = false; offClick(); offNodes(); if (ctx && ctx.api === api) ctx = null; };
});

// ── the overlay ──────────────────────────────────────────────────────────────────────────────
registerOverlay({
  id: "links",
  label: "Suggested links",
  icon: "✨",
  desc: "Draws faint dashed lines between concepts that never appear in the same dump but keep turning up in similar company. Click one to see why, then link them or say they are not related.",

  load() {
    if (cache && Date.now() - cache.t < FRESH_MS) return stateFrom(cache.links);
    return fetchInsight("/graph/insights/suggested-links", { fresh: true }).then(
      (r) => { cache = { t: Date.now(), links: r.links }; return stateFrom(cache.links); },
      () => ({ error: true, links: [], byNode: {} }));
  },

  drawUnder(c, api, s) {
    if (!s && !manual.length) return;
    const p = palette(api), sc = api.view.scale, active = api.hoverId || api.selectedId;
    const focus = api.prefs.get("focus") && api.selectedId ? api.neighborsOf(api.selectedId, 2) : null;
    const ok = (a, b) => api.isVisible(a) && api.isVisible(b) && (!focus || (focus.has(a.id) && focus.has(b.id)));
    c.save();
    // accepted links: a firmer line on top of the plain edge
    if (manual.length) {
      c.strokeStyle = p.accent2; c.lineWidth = 2 / Math.max(1, sc); c.globalAlpha = 0.7; c.setLineDash([]);
      for (const l of manual) {
        const a = api.byId[l.a], b = api.byId[l.b];
        if (!a || !b || !ok(a, b)) continue;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
    }
    if (s && s.links) {
      for (const l of s.links) {
        const a = api.byId[l.a], b = api.byId[l.b];
        if (!a || !b || !ok(a, b)) continue;
        const mine = active && (active === l.a || active === l.b), chosen = focusPair === pairKey(l.a, l.b);
        const boost = mine || chosen;
        c.globalAlpha = boost ? 1 : active ? 0.25 : 0.35 + 0.3 * l.score;
        c.strokeStyle = p.accent2; c.lineWidth = (boost ? 2.4 : 1.4) / Math.max(1, sc);
        c.setLineDash([6 / sc, 5 / sc]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        c.setLineDash([]);
        // a small "?" token halfway along: the thing to click
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = 6 / sc;
        c.fillStyle = p.bg; c.beginPath(); c.arc(mx, my, r, 0, Math.PI * 2); c.fill();
        c.lineWidth = 1.2 / sc; c.stroke();
        c.fillStyle = p.accent2; c.font = `600 ${9 / sc}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText("?", mx, my + 0.5 / sc);
      }
    }
    c.restore();
  },

  legend(s) {
    if (s === undefined) return note("Looking for missing connections…");
    if (s.error) return note("Couldn't look for suggestions just now. Try switching this off and on.");
    if (!s.links.length) return legend("Suggested links", `<span class="ov-sub">Nothing to suggest right now.</span>`);
    return legend("Suggested links", key("ghost", `Maybe related <span class="ov-sub">${s.links.length}</span>`), key("solid", "Linked by you"));
  },

  info(n, s) {
    if (!s || !s.links || (n.type !== "concept" && n.type !== "person")) return "";
    const mine = (s.byNode[n.id] || []).map((i) => s.links[i]);
    mine.sort((x, y) => (pairKey(y.a, y.b) === focusPair) - (pairKey(x.a, x.b) === focusPair) || y.score - x.score);
    const done = manual.filter((l) => l.a === n.id || l.b === n.id);
    if (!mine.length && !done.length) return "";
    const ids = (a, b) => `data-a="${esc(a)}" data-b="${esc(b)}"`;
    const cards = mine.slice(0, 3).map((l) => {
      const other = l.a === n.id ? l.b_label : l.a_label;
      return `<div class="ov-sug${pairKey(l.a, l.b) === focusPair ? " on" : ""}">
        <div class="ov-line"><b>${esc(n.label)}</b> ⟷ <b>${esc(other)}</b></div>
        <div class="ov-sub">${esc(l.reason)}</div>
        <div class="ov-btns"><button class="ov-btn primary" data-ov="ov-link" ${ids(l.a, l.b)}>Link these</button><button class="ov-btn" data-ov="ov-notrel" ${ids(l.a, l.b)}>Not related</button></div>
      </div>`;
    }).join("");
    const more = mine.length > 3 ? `<div class="ov-sub">+ ${mine.length - 3} more suggestions for this one</div>` : "";
    const linked = done.map((l) => `<div class="ov-row"><span class="ov-grow">Linked with <b>${esc(l.a === n.id ? l.b_label : l.a_label)}</b></span>
        <button class="ov-btn" data-ov="ov-unlink" ${ids(l.a, l.b)}>Unlink</button></div>`).join("");
    return section("✨", mine.length ? "Could be connected" : "Linked by you", cards + more + linked);
  },
});
