// Small helpers shared by the Brain map exports and the time-lapse recorder. No DOM access at import time, so the
// pure ones can be unit-tested under plain Node (tests/test_graph_export.py).

/** YYYY-MM-DD in the user's local time zone. */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Sleep & mood!" -> "sleep-mood": a short, file-name-safe fragment. */
export function slugify(s, max = 32) {
  const out = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, max).replace(/-+$/, "");
}

/** Mirrors app/export_md._safe_title: the part of a mirrored Obsidian note's file name that comes from the title. */
export function safeNoteTitle(title) {
  // eslint-disable-next-line no-control-regex
  let t = String(title || "Untitled").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().replace(/\.+$/, "");
  if (!t) t = "Untitled";
  return Array.from(t).slice(0, 60).join("");
}

/** The [[wikilink]] of the note app/obsidian.py writes for a dump (file name "<safe title> <first 8 id chars>.md"),
 *  or null when that name cannot be linked to (Obsidian treats [ ] # ^ | specially inside a link). */
export function noteWikilink(title, dumpId) {
  const name = `${safeNoteTitle(title)} ${String(dumpId).slice(0, 8)}`;
  return /[[\]#^|]/.test(name) ? null : `[[${name}]]`;
}

/** The nodes the map is drawing right now: past every registered visibility predicate (time-lapse, plugins) and,
 *  in Focus mode, inside two hops of the selection. */
export function visibleNodes(api) {
  const selected = api.selectedId;
  const hood = api.prefs.get("focus") && selected ? api.neighborsOf(selected, 2) : null;
  return api.nodes.filter((n) => api.isVisible(n) && (!hood || hood.has(n.id)));
}

/** Edges whose two ends are both in `ids` (a Set of node ids). */
export const edgesAmong = (api, ids) => api.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
