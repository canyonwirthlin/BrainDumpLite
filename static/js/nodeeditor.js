// Node-type editor: create a node type, rename one, recolor one. Used from the
// Graph legend. The three base kinds (dumps/concepts/people) can be renamed and
// recolored but not deleted, only reset; item kinds (built-in or custom) also get
// an icon and an AI-matching hint, and custom ones can be deleted.
import { $, $$, esc, modal } from "./ui.js";
import { api } from "./api.js";
import { resolveHex, isHex6 } from "./color.js";

export const BASE_IDS = new Set(["dump", "concept", "person"]);

function html(t) {
  const isBase = t && BASE_IDS.has(t.id);
  const color = resolveHex(t ? t.color : "#8b7cf6");
  return `
    <h2>${t ? `Edit "${esc(t.label)}"` : "New node type"}</h2>
    <div class="field"><label for="ne-label">Label</label>
      <input id="ne-label" maxlength="30" value="${t ? esc(t.label) : ""}" placeholder="e.g. Question" autofocus></div>
    ${!isBase ? `<div class="field"><label for="ne-icon">Icon (optional)</label>
      <input id="ne-icon" maxlength="4" value="${t ? esc(t.icon || "") : ""}" placeholder="💡"></div>` : ""}
    <div class="field"><label>Color</label>
      <div class="te-color"><input type="color" id="ne-color" value="${color}">
        <input type="text" id="ne-hex" class="te-hex" maxlength="7" value="${color}" spellcheck="false"></div></div>
    ${!isBase ? `<div class="field"><label for="ne-hint">Rule for the AI (optional)</label>
      <input id="ne-hint" maxlength="200" value="${t ? esc(t.hint || "") : ""}" placeholder="How to recognise it in a dump"></div>` : ""}
    <div class="row" style="margin-top:14px">
      <button class="btn" id="ne-save">${t ? "Save" : "Add node type"}</button>
      <button class="btn ghost" id="ne-cancel">Cancel</button>
      ${isBase ? `<button class="btn ghost small" id="ne-reset">Reset to default</button>` : ""}
      ${t && !isBase && !t.builtin ? `<button class="btn danger small" id="ne-delete">Delete</button>` : ""}
    </div>
    <p class="small bad" id="ne-msg" style="margin-top:8px"></p>`;
}

// t: the node type to edit, or null to create a new one. onDone(): called after any change.
export function openNodeEditor(t, onDone) {
  const isBase = t && BASE_IDS.has(t.id);
  const { el, close } = modal(html(t));
  const msg = (m) => { $("#ne-msg", el).textContent = m || ""; };
  const syncColor = (hex) => { $("#ne-color", el).value = hex; $("#ne-hex", el).value = hex; };
  $("#ne-color", el).oninput = (e) => syncColor(e.target.value);
  $("#ne-hex", el).oninput = (e) => {
    const v = e.target.value.trim().startsWith("#") ? e.target.value.trim() : "#" + e.target.value.trim();
    e.target.classList.toggle("bad", !isHex6(v));
    if (isHex6(v)) $("#ne-color", el).value = v;
  };
  $("#ne-cancel", el).onclick = close;
  if ($("#ne-reset", el)) $("#ne-reset", el).onclick = async () => {
    try { await api.del(`/graph/types/${t.id}`); close(); onDone(); } catch (e) { msg(e.message); }
  };
  if ($("#ne-delete", el)) $("#ne-delete", el).onclick = async () => {
    if (!confirm(`Delete "${t.label}"? Existing items of this type become notes.`)) return;
    try { await api.del(`/item-types/${t.id}`); close(); onDone(); } catch (e) { msg(e.message); }
  };
  $("#ne-save", el).onclick = async () => {
    const label = $("#ne-label", el).value.trim();
    if (!label) { msg("Give it a name."); $("#ne-label", el).focus(); return; }
    const hex = $("#ne-hex", el).value.trim();
    if (!isHex6(hex)) { msg("Fix the color first (use #rrggbb)."); return; }
    const rest = isBase ? {} : { icon: $("#ne-icon", el).value.trim(), hint: $("#ne-hint", el).value.trim() };
    try {
      if (!t) await api.post("/item-types", { label, color: hex, ...rest });
      else if (isBase) await api.put(`/graph/types/${t.id}`, { label, color: hex });
      else await api.put(`/item-types/${t.id}`, { label, color: hex, ...rest });
      close(); onDone();
    } catch (e) { msg(e.message); }
  };
}
