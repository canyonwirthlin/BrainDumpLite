// The built-in ribbon tools, registered in graph/toolbar.js so the ribbon (ribbon.js) can draw them:
//   View      Find, Fit, Focus, Hover titles, Spacing, Size by mentions, Names shown
//   Layout    one tool per entry of LAYOUTS (layouts.js)
//   Overlays  one tool per entry of OVERLAYS (overlays.js), grouped by the overlay's `group`
//   Edit      the Select mode (graph-blueprint adds Link, graph-undo adds Merge / Undo / Redo)
//   Tools     Path, Time-lapse, Export slot, Keyboard shortcuts slot
// The Filter tab is in ribbon-filters.js. Tools are registered once per page load, but they act on the map of the CURRENT
// visit: panel.js calls bindToolContext(api, state) on every visit and the tools read `cur`.
import { prefs } from "./prefs.js";
import { LAYOUTS, layoutId } from "./layouts.js";
import { OVERLAYS } from "./overlays.js";
import { registerTool, TOOLS, notifyToolbar } from "./toolbar.js";
import { firstSentence } from "./ribbon-model.js";
import { bindFind } from "./find.js";
import { isPathMode, togglePath } from "./path.js";

/** The map of the visit on screen: { api, state }. Set by bindToolContext(). */
export const cur = { api: null, state: null };

/** Point the tools at this visit's map and keep the ribbon in step with things other modules can change. */
export function bindToolContext(api, state) {
  cur.api = api; cur.state = state;
  const poke = () => notifyToolbar();
  api.on("click", poke);          // a click can end Path mode's half-made path, select a node (Export's selection entry) ...
  api.on("keydown", poke);        // P and H toggle Path and Focus from the keyboard
  api.on("overlaysChanged", poke);
  api.on("nodesChanged", poke);
  api.timelapse?.onChange(poke);
}
// Every pref change (spacing, range, Focus ...) refreshes the ribbon; a ribbon that is not on screen ignores it.
prefs.onChange(() => notifyToolbar());

// ── icons (24x24 line icons, drawn at 18px; layouts and overlays bring their own emoji) ─────────
const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  select: svg('<path d="M5 3.5 18.5 10l-5.8 1.9L10.6 18z"/>'),
  fit: svg('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
  focus: svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2.5 3"/>'),
  titles: svg('<path d="M5 7V5h14v2M12 5v14M9 19h6"/>'),
  spacing: svg('<path d="M4 6v12M20 6v12M8 12h8M10.5 9.5 8 12l2.5 2.5M13.5 9.5 16 12l-2.5 2.5"/>'),
  path: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17c6 0 2-10 8-10"/>'),
  play: svg('<path d="M8 5.5v13l11-6.5z"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  mention: svg('<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8.2 12h7.6"/>'),
  similar: svg('<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8.2 12h1.6M11.2 12h1.6M14.2 12h1.6"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
};

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const remount = debounce(() => cur.state && cur.state.mount(), 110);

/** A compact labelled slider as a custom tool body. get/set talk to a pref; fmt makes the value text. */
export function sliderTool({ id, label, min, max, step, get, set, fmt, disabled = () => false, onInput }) {
  const fill = (el) => el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min) * 100).toFixed(1) + "%");
  return {
    label,
    mount(el) {
      el.innerHTML = `<div class="gr-slider"><div class="gr-slider-top"><label for="${id}">${label}</label><output for="${id}"></output></div>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}"></div>`;
      const input = el.querySelector("input");
      input.value = get();
      input.oninput = () => { const v = parseFloat(input.value); set(v); onInput && onInput(v); fill(input); el.querySelector("output").textContent = fmt(v); };
      this.update(el);
    },
    update(el) {
      const input = el.querySelector("input"), off = !!disabled();
      if (document.activeElement !== input || input.disabled !== off) input.value = get();
      input.disabled = off;
      el.classList.toggle("is-off", off);
      el.querySelector("output").textContent = fmt(parseFloat(input.value));
      fill(input);
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────────────────────
registerTool({
  tab: "view", id: "find", order: 0, group: "find", kind: "custom", label: "Find a node", key: "/",
  tip: "Type a name to jump to a note, idea or person on the map.",
  help: "Start typing and pick a match: the map centres on it and dims everything else. If a match is hidden by your filters, widen the date range or lower the minimum mentions.",
  mount(el) {
    el.innerHTML = `<div class="gr-find"><span class="gr-find-ico" aria-hidden="true">${ICON.search}</span><input type="search" id="graph-find" placeholder="Find a node…" autocomplete="off" aria-label="Find a node"><div id="graph-find-list" class="graph-find-list" style="display:none"></div></div>`;
    bindFind(cur.state);
  },
});
registerTool({
  tab: "view", id: "fit", order: 10, group: "camera", label: "Fit", icon: ICON.fit, key: "F",
  tip: "Zoom and move the map so everything fits on screen.",
  help: "Brings the whole map back into view after you have zoomed in or dragged it away.",
  run: () => cur.api.fit(),
});
registerTool({
  tab: "view", id: "focus", order: 20, group: "camera", label: "Focus", icon: ICON.focus, kind: "toggle", key: "H",
  tip: "Dim everything more than two steps away from the selected note.",
  help: "Select a note, then turn Focus on to fade out everything except the note and what is close to it. Handy in a crowded map.",
  isActive: () => !!prefs.get("focus"),
  run: () => cur.state.setFocus(!prefs.get("focus")),
});
registerTool({
  tab: "view", id: "hover-titles", order: 30, group: "look", label: "Hover titles", icon: ICON.titles, kind: "toggle",
  tip: "Show a note's title only while the pointer is over it.",
  help: "Normally the busiest notes show a title, and more of them as you zoom in. Turn this on for a cleaner map and read titles by hovering.",
  isActive: () => !!prefs.get("hoverTitles"),
  run() { prefs.set("hoverTitles", !prefs.get("hoverTitles")); cur.api.requestDraw(); },
});
registerTool({
  tab: "view", id: "spacing", order: 40, group: "look", kind: "custom",
  tip: "How far apart the notes sit.",
  help: "Slide right to spread the notes out, left to pack them closer together.",
  ...sliderTool({
    id: "graph-spacing", label: "Spacing", min: 0.5, max: 3, step: 0.05,
    get: () => prefs.get("spacing"), fmt: (v) => v.toFixed(1) + "×",
    set: (v) => prefs.set("spacing", v), onInput: () => cur.api.reheat({ keepView: true }),
  }),
});
registerTool({
  tab: "view", id: "size-mentions", order: 50, group: "highlight", label: "Size by mentions", icon: ICON.mention, kind: "toggle",
  tip: "Make ideas and people bigger the more dumps mention them.",
  help: "On: the more of your dumps mention an idea or person, the bigger its dot, so your busiest topics stand out at a glance. Off: every idea and person is about the same size.",
  isActive: () => !!prefs.get("sizeByMentions"),
  run() { prefs.set("sizeByMentions", !prefs.get("sizeByMentions")); remount(); },
});
registerTool({
  tab: "view", id: "top-labels", order: 60, group: "highlight", kind: "custom",
  tip: "How many of the most-mentioned ideas and people always show their name.",
  help: "The busiest ideas and people keep their name on screen however far you zoom out. Slide to 0 for no always-on names (names then appear as you zoom in or hover).",
  ...sliderTool({
    id: "graph-top-labels", label: "Names shown", min: 0, max: 40, step: 1,
    get: () => prefs.get("topLabels"), fmt: (v) => (v ? "top " + v : "off"),
    set: (v) => prefs.set("topLabels", v), onInput: () => cur.api.requestDraw(),
  }),
});

// ── Edit ──────────────────────────────────────────────────────────────────────────────────────
registerTool({
  tab: "edit", id: "select", order: 0, group: "mode", kind: "mode", label: "Select", icon: ICON.select,
  tip: "Select and move notes.",
  help: "The normal tool: click a note to look at it, drag it to move it (it stays where you drop it), double-click to let it float again. Pick Select again whenever another tool in this tab is active and you want the ordinary behaviour back.",
});

// ── Tools ─────────────────────────────────────────────────────────────────────────────────────
registerTool({
  tab: "tools", id: "path", order: 0, group: "explore", label: "Path", icon: ICON.path, kind: "toggle", key: "P",
  tip: "Click two notes to see how they connect through your dumps.",
  help: "Turn it on, click one note, then another. The shortest chain of connections lights up and the steps are listed. Click anywhere empty to start over.",
  isActive: () => isPathMode(),
  run: () => { togglePath(cur.api); },
});
registerTool({
  tab: "tools", id: "timelapse", order: 10, group: "explore", domId: "graph-tl-btn", kind: "toggle",
  label: () => (cur.api?.timelapse?.active ? "Stop" : "Time-lapse"),
  icon: () => (cur.api?.timelapse?.active ? ICON.stop : ICON.play),
  tip: "Watch your map grow, dump by dump.",
  help: "Replays your notes in the order you wrote them, with play, pause and a scrubber along the bottom of the map. You can also record it as a video.",
  isActive: () => !!cur.api?.timelapse?.active,
  isEnabled: () => !!cur.api?.timelapse,
  run: () => cur.api.timelapse.toggle(),
});
registerTool({
  tab: "tools", id: "export", order: 20, group: "share", kind: "custom", label: "Export",
  tip: "Save the map as an image, a vector file or an Obsidian canvas.",
  help: "Opens a menu: a PNG picture (optionally with a transparent background), an SVG that stays sharp at any size, or an Obsidian canvas file. It saves what the map shows right now.",
  mount(el) { el.innerHTML = `<div id="graph-slot-export" class="gr-slot"></div>`; },   // export.js fills it on bdl-graph-panel-rendered
});
registerTool({
  tab: "tools", id: "keys", order: 30, group: "share", kind: "custom", label: "Keyboard shortcuts", key: "?",
  tip: "Show every keyboard shortcut for the map.",
  help: "Opens a cheat sheet over the map: arrow keys to move between connected notes, F to fit, P for Path, H for Focus, / to find, and more. A small ? button on the map opens it too.",
  mount(el) { el.innerHTML = `<div id="graph-slot-keys" class="gr-slot"></div>`; },       // keyboard.js fills it on bdl-graph-panel-rendered
});

// ── Layout and Overlays: one tool per registry entry ───────────────────────────────────────────
function chooseLayout(id) {
  if (id === layoutId(prefs.get("layout"))) return;
  prefs.set("layout", id);
  cur.state.mount();
}

/** Register a tool for every layout and overlay that exists and has none yet. Safe to call as often as you like. */
export function syncRegistryTools() {
  const have = new Set(TOOLS.map((t) => t.id));
  LAYOUTS.forEach((l, i) => {
    const id = "layout:" + l.id;
    if (have.has(id)) return;
    registerTool({
      tab: "layout", id, order: 10 + i, label: l.label, icon: l.icon || "◇", kind: "toggle",
      tip: firstSentence(l.desc) || `Arrange the map as "${l.label}".`,
      help: l.desc || `Arrange the map as "${l.label}".`,
      isActive: () => layoutId(prefs.get("layout")) === l.id,
      run: () => chooseLayout(l.id),
    });
  });
  const ranks = new Map([["", 0]]);   // ungrouped overlays first, then each group in the order it first appears
  OVERLAYS.forEach((o, i) => {
    const id = "overlay:" + o.id, g = o.group || "";
    if (!ranks.has(g)) ranks.set(g, ranks.size);
    if (have.has(id)) return;
    registerTool({
      tab: "overlays", id, order: ranks.get(g) * 1000 + i, group: g, label: o.label, icon: o.icon || "◇", kind: "toggle",
      tip: firstSentence(o.desc) || `Show or hide "${o.label}".`,
      help: o.desc || `Show or hide "${o.label}".`,
      isActive: () => !!cur.api?.overlays.isActive(o.id),
      run: () => cur.api.overlays.setActive(o.id, !cur.api.overlays.isActive(o.id)),
    });
  });
}
syncRegistryTools();
