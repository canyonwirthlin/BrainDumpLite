// Dump templates: structured skeletons the Capture screen can pre-fill into the writing box.
// TEMPLATES are the built-in defaults, kept in code so an app update can add new ones. What a user
// changes (own templates, edited/deleted built-ins, pins, order) is stored server-side in ONE settings
// key (see app/routes_templates.py) and merged over these by resolveTemplates() below.
// `text` is inserted verbatim (cursor lands on the first blank line).
import { api } from "./api.js";

export const TEMPLATES = [
  { id: "morning", label: "Morning", text:
`Morning pages — just write, don't edit.

How I woke up feeling:

What's on my mind right now:

What I'm looking forward to / dreading today:

The one thing that would make today a good day:
` },
  { id: "shutdown", label: "Night", text:
`Shutdown — closing the day.

What I got done:

What's still open (and what it needs next):

What I'm letting go of until tomorrow:

Top 3 for tomorrow:
1.
2.
3.
` },
  { id: "meeting", label: "Meeting", text:
`Meeting:
Who was there:
Date:

What was discussed:

Decisions made:

Action items (who / what / by when):
-
` },
  { id: "worry", label: "Worry", text:
`What I'm worried about:

What's actually in my control here:

What isn't, and can I let it go:

The worst realistic outcome — and how I'd cope:

One small step I can take today:
` },
];

// Replace the contents of `ta` with a template (the caller confirms first when the box has text).
export function applyTemplate(ta, tpl) {
  ta.value = tpl.text;
  const first = Math.max(0, ta.value.indexOf("\n\n") + 2);
  ta.focus();
  ta.setSelectionRange(first, first);
  return ta.value;
}

// ── User changes: load / save / merge ────────────────────────────────────────

export const LIMITS = { label: 30, text: 5000, templates: 500, visiblePins: 6 };
const emptyDoc = () => ({ templates: [], overrides: {}, deleted: [], order: [], pinned: null });
const BUILTIN_IDS = TEMPLATES.map((t) => t.id);
let cache = null;
const listeners = new Set();

export const getDoc = () => cache || emptyDoc();
export const onTemplatesChanged = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => { try { fn(); } catch {} });

// A failed load leaves `cache` unset (the UI shows the built-ins, the next call retries) and saveDoc refuses to run:
// otherwise the first pin or edit would PUT an EMPTY document over the user's real templates.
export async function loadDoc(force = false) {
  if (cache && !force) return cache;
  try { cache = Object.assign(emptyDoc(), await api.get("/templates")); }
  catch { /* keep whatever we had (nothing on a first visit) */ }
  notify();
  return cache || emptyDoc();
}

// Persist a whole document; resolves to the server's normalised copy (throws with a readable message).
export async function saveDoc(next) {
  if (!cache) throw new Error("Your templates haven't loaded yet, so nothing was saved. Try again in a moment.");
  cache = Object.assign(emptyDoc(), await api.put("/templates", next));
  notify();
  return cache;
}

// The effective list in display order: built-ins (minus deleted, with edits applied) + the user's own.
// Each: {id, label, text, builtin, edited, pinned}. `order` lists ids the user arranged; anything not in it
// (a built-in added by a later update, a fresh template) follows, built-ins first.
export function resolveTemplates(doc = getDoc()) {
  const gone = new Set(doc.deleted);
  const all = [];
  for (const b of TEMPLATES) {
    if (gone.has(b.id)) continue;
    const o = doc.overrides[b.id];
    all.push({ id: b.id, label: o ? o.label : b.label, text: o ? o.text : b.text, builtin: true, edited: !!o });
  }
  for (const u of doc.templates) if (!BUILTIN_IDS.includes(u.id)) all.push({ id: u.id, label: u.label, text: u.text, builtin: false, edited: false });
  const byId = new Map(all.map((t) => [t.id, t]));
  const out = [], seen = new Set();
  for (const id of doc.order) if (byId.has(id) && !seen.has(id)) { out.push(byId.get(id)); seen.add(id); }
  for (const t of all) if (!seen.has(t.id)) out.push(t);
  const pins = doc.pinned === null ? new Set(BUILTIN_IDS) : new Set(doc.pinned);
  out.forEach((t) => { t.pinned = pins.has(t.id); });
  return out;
}

export const builtinDefault = (id) => TEMPLATES.find((t) => t.id === id) || null;
export const newTemplateId = () => "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Pure document edits (each returns a new document; the caller saves it) ──
const clone = (d) => JSON.parse(JSON.stringify(d));
const fullOrder = (doc) => resolveTemplates(doc).map((t) => t.id);

export function withPin(doc, id, on) {
  const d = clone(doc);
  const pins = resolveTemplates(doc).filter((t) => t.pinned).map((t) => t.id).filter((x) => x !== id);
  d.pinned = on ? [...pins, id] : pins;
  return d;
}

// Move `id` to just before (or, with after=true, just after) `targetId` in the manager order.
export function withMoveNear(doc, id, targetId, after = false) {
  const d = clone(doc);
  const ids = fullOrder(doc).filter((x) => x !== id), at = ids.indexOf(targetId);
  if (at < 0 || id === targetId) return d;
  ids.splice(after ? at + 1 : at, 0, id);
  d.order = ids;
  return d;
}

// Save the name/text of an existing template or add a new one. A built-in saved back to its default
// text drops its override (so it shows "built-in" again, not "edited").
export function withSaved(doc, id, label, text) {
  const d = clone(doc);
  const b = builtinDefault(id);
  if (b) {
    if (label === b.label && text === b.text) delete d.overrides[id];
    else d.overrides[id] = { label, text };
  } else {
    const t = d.templates.find((x) => x.id === id);
    if (t) { t.label = label; t.text = text; } else d.templates.push({ id, label, text });
  }
  return d;
}

export function withDeleted(doc, id) {
  const d = clone(doc);
  d.order = d.order.filter((x) => x !== id);
  if (d.pinned !== null) d.pinned = d.pinned.filter((x) => x !== id);
  if (builtinDefault(id)) { delete d.overrides[id]; if (!d.deleted.includes(id)) d.deleted.push(id); }
  else d.templates = d.templates.filter((t) => t.id !== id);
  return d;
}

export function withRestoredDefault(doc, id) { const d = clone(doc); delete d.overrides[id]; return d; }

export function withRestoredBuiltins(doc) {
  const d = clone(doc);
  if (d.pinned !== null) d.pinned = [...d.pinned, ...d.deleted.filter((x) => !d.pinned.includes(x))];
  d.deleted = [];
  return d;
}

// ── "Recently used" (this device only) ──
const RECENT_KEY = "bdl-tpl-recent";
export function recentIds() { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
export function noteUsed(id) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 30))); } catch {}
}

// Picker order: pinned first, then recently used, then A-Z. Each item gets group "pinned" | "recent" | "all".
export function pickerOrder(list, recents = recentIds()) {
  const rank = new Map(recents.map((id, i) => [id, i]));
  const az = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });
  const pinned = list.filter((t) => t.pinned);
  const recent = list.filter((t) => !t.pinned && rank.has(t.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const rest = list.filter((t) => !t.pinned && !rank.has(t.id)).sort(az);
  return [...pinned.map((t) => ({ ...t, group: "pinned" })), ...recent.map((t) => ({ ...t, group: "recent" })), ...rest.map((t) => ({ ...t, group: "all" }))];
}
