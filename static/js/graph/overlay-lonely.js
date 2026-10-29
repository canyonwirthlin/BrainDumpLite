// Overlay "Lonely dumps": dumps nothing else on the map connects to. Which ones, and their nearest candidates,
// come from GET /api/graph/insights/lonely (app/graph_insights.py); this file draws and explains.
import { registerOverlay } from "./overlays.js";
import { palette, fetchInsight, legend, key, note, section, esc, plural } from "./overlay-common.js";

const when = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };

registerOverlay({
  id: "lonely",
  label: "Lonely dumps",
  icon: "🏝️",
  desc: "Puts a dashed ring around dumps that nothing else connects to: no link to another dump and almost no shared concepts or people. Selecting one suggests the dumps it most resembles, so loose thoughts can find a home.",

  load() {
    return fetchInsight("/graph/insights/lonely").then(
      (r) => ({ byId: Object.fromEntries(r.dumps.map((d) => [d.id, d])), count: r.count, shown: r.dumps.length }),
      () => ({ error: true }));
  },

  nodeStyle(n, s, api) {
    if (n.type !== "dump" || !s || !s.byId || !s.byId[n.id]) return null;
    return { ring: { color: palette(api).accent2, width: 2, dash: [3, 3], gap: 1 } };
  },

  legend(s) {
    if (s === undefined) return note("Looking for lonely dumps…");
    if (s.error) return note("Couldn't check for lonely dumps just now. Try switching this off and on.");
    if (!s.count) return legend("Lonely dumps", `<span class="ov-sub">None. Every dump is connected to something.</span>`);
    return legend("Lonely dumps", key("dashed", "Nothing else connects to it"), `<span class="ov-sub">${esc(plural(s.count, "dump"))}</span>`);
  },

  info(n, s) {
    const d = n.type === "dump" && s && s.byId && s.byId[n.id];
    if (!d) return "";
    const cands = d.candidates.map((c) => `<div class="ov-row"><span class="ov-grow"><a href="#history/${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</a>
        <span class="ov-sub">${esc(when(c.created_at))}${c.via === "meaning" ? " · similar in meaning" : " · shares words"}</span></span>
        <a class="ov-btn" href="#history/${esc(c.id)}">Open</a></div>`).join("");
    return section("🏝️", "Lonely dump",
      `<div class="ov-sub">Nothing else connects to this one yet.</div>`
      + (cands ? `<div class="ov-line" style="margin-top:6px"><b>Might belong with</b></div>${cands}` : `<div class="ov-sub" style="margin-top:4px">No close matches yet.</div>`));
  },
});
