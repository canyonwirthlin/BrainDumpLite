// Overlay "Rising & fading": concepts and people mentioned more (or far less) lately than before.
// Recent = the last 30 days; baseline = the 90 days before that, counted per 30 days. Client-side from dump dates.
import { registerOverlay } from "./overlays.js";
import { palette, baseData, memo, readableOn, roomForBadge, legend, key, note, section, esc, plural } from "./overlay-common.js";

const DAY = 864e5;

function compute(data) {
  const now = Date.now(), t30 = now - 30 * DAY, t120 = now - 120 * DAY;
  const when = new Map();
  for (const n of data.nodes) if (n.type === "dump") { const t = Date.parse(n.created_at || ""); if (!Number.isNaN(t)) when.set(n.id, t); }
  const kind = new Map(data.nodes.filter((n) => n.type === "concept" || n.type === "person").map((n) => [n.id, n]));
  const stat = new Map();
  for (const e of data.edges) {
    if (e.type !== "mention") continue;
    const d = when.has(e.source) ? e.source : when.has(e.target) ? e.target : null;
    const c = d === e.source ? e.target : e.source;
    if (!d || !kind.has(c)) continue;
    const t = when.get(d);
    if (t < t120) continue;
    const s = stat.get(c) || (stat.set(c, { recent: 0, prev: 0 }), stat.get(c));
    if (t >= t30) s.recent++; else s.prev++;
  }
  // concepts that were only ever mentioned long ago have no entry above and are simply left alone
  const rising = new Map(), fading = new Map();
  for (const [id, s] of stat) {
    const base = s.prev / 3;   // per 30 days
    if (s.recent >= 2 && s.recent - base >= 1.5 && s.recent >= base * 1.5) rising.set(id, { ...s, base, boost: Math.min(1, (s.recent - base) / 6) });
    else if (s.prev >= 3 && s.recent <= base * 0.34 && base - s.recent >= 1) fading.set(id, { ...s, base });
  }
  return { rising, fading };
}

registerOverlay({
  id: "trends",
  label: "Rising & fading",
  icon: "📈",
  desc: "Makes concepts and people that came up a lot more in the last 30 days glow green, and fades the ones that have gone quiet. Shows what your mind is on now compared with a few months ago.",

  load(api) {
    const data = baseData(api);
    return data ? memo(data, "trends", () => compute(data)) : null;
  },

  nodeStyle(n, s, api) {
    if (!s) return null;
    const up = s.rising.get(n.id);
    if (up) {
      const p = palette(api);
      return { glow: p.green, scale: 1.1 + 0.25 * up.boost, badge: roomForBadge(n, api) ? { text: "↑", bg: p.green, color: readableOn(p.green) } : null };
    }
    if (s.fading.has(n.id)) {
      const p = palette(api);
      return { alpha: 0.5, badge: roomForBadge(n, api) ? { text: "↓", bg: p.dim, color: readableOn(p.dim) } : null };
    }
    return null;
  },

  legend(s) {
    if (s === undefined) return note("Checking what is changing…");
    if (!s || (!s.rising.size && !s.fading.size)) return legend("Rising & fading", `<span class="ov-sub">Nothing has changed much lately.</span>`);
    return legend("Rising & fading",
      key("up", `Rising <span class="ov-sub">${s.rising.size}</span>`), key("down", `Fading <span class="ov-sub">${s.fading.size}</span>`));
  },

  info(n, s) {
    if (!s) return "";
    const up = s.rising.get(n.id), down = s.fading.get(n.id);
    const t = up || down;
    if (!t) return "";
    const per = Math.round(t.base * 10) / 10;
    const before = `${plural(t.prev, "mention")} in the 90 days before that (about ${per} a month)`;
    return section(up ? "📈" : "📉", up ? "Rising lately" : "Gone quiet",
      `<div class="ov-line">${esc(plural(t.recent, "mention"))} in the last 30 days</div><div class="ov-sub">${esc(before)}.</div>`
      + (up ? "" : `<div class="ov-sub">Not a problem, just something you used to think about more.</div>`));
  },
});
