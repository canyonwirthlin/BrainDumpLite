// Brain map undo stack. Every EDIT the user makes on the map (a link drawn, a link removed, a merge) pushes one entry
// here so Ctrl+Z / Ctrl+Shift+Z (and the Edit tab's Undo / Redo buttons) can reverse and replay it.
//
//   pushUndo({ label, undo, redo })    label: "Link A to B" (shown in the button tooltip); undo/redo: async functions that
//                                       perform the reverse / the original change against the backend AND the screen.
//                                       Call it AFTER the change succeeded. A new push clears the redo stack.
//   undo() / redo()                    resolve true when something ran. Errors are caught and shown as a toast; the entry
//                                       stays where it was so the user can retry.
//   canUndo() / canRedo() / peekLabels()   for the buttons.  onUndoChange(fn) fires after any change.
//   clearUndo()                        call when the map is left (the view does this) so entries never outlive their map.
//
// Keyboard (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) is bound by installUndoKeys(); it ignores keys typed in inputs,
// textareas and contenteditable. Owner: graph-undo. Others only push entries.
import { toast } from "../ui.js";

const MAX = 100;
let past = [], future = [], busy = false;
const listeners = new Set();
const fire = () => { for (const f of listeners) f(); };

export function pushUndo(entry) {
  if (!entry || typeof entry.undo !== "function" || typeof entry.redo !== "function") throw new Error("pushUndo needs {label, undo, redo}");
  past.push({ label: entry.label || "change", undo: entry.undo, redo: entry.redo });
  if (past.length > MAX) past.shift();
  future = [];
  fire();
}
async function run(from, to, which) {
  if (busy || !from.length) return false;
  busy = true;
  const e = from[from.length - 1];
  try { await e[which](); from.pop(); to.push(e); return true; }
  catch (err) { toast(`Couldn't ${which} “${e.label}”: ${err.message || err}`); return false; }
  finally { busy = false; fire(); }
}
export const undo = () => run(past, future, "undo");
export const redo = () => run(future, past, "redo");
export const canUndo = () => past.length > 0 && !busy;
export const canRedo = () => future.length > 0 && !busy;
export const peekLabels = () => ({ undo: past.length ? past[past.length - 1].label : null, redo: future.length ? future[future.length - 1].label : null });
export function clearUndo() { past = []; future = []; fire(); }
export function onUndoChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let keysOn = false;
export function installUndoKeys() {
  if (keysOn) return;
  keysOn = true;
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("graph-wrap")) return;   // only while the Brain map is on screen
    const t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
  });
}
