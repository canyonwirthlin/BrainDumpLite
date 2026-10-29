// Overlay "Connectors": concepts and people that tie otherwise separate parts of the map together.
// The maths lives in overlay-bridges-calc.js (betweenness + communities); this file only styles and explains.
import { registerOverlay } from "./overlays.js";
import { analyse } from "./overlay-bridges-calc.js";
import { palette, baseData, memo, legend, key, note, section, esc, cap, plural } from "./overlay-common.js";

const andList = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

registerOverlay({
  id: "bridges",
  label: "Connectors",
  icon: "🔗",
  desc: "Rings the concepts and people that tie different parts of your life together, like Sleep linking work, health and family. Handy for spotting the ideas that hold your topics together.",

  load(api) {
    const data = baseData(api);
    if (!data) return null;
    return memo(data, "bridges", () => analyse(data.nodes, data.edges));
  },

  nodeStyle(n, s, api) {
    const sc = s && s.score.get(n.id);
    if (sc == null) return null;
    const p = palette(api);
    return { ring: { color: p.text, width: 1.5 + 2 * sc, gap: 1 }, glow: p.accent, scale: 1 + 0.35 * sc };
  },

  legend(s) {
    if (s === undefined) return note("Looking for connectors…");
    if (!s || !s.top.length) return legend("Connectors", `<span class="ov-sub">None yet. They show up once your topics start overlapping.</span>`);
    return legend("Connectors", key("ring-text", "Bridges separate topics"), `<span class="ov-sub">${esc(plural(s.top.length, "connector"))}</span>`);
  },

  info(n, s) {
    const sc = s && s.score.get(n.id);
    if (sc == null) return "";
    const areas = s.connects(n.id).map((c) => cap(c.name));
    const strength = sc >= 0.66 ? "one of your strongest" : sc >= 0.33 ? "a clear" : "a lighter";
    return section("🔗", "Connector",
      (areas.length > 1 ? `<div class="ov-line"><b>Connects:</b> ${esc(andList(areas))}</div>` : "")
      + `<div class="ov-sub">Dumps about different areas meet at ${esc(n.label)}. It is ${strength} link between your topics.</div>`);
  },
});
