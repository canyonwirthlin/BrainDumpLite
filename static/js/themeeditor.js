// Theme editor (Settings -> Appearance): pick every color, name the theme, save it.
// Edits preview live across the whole app and are discarded on Cancel or navigation.
import { $, $$, esc, toast } from "./ui.js";
import { preview, endPreview, saveTheme, softFrom } from "./theme.js";
import { toHex, contrast, isHex6 } from "./color.js";

const GROUPS = [
  ["Surfaces", [["bg", "Background", "The app background"], ["rail", "Sidebar", "The left rail"], ["panel", "Cards", "Cards and panels"],
                ["panel2", "Raised", "Inputs, chips, hovered rows"], ["line", "Borders", "Dividers and outlines"]]],
  ["Text", [["text", "Text", "Main text"], ["dim", "Muted text", "Secondary text and labels"]]],
  ["Accents", [["accent", "Accent", "Buttons, links, highlights"], ["accent2", "Second accent", "Gradients and secondary highlights"]]],
  ["Status", [["green", "Success", "Done and on-device"], ["red", "Danger", "Errors and delete"], ["amber", "Warning", "Due soon and cautions"]]],
];

// base: the theme to start from. editingId: a custom theme's id to update in place, or null to save as new.
export function openThemeEditor(box, { base, editingId, onDone }) {
  const draft = {
    name: editingId ? base.name : `${base.name} copy`,
    scheme: base.scheme,
    radius: base.radius || 12,
    colors: Object.fromEntries(Object.entries(base.colors).map(([k, v]) => [k, k === "accentSoft" ? v : toHex(v)])),
  };
  const original = JSON.parse(JSON.stringify(draft));
  const full = () => ({ ...draft, id: editingId || "preview", colors: { ...draft.colors, accentSoft: softFrom(draft.colors.accent, draft.scheme) } });

  const field = ([k, label, help]) => `
    <div class="te-color" title="${esc(help)}">
      <input type="color" data-k="${k}" value="${draft.colors[k]}" aria-label="${esc(label)} color">
      <span class="te-label">${esc(label)}</span>
      <input type="text" class="te-hex" data-k="${k}" value="${draft.colors[k]}" maxlength="7" spellcheck="false" aria-label="${esc(label)} hex">
    </div>`;

  box.innerHTML = `
    <div class="theme-editor">
      <div class="field"><label for="te-name">Theme name</label>
        <input type="text" id="te-name" maxlength="40" value="${esc(draft.name)}" placeholder="e.g. Sunset"></div>
      <div class="te-row">
        <div class="field"><label for="te-scheme">Base</label>
          <select id="te-scheme"><option value="dark" ${draft.scheme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${draft.scheme === "light" ? "selected" : ""}>Light</option></select></div>
        <div class="field grow"><label for="te-radius">Corner roundness <b id="te-rad-val">${draft.radius}px</b></label>
          <input type="range" id="te-radius" min="6" max="20" step="1" value="${draft.radius}"></div>
      </div>
      ${GROUPS.map(([g, keys]) => `<div class="sec">${g}</div><div class="te-grid">${keys.map(field).join("")}</div>`).join("")}
      <div class="small te-contrast" id="te-contrast" role="status"></div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="te-save">${editingId ? "Save changes" : "Save theme"}</button>
        <button class="btn ghost" id="te-cancel">Cancel</button>
        <button class="btn ghost small" id="te-reset" title="Undo every change made in this editor">Reset</button>
        <span class="small bad" id="te-msg"></span>
      </div>
      <p class="small muted" style="margin-top:10px">The whole app previews your changes live. Nothing is kept until you save.</p>
    </div>`;

  const msg = (t) => { $("#te-msg", box).textContent = t || ""; };
  const refresh = () => {
    preview(full());
    const warns = [];
    const c1 = contrast(draft.colors.text, draft.colors.bg), c2 = contrast(draft.colors.text, draft.colors.panel), c3 = contrast(draft.colors.dim, draft.colors.panel);
    if (Math.min(c1, c2) < 4.5) warns.push(`Text is hard to read against your background or cards (${Math.min(c1, c2).toFixed(1)}:1; aim for 4.5 or more).`);
    else if (c3 < 3) warns.push(`Muted text is faint on cards (${c3.toFixed(1)}:1).`);
    if (contrast(draft.colors.accent, draft.colors.bg) < 3) warns.push("The accent is hard to see against the background.");
    $("#te-contrast", box).innerHTML = warns.length ? `⚠ ${warns.map(esc).join(" ")}` : "";
  };
  const setColor = (k, hex) => {
    draft.colors[k] = hex.toLowerCase();
    $(`input[type=color][data-k="${k}"]`, box).value = draft.colors[k];
    $(`.te-hex[data-k="${k}"]`, box).value = draft.colors[k];
    refresh();
  };

  $$("input[type=color]", box).forEach((el) => el.oninput = () => { $(`.te-hex[data-k="${el.dataset.k}"]`, box).classList.remove("bad"); setColor(el.dataset.k, el.value); });
  $$(".te-hex", box).forEach((el) => el.oninput = () => {
    const v = el.value.trim().startsWith("#") ? el.value.trim() : "#" + el.value.trim();
    el.classList.toggle("bad", !isHex6(v));
    if (isHex6(v)) setColor(el.dataset.k, v);
  });
  $("#te-name", box).oninput = (e) => { draft.name = e.target.value; };
  $("#te-scheme", box).onchange = (e) => { draft.scheme = e.target.value; refresh(); };
  $("#te-radius", box).oninput = (e) => { draft.radius = +e.target.value; $("#te-rad-val", box).textContent = draft.radius + "px"; refresh(); };
  $("#te-reset", box).onclick = () => {
    Object.assign(draft, JSON.parse(JSON.stringify(original)));
    $("#te-name", box).value = draft.name; $("#te-scheme", box).value = draft.scheme;
    $("#te-radius", box).value = draft.radius; $("#te-rad-val", box).textContent = draft.radius + "px";
    for (const [, keys] of GROUPS) for (const [k] of keys) setColor(k, draft.colors[k]);
  };
  $("#te-cancel", box).onclick = () => { endPreview(); onDone(null); };
  $("#te-save", box).onclick = async () => {
    if (!draft.name.trim()) { msg("Give your theme a name."); $("#te-name", box).focus(); return; }
    if ($$(".te-hex.bad", box).length) { msg("Fix the highlighted colors first (use #rrggbb)."); return; }
    try {
      const saved = await saveTheme({ ...full(), name: draft.name.trim() }, editingId);
      toast(`Saved "${saved.name}"`);
      onDone(saved);
    } catch (e) { msg(e.message); }
  };
  refresh();
  $("#te-name", box).focus();
  $("#te-name", box).select();
}
