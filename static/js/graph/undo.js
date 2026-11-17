// Brain map undo stack. Every EDIT the user makes on the map (a link drawn, a link removed, a merge) pushes one entry
// here so Ctrl+Z / Ctrl+Shift+Z (and the Edit tab's Undo / Redo buttons) can reverse and replay it.
//
//   pushUndo({ label, undo, redo })    label: "Link A to B" (shown in the button tooltip); undo/redo: async functions that
//                                       perform the reverse / the original change against the backend AND the screen.
//                                       Call it AFTER the change succeeded. A new push clears the redo stack.
//   undo() / redo()                    resolve true when something ran. Presses are queued, not dropped. Errors are caught
//                                       and shown as a toast; the entry stays where it was so the user can retry, unless the
//                                       thrown error has `permanent: true` (it can never work, e.g. the notes changed since):
//                                       then the entry is dropped so older entries stay reachable.
//   canUndo() / canRedo() / peekLabels()   for the buttons.  onUndoChange(fn) fires after any change.
//   clearUndo()                        call when the map is left (the ready hook in edit-tools.js does this on every visit)
//                                       so entries never outlive their map.
//
// Keyboard (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) is bound by installUndoKeys(); it works only while the Brain map is on
// screen and never while typing in a text field or while a dialog is open. The stack itself lives in undo-stack.js (pure,
// tested under Node). Owner: graph-undo. Others only push entries.
import { toast } from "../ui.js";
import { createUndoStack, isTypingTarget, undoKeyAction } from "./undo-stack.js";

const stack = createUndoStack({
  max: 100,
  onError: (err, entry, which) => toast(`Couldn't ${which} “${entry.label}”: ${(err && err.message) || err}`, true),
});

export const pushUndo = stack.push;
export const undo = stack.undo;
export const redo = stack.redo;
export const canUndo = stack.canUndo;
export const canRedo = stack.canRedo;
export const peekLabels = stack.peekLabels;
export const clearUndo = stack.clear;
export const onUndoChange = stack.onChange;

let keysOn = false;
export function installUndoKeys() {
  if (keysOn) return;
  keysOn = true;
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.repeat) return;
    if (!document.getElementById("graph-wrap")) return;      // only while the Brain map is on screen
    if (isTypingTarget(e.target)) return;                    // Ctrl+Z belongs to the text field
    if (document.querySelector(".modal-bg")) return;         // ... and to whatever dialog is open
    const act = undoKeyAction(e);
    if (!act) return;
    e.preventDefault();
    if (act === "undo") undo(); else redo();
  });
}
