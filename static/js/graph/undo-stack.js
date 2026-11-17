// The pure heart of the Brain map undo stack: no DOM, no imports, so node can run it (tests/test_graph_undo.py).
// graph/undo.js wraps one instance of this for the app (toast on error, keyboard binding).
//
//   const s = createUndoStack({ max: 100, onError(err, entry, which) {} });
//   s.push({ label, undo, redo })     after a change succeeded; clears the redo stack; the oldest entry falls off past `max`
//   s.undo() / s.redo()               resolve true when an entry ran. Calls are QUEUED (two quick Ctrl+Z presses undo two
//                                     entries, in order) and each one looks at the stack when its turn comes.
//   s.canUndo() / s.canRedo()         false while an operation is running, so the buttons grey out
//   s.peekLabels() -> { undo, redo }  labels of the next entries (null when empty)
//   s.clear()  s.size()  s.onChange(fn) -> off
//
// Errors: a failing undo/redo calls onError and leaves the entry where it was, so the user can retry. An error with
// `permanent: true` (the backend says "that can never be undone", e.g. the notes changed since) drops the entry instead,
// otherwise it would block every older entry for ever.
export function createUndoStack({ max = 100, onError } = {}) {
  let past = [], future = [], busy = false, chain = Promise.resolve();
  const listeners = new Set();
  const fire = () => { for (const f of listeners) { try { f(); } catch { /* a bad listener must not break the stack */ } } };

  function push(entry) {
    if (!entry || typeof entry.undo !== "function" || typeof entry.redo !== "function") throw new Error("pushUndo needs {label, undo, redo}");
    past.push({ label: entry.label || "change", undo: entry.undo, redo: entry.redo });
    if (past.length > max) past.shift();
    future = [];
    fire();
  }

  async function run(from, to, which) {
    if (!from.length) return false;
    const e = from[from.length - 1];
    busy = true; fire();
    try {
      await e[which]();
      if (from[from.length - 1] === e) from.pop();   // clear() may have emptied the stack while the entry was running
      to.push(e);
      return true;
    } catch (err) {
      if (err && err.permanent && from[from.length - 1] === e) from.pop();
      try { if (onError) onError(err, e, which); } catch { /* ignore */ }
      return false;
    } finally { busy = false; fire(); }
  }

  // Each call waits for the previous one, so presses are serialised instead of dropped.
  const queue = (from, to, which) => (chain = chain.then(() => run(from === "past" ? past : future, to === "past" ? past : future, which)));
  // `past` / `future` are reassigned by push() and clear(), so they are looked up by name when the call's turn comes.
  return {
    push,
    undo: () => queue("past", "future", "undo"),
    redo: () => queue("future", "past", "redo"),
    canUndo: () => past.length > 0 && !busy,
    canRedo: () => future.length > 0 && !busy,
    peekLabels: () => ({ undo: past.length ? past[past.length - 1].label : null, redo: future.length ? future[future.length - 1].label : null }),
    size: () => past.length,
    clear() { past = []; future = []; fire(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** True when the keyboard target is somewhere text is typed (so Ctrl+Z belongs to that field, not the map). */
export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
  if (tag !== "INPUT") return false;
  const type = String(t.type || "text").toLowerCase();
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"].includes(type);
}

/** What an undo key press means: "undo", "redo" or null. Pure so it can be tested. */
export function undoKeyAction(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = String(e.key || "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}
