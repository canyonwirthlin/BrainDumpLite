// The Filter tab of the ribbon: node types (show / hide / rename / recolor / add), date range, minimum mentions, the two
// kinds of links with their similarity threshold, and Reset. Registered in graph/toolbar.js like every other tool; the
// edge prefs and the filter itself live in filter-edges.js, the filter pipeline in data.js.
import { toast, esc } from "../ui.js";
import { openNodeEditor } from "../nodeeditor.js";
import { RANGES, hidden, saveHidden, prefs } from "./prefs.js";
import { graphColors } from "./engine.js";
import { SIM_MIN, SIM_MAX, edgesAreDefault, resetEdgePrefs } from "./filter-edges.js";
import { registerTool, notifyToolbar } from "./toolbar.js";
import { cur, ICON, remount, sliderTool } from "./ribbon-tools.js";

const DEFAULT_MIN_MENTIONS = 2;   // the pref's default (prefs.js); Reset goes back to it

// RANGES is keyed by numbers (+ "all"), which JS iterates numerically: put "all" first, then shortest to longest.
const rangeEntries = () => Object.entries(RANGES).sort((a, b) => (a[1][1] || 0) - (b[1][1] || 0));
const rangeLabel = ([label, days]) => (days ? `${days} days` : label);

const defaultHidden = (state) => state.types.filter((t) => !t.builtin).map((t) => t.id);
export function filtersAreDefault(state) {
  const want = new Set(defaultHidden(state));
  const sameTypes = state.types.every((t) => want.has(t.id) === hidden.has(t.id));
  return sameTypes && prefs.get("range") === "all" && prefs.get("minMentions") === DEFAULT_MIN_MENTIONS && edgesAreDefault(prefs);
}

/** Back to the default node types, date range, minimum mentions and links. The map's empty state offers it as a button. */
export function resetFilters(state) {
  prefs.set("range", "all"); prefs.set("minMentions", DEFAULT_MIN_MENTIONS); resetEdgePrefs(prefs);
  hidden.clear(); defaultHidden(state).forEach((id) => hidden.add(id)); saveHidden();
  state.refresh();   // reloads types, loads item nodes if they are needed again, rebuilds the map and the ribbon
  notifyToolbar();
}

const minHint = (v) => (v <= 1 ? "Showing every concept and person." : `Hiding concepts and people mentioned in fewer than ${v} dumps.`);
const simHint = (on, v) => (!on ? "Similar links are switched off." : v <= SIM_MIN ? "Showing every similar link." : `Only links between dumps at least ${Math.round(v * 100)}% alike.`);

// ── node types ────────────────────────────────────────────────────────────────────────────────
registerTool({
  tab: "filter", id: "types", order: 0, group: "types", kind: "custom", label: "Node types",
  tip: "Click a type to show or hide it; the pencil renames or recolors it.",
  help: "Each chip is one kind of node on the map (dumps, concepts, people, tasks, ideas ...). Click a chip to hide or show that kind. The small pencil lets you rename a type or change its colour, and \"+ Type\" adds a new kind the AI will look for from your next dump on.",
  mount(el) {
    const { state } = cur, gc = graphColors(state.types);
    el.innerHTML = `<div class="gr-types">${state.types.map((t) => `
      <span class="gr-type" data-type-wrap="${esc(t.id)}"><button type="button" class="gr-chip" data-type="${esc(t.id)}" data-tip="Show or hide ${esc(t.label.toLowerCase())}"><i class="gr-dot" style="background:${esc(gc.colors[t.id] || "var(--dim)")}"></i>${esc(t.label)}</button><button type="button" class="gr-edit" data-edit="${esc(t.id)}" data-tip="Rename or recolor ${esc(t.label.toLowerCase())}" aria-label="Rename or recolor ${esc(t.label)}">${ICON.pencil}</button></span>`).join("")}
      <button type="button" class="gr-chip gr-add" id="graph-add-type" data-tip="Add a new node type">+ Type</button></div>`;
    el.querySelectorAll(".gr-chip[data-type]").forEach((b) => b.onclick = async () => { await state.toggleType(b.dataset.type); notifyToolbar(); });
    el.querySelectorAll(".gr-edit").forEach((b) => b.onclick = () => {
      const t = state.types.find((x) => x.id === b.dataset.edit);
      if (t) openNodeEditor(t, () => state.refresh());
    });
    el.querySelector("#graph-add-type").onclick = () => openNodeEditor(null, () => { toast("Node type added: the AI looks for it from the next dump on."); state.refresh(); });
    this.update(el);
  },
  update(el) {
    el.querySelectorAll(".gr-chip[data-type]").forEach((b) => {
      const off = hidden.has(b.dataset.type);
      b.setAttribute("aria-pressed", String(!off));
      b.closest(".gr-type").classList.toggle("off", off);
    });
  },
});

// ── date range, minimum mentions ──────────────────────────────────────────────────────────────
registerTool({
  tab: "filter", id: "range", order: 10, group: "when", kind: "custom", label: "Date range",
  tip: "Only show dumps from the last few days, weeks or months.",
  help: "Limits the map to dumps made recently. Notes older than the range disappear, along with the concepts and people that only they mention.",
  mount(el) {
    el.innerHTML = `<div class="gr-cap">Date range</div><div class="gr-seg" role="group" aria-label="Date range">${rangeEntries().map(([k, r]) => `<button type="button" data-range="${esc(k)}">${esc(rangeLabel(r))}</button>`).join("")}</div>`;
    el.querySelectorAll("[data-range]").forEach((b) => b.onclick = () => { prefs.set("range", b.dataset.range); cur.state.mount(); });
    this.update(el);
  },
  update(el) {
    const now = String(prefs.get("range"));
    el.querySelectorAll("[data-range]").forEach((b) => { const on = b.dataset.range === now; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  },
});
registerTool({
  tab: "filter", id: "min-mentions", order: 20, group: "when", kind: "custom",
  tip: () => minHint(prefs.get("minMentions")),
  help: "Hides concepts and people that come up in fewer dumps than this. Raise it to clear away one-off mentions and see only what keeps coming back.",
  ...sliderTool({
    id: "graph-min", label: "Min mentions", min: 1, max: 6, step: 1,
    get: () => prefs.get("minMentions"), fmt: (v) => String(v),
    set: (v) => prefs.set("minMentions", v), onInput: remount,
  }),
});

// ── links ─────────────────────────────────────────────────────────────────────────────────────
const toggleEdge = (pref) => { prefs.set(pref, !prefs.get(pref)); cur.state.mount(); };
registerTool({
  tab: "filter", id: "edge-mention", order: 30, group: "links", label: "Mention links", icon: ICON.mention, kind: "toggle",
  tip: "Solid lines from a dump to the concepts and people in it.",
  help: "Show or hide the solid lines that join each dump to the concepts and people it mentions.",
  isActive: () => !!prefs.get("edgeMention"),
  run: () => toggleEdge("edgeMention"),
});
registerTool({
  tab: "filter", id: "edge-similar", order: 31, group: "links", label: "Similar links", icon: ICON.similar, kind: "toggle",
  tip: "Dashed lines between dumps that read alike.",
  help: "Show or hide the dashed lines between dumps that are about similar things, even when they share no named concept.",
  isActive: () => !!prefs.get("edgeSimilar"),
  run: () => toggleEdge("edgeSimilar"),
});
const thr = () => Math.max(SIM_MIN, Math.min(SIM_MAX, prefs.get("edgeMinSimilar")));
registerTool({
  tab: "filter", id: "edge-threshold", order: 32, group: "links", kind: "custom",
  tip: () => simHint(!!prefs.get("edgeSimilar"), thr()),
  help: "How alike two dumps must be for a dashed similar link to show. Slide right to keep only the strongest matches. It only applies while Similar links is on.",
  ...sliderTool({
    id: "graph-edge-thr", label: "How alike", min: SIM_MIN, max: SIM_MAX, step: 0.01,
    get: thr, fmt: (v) => (v <= SIM_MIN ? "Any" : `${Math.round(v * 100)}%`),
    set: (v) => prefs.set("edgeMinSimilar", v), onInput: remount,
    disabled: () => !prefs.get("edgeSimilar"),
  }),
});

registerTool({
  tab: "filter", id: "reset-filters", order: 40, group: "reset", label: "Reset", icon: ICON.reset,
  tip: "Back to the default node types, date range, minimum mentions and links.",
  help: "Undoes every filter on this tab in one go. It is dimmed when everything is already at its default.",
  isEnabled: () => !!cur.state && !filtersAreDefault(cur.state),
  run: () => resetFilters(cur.state),
});
