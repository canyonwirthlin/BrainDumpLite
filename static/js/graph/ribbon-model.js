// Pure helpers behind the Brain map ribbon (graph/ribbon.js). No DOM, no imports: node can load this file directly,
// which is how tests/test_graph_ribbon_model.py checks the logic.

/** A tool field may be a plain value or a function that is read on every refresh (a label that flips, an icon that changes). */
export const val = (v, ...args) => (typeof v === "function" ? v(...args) : v);

/** The text a tool is called in the "?" panel and in screen readers: its label, else its tip. */
export const toolName = (t) => String(val(t.label) || t.tip || t.id || "").trim();

/** The first sentence of a longer description (a layout's `desc` becomes its one-sentence tooltip). */
export function firstSentence(text, max = 140) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  let out = m ? m[0] : s;
  if (out.length > max) out = out.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…";
  return out;
}

/** The tab to open: the remembered one if it still exists, else the first tab. */
export function pickTab(saved, tabs) {
  return tabs.some((t) => t.id === saved) ? saved : (tabs[0] && tabs[0].id) || "";
}

/** Tools of one tab as a flat row: { type: "tool", tool } entries with { type: "divider" } wherever `group` changes. */
export function buildRow(tools) {
  const row = [];
  let prev;
  tools.forEach((tool, i) => {
    const g = tool.group == null ? "" : String(tool.group);
    if (i > 0 && g !== prev) row.push({ type: "divider", group: g });
    row.push({ type: "tool", tool });
    prev = g;
  });
  return row;
}

/** Changes whenever the set or order of a tab's tools changes, so the ribbon knows when it must redraw (not just refresh). */
export const tabSignature = (tools) => tools.map((t) => t.id).join("|");

/** What the "?" panel shows for a tab: the tab's own help text plus every tool's name and plain-English help. */
export function helpModel(tab, tools) {
  return {
    title: `${tab.label} tab`,
    intro: tab.help || "",
    items: tools.map((t) => ({ id: t.id, name: toolName(t), help: String(t.help || t.tip || "").trim(), key: t.key || "" })),
  };
}

/** Where a tooltip goes: centred under its anchor (or above it when there is no room below), kept inside the viewport.
 *  rect = anchor box, size = { w, h } of the tooltip, view = { w, h } of the viewport. */
export function placeTip(rect, size, view, gap = 8, margin = 8) {
  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - size.w / 2, view.w - size.w - margin));
  const below = rect.bottom + gap;
  const fitsBelow = below + size.h <= view.h - margin;
  const top = fitsBelow ? below : Math.max(margin, rect.top - gap - size.h);
  return { left: Math.round(left), top: Math.round(top), side: fitsBelow ? "below" : "above" };
}

/** Index of the tab to move to for an arrow / Home / End key on the tab strip (wraps around), or -1 for any other key. */
export function nextTabIndex(key, index, count) {
  if (!count) return -1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}
