// Overlay "Open loops": dumps that still have undone tasks (badge = how many), overdue ones ringed in red.
// Counts come from GET /api/graph/insights/loops (app/graph_insights.py); trashed and private dumps never appear.
import { registerOverlay } from "./overlays.js";
import { palette, fetchInsight, readableOn, roomForBadge, legend, key, note, section, esc, plural } from "./overlay-common.js";

const DAY = 864e5;
function dueText(t, today) {
  if (!t.due) return "no due date";
  const diff = Math.round((Date.parse(t.due) - Date.parse(today)) / DAY);
  if (diff < 0) return `${plural(-diff, "day")} overdue`;
  if (diff === 0) return "due today";
  if (diff === 1) return "due tomorrow";
  return diff < 7 ? `due in ${diff} days` : "due " + new Date(Date.parse(t.due + "T12:00:00")).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

registerOverlay({
  id: "loops",
  label: "Open loops",
  icon: "🔁",
  desc: "Adds a number badge to dumps that still have tasks to do, and a red ring when one of them is overdue. A quick way to see which thoughts still need you.",

  load() {
    return fetchInsight("/graph/insights/loops").then((r) => ({ ...r }), () => ({ error: true }));
  },

  nodeStyle(n, s, api) {
    const d = n.type === "dump" && s && s.dumps && s.dumps[n.id];
    if (!d) return null;
    const p = palette(api), late = d.overdue > 0;
    const out = {};
    if (late) {
      // the dash is carried over so a dump that is both lonely and overdue still reads as both
      const lonely = api.overlays.isActive("lonely") && api.overlays.state("lonely")?.byId?.[n.id];
      out.ring = { color: p.red, width: 2.4, gap: 1, dash: lonely ? [3, 3] : undefined };
    }
    if (roomForBadge(n, api)) {
      const bg = late ? p.red : p.text;   // not amber: that would be mistaken for a concept node
      out.badge = { text: String(d.open), bg, color: readableOn(bg) }; }
    return out;
  },

  legend(s) {
    if (s === undefined) return note("Counting open tasks…");
    if (s.error) return note("Couldn't load your open tasks just now. Try switching this off and on.");
    if (!s.total_open) return legend("Open loops", `<span class="ov-sub">No open tasks. Nice and tidy.</span>`);
    return legend("Open loops", key("count", "Open tasks"), key("ring-red", `Overdue <span class="ov-sub">${s.total_overdue}</span>`));
  },

  info(n, s) {
    const d = n.type === "dump" && s && s.dumps && s.dumps[n.id];
    if (!d) return "";
    const rows = d.tasks.map((t) => `<div class="ov-row"><span class="ov-grow ov-task">${esc(t.title)}</span><span class="ov-sub${t.overdue ? " ov-late" : ""}">${esc(dueText(t, s.today))}</span></div>`).join("");
    const more = d.open > d.tasks.length ? `<div class="ov-sub">+ ${d.open - d.tasks.length} more</div>` : "";
    return section("🔁", `${plural(d.open, "open task")}${d.overdue ? `, ${d.overdue} overdue` : ""}`,
      rows + more + `<div class="ov-line" style="margin-top:6px"><a href="#history/${esc(n.id)}">Open dump →</a></div>`);
  },
});
