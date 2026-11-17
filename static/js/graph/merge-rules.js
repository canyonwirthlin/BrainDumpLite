// What can be merged with what on the Brain map, and the words for it. Pure (no DOM, no imports): node tests it.
//
//   concept <-> concept   every dump that has the old name gets the new one (POST /api/merge/undoable)
//   person  <-> person    the same, for people
//   dump    <-> dump      the two notes become one note: the OLDER one survives and gets the other's text, concepts, people
//                         and tasks (POST /api/dumps/merge, same as the Merge button on a dump card)
//   anything else (tasks, ideas and other item nodes) cannot be merged.
const NOUN = { concept: "concept", person: "person", dump: "note" };

export const mergeableType = (type) => Object.prototype.hasOwnProperty.call(NOUN, type);
export const mergeable = (n) => !!n && mergeableType(n.type);
export const nounOf = (n) => (n && NOUN[n.type]) || "item";

/** Shorten a label for a tooltip or toast. */
export const short = (s, n = 32) => { s = String(s ?? "").replace(/\s+/g, " ").trim() || "Untitled"; return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };

/** Can `src` (the node being dragged) be merged with `tgt`? -> { ok: true } or { ok: false, reason } (plain English). */
export function canMerge(src, tgt) {
  if (!src || !tgt) return { ok: false, reason: "" };
  if (src === tgt || src.id === tgt.id) return { ok: false, reason: "That's the same node" };
  if (!mergeable(src)) return { ok: false, reason: "Tasks and other items can't be merged" };
  if (!mergeable(tgt) || src.type !== tgt.type) return { ok: false, reason: `A ${nounOf(src)} can only merge with another ${nounOf(src)}` };
  return { ok: true };
}

/** The floating label while a valid target is highlighted. */
export function prompt(src, tgt) {
  if (src.type === "dump") return `Combine “${short(src.label)}” and “${short(tgt.label)}” into one note`;
  return `Merge “${short(src.label)}” into “${short(tgt.label)}”`;
}

/** The toast after it happened. */
export function doneText(src, tgt, survivorLabel) {
  if (src.type === "dump") return `Combined two notes into “${short(survivorLabel || tgt.label)}”. Ctrl+Z to undo`;
  return `Merged “${short(src.label)}” into “${short(tgt.label)}”. Ctrl+Z to undo`;
}

/** The label the undo button and its tooltip show. */
export const undoLabel = (src, tgt) => (src.type === "dump" ? `Combine “${short(src.label, 24)}” and “${short(tgt.label, 24)}”` : `Merge “${short(src.label, 24)}” into “${short(tgt.label, 24)}”`);

/** The hint shown while dragging a node over empty space in Merge mode. */
export const dropHint = (src) => (mergeable(src) ? `Drop on another ${nounOf(src)} to merge` : "Tasks and other items can't be merged");
