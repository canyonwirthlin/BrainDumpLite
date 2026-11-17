// The tutorial's script: one entry per card, in order. PURE DATA (no imports, no DOM) so tests can load it under Node.
//
//   id        unique; tour-scenes.js / tour-graph.js / tour-templates.js each export a scene with the same id
//   screen    the rail icon this card belongs to (SCREENS below; Back/Next walk the cards, a rail click jumps to the first card of a screen)
//   title / blurb / tip   plain English, short, one idea per card
//   mirrors   what the mock copies from the REAL app. tests/test_tour.py checks every entry against the real code,
//             so a rename or removal there fails the build instead of silently teaching the wrong thing:
//               route      hash route the card teaches (must be registered in main.js)
//               files      real source files that render the screen (relative to the repo root)
//               ids / classes   DOM ids / class names the mock imitates (must appear in those files)
//               labels     exact button / tab / heading texts the card names (must appear in those files)
//               tabs       Brain map ribbon tab ids;  tools: { toolId: "Label" } registered ribbon tools and their labels
//               settings   Settings sections;  templates: built-in template ids;  keys: shortcuts the card names
//               modes      capture modes
//
// When the app changes, update the step here and the mock beside it: docs/TUTORIAL-CHECKLIST.md says how.

export const SCREENS = ["capture", "graph", "search", "ask", "history", "tasks", "reflect", "stats", "settings"];

export const STEPS = [
  // ── Capture ──────────────────────────────────────────────────────────────────────────────────
  { id: "capture", screen: "capture",
    title: "Capture: get it all out",
    blurb: "This is where every thought starts. Pick a mode, then type or talk. Each mode is a different kind of place.",
    tip: "Click each mode to see how it changes, then press the button for a demo.",
    mirrors: { route: "capture", files: ["static/js/views/capture.js", "static/js/ui.js"], ids: ["dump-text", "cap-body", "mode-info"], classes: ["mode-chip", "chatbox", "tasklist"],
      modes: ["freeform", "brainstorm", "therapy", "execution"], labels: ["Dump it →", "Start talking →"] } },
  { id: "capture-templates", screen: "capture",
    title: "Templates: start from a shape",
    blurb: "Staring at a blank box? Click a template button under it. It fills the box with a few prompts, and you just answer them.",
    tip: "Click Morning. Then open Templates, type a word to search, and click a star to pin one.",
    mirrors: { route: "capture", files: ["static/js/templates-ui.js", "static/js/views/capture.js"], ids: ["tpl-row"], classes: ["tpl-btn", "tpl-more", "tpl-pop", "tp-search", "tp-star", "tp-row"],
      templates: ["morning", "shutdown", "meeting", "worry"], labels: ["Templates ▾", "Manage templates…"] } },
  { id: "capture-manage", screen: "capture",
    title: "Make templates your own",
    blurb: "Open Templates, then Manage templates (also in Settings, Templates). Pin favourites, edit the wording, delete what you never use, or write your own.",
    tip: "Click a star to pin, use the arrows to reorder, pick one to edit, or add a new one.",
    mirrors: { route: "settings/templates", files: ["static/js/templates-ui.js"], classes: ["tm-list", "tm-item", "tm-pin", "tm-editor", "tm-up", "tm-down"],
      settings: ["templates"], labels: ["+ New template", "Restore deleted built-ins", "Duplicate", "Delete"] } },
  { id: "capture-extras", screen: "capture",
    title: "Three small extras",
    blurb: "Under the writing box: a mic to talk instead of type, a Private switch, and a promise that short notes stay yours.",
    tip: "Click the mic and the Private switch.",
    mirrors: { route: "capture", files: ["static/js/views/capture.js"], ids: ["mic", "dump-private", "rec-status"], labels: ["Private", "Record voice"], settings: ["voice"] } },
  { id: "capture-shortcuts", screen: "capture",
    title: "Shortcuts worth knowing",
    blurb: "Four keys that save the most clicks. The last one works from any program, even when this window is hidden in the tray.",
    tip: "Try Ctrl+K in the real app.",
    mirrors: { route: "capture", files: ["static/js/views/capture.js", "static/js/shell.js", "static/js/palette.js", "src-tauri/src/quick.rs"],
      keys: ["Ctrl+Enter", "Ctrl+N", "Ctrl+K", "Ctrl+Shift+Space"], settings: ["data"] } },

  // ── Brain map ────────────────────────────────────────────────────────────────────────────────
  { id: "graph", screen: "graph",
    title: "Graph: see how your thoughts connect",
    blurb: "The Graph tab opens your Brain map. Every dump, concept and person is a dot. Dots that share a topic or a person sit close together.",
    tip: "Hover a dot for a preview. Click one to select it. Drag one to move it.",
    mirrors: { route: "graph", files: ["static/js/graph/ribbon.js", "static/js/graph/hovercard.js", "static/js/graph/infobox.js"], tabs: ["view"], classes: ["gr-top", "gr-tab", "bdl-hc"],
      tools: { find: "Find a node", fit: "Fit", focus: "Focus" } } },
  { id: "graph-ribbon", screen: "graph",
    title: "The ribbon: every tool in six tabs",
    blurb: "The bar above the map has six tabs: View, Layout, Overlays, Filter, Edit and Tools. Hover a button for a one-line tip. Not sure what a tab does? Press the round ? at its right end.",
    tip: "Click through the tabs, hover a button, then press the ?",
    mirrors: { route: "graph", files: ["static/js/graph/ribbon.js", "static/js/graph/toolbar.js"], tabs: ["view", "layout", "overlays", "filter", "edit", "tools"], classes: ["gr-help-btn", "gr-help", "gr-tip", "gr-btn"],
      tools: { "layout:organic": "Organic", path: "Path", timelapse: "Time-lapse", export: "Export" } } },
  { id: "graph-link", screen: "graph",
    title: "Link mode: connect two things yourself",
    blurb: "Edit tab, then Link. Drag from one dot to another and let go: a bright wire joins them. Click a wire and press Delete to remove it. Esc leaves Link mode.",
    tip: "Press Link, then drag from one dot onto another. Click your wire and press Delete. Ctrl+Z brings it back.",
    mirrors: { route: "graph", files: ["static/js/graph/blueprint.js", "static/js/graph/edit-tools.js"], tabs: ["edit"], classes: ["bdl-bp-hint"], keys: ["Ctrl+Z"],
      tools: { link: "Link", select: "Select", undo: "Undo", redo: "Redo" } } },
  { id: "graph-merge", screen: "graph",
    title: "Merge mode: one name, not two",
    blurb: "Edit tab, then Merge. Drag a dot onto another of the same kind (concept on concept, person on person, note on note) and they become one. There is no “Are you sure?”, so Undo or Ctrl+Z is your safety net.",
    tip: "Press Merge and drag “internships” onto “Internship”. Then press Ctrl+Z.",
    mirrors: { route: "graph", files: ["static/js/graph/drag-merge.js", "static/js/graph/merge-rules.js", "static/js/graph/edit-tools.js"], tabs: ["edit"], keys: ["Ctrl+Z", "Ctrl+Shift+Z"],
      tools: { merge: "Merge", undo: "Undo", redo: "Redo" } } },

  // ── Search ───────────────────────────────────────────────────────────────────────────────────
  { id: "search", screen: "search",
    title: "Search: find it by words or meaning",
    blurb: "Type a few words. Search looks through every dump and task, forgives typos and word endings, and finds people and topics by name. With AI on it also matches by meaning.",
    tip: "Type “internship”, “dentist” or “garden”. Press Save search to keep one.",
    mirrors: { route: "search", files: ["static/js/views/search.js"], ids: ["q", "go"], labels: ["Search", "☆ Save search"] } },
  { id: "search-browse", screen: "search",
    title: "Browse: everything of one kind",
    blurb: "On the left of Search, Browse lists People, Concepts and each kind of item with a count. Pick one to see every entry and how often it shows up. A warning badge means likely duplicates you can tidy.",
    tip: "Click People, then Concepts.",
    mirrors: { route: "search", files: ["static/js/views/search.js"], ids: ["browse-types"], classes: ["glist", "grow-row", "count"], labels: ["Browse"] } },

  // ── Ask ──────────────────────────────────────────────────────────────────────────────────────
  { id: "ask", screen: "ask",
    title: "Ask: questions answered from your dumps",
    blurb: "Type a question in plain words. The answer comes only from your own dumps, with numbered sources you can click. It needs AI turned on.",
    tip: "Press Ask to see a sample answer.",
    mirrors: { route: "ask", files: ["static/js/views/ask.js"], ids: ["ask-q", "ask-go", "ask-log"], classes: ["cite"], labels: ["Ask your brain", "Ask", "Sources"] } },

  // ── History ──────────────────────────────────────────────────────────────────────────────────
  { id: "history", screen: "history",
    title: "History: everything you've dumped",
    blurb: "Every dump, newest first. Filter by mode, or type in the box at the top. Open one to see its cleaned-up text, key points, the items the AI pulled out, and its concepts and people. All of it is editable.",
    tip: "Click a dump, then try ✎ on the title or an item, ✓ or ✕ on an item, or × on a tag.",
    mirrors: { route: "history", files: ["static/js/views/history.js", "static/js/views/review.js", "static/js/dumpedit.js"], ids: ["hist-q", "hist-list", "hist-detail", "hist-chips"], classes: ["drow", "transcript"], labels: ["Cleaned transcript", "Extracted items", "Concepts & people"] } },
  { id: "history-manage", screen: "history",
    title: "Tidy up a dump",
    blurb: "Above an open dump: Pin keeps it on top, Make private hides it from Search and Ask, Split cuts it in two, and Merge with joins two dumps. Delete moves it to Trash, kept for 30 days.",
    tip: "Click each button to see what it does.",
    mirrors: { route: "history", files: ["static/js/dumpedit.js", "static/js/views/history.js"], ids: ["pin-dump", "private-dump", "split-dump", "merge-dump", "trash-chip"], labels: ["Split…", "Merge with…", "Trash"] } },

  // ── Tasks ────────────────────────────────────────────────────────────────────────────────────
  { id: "tasks", screen: "tasks",
    title: "Tasks: everything you've committed to",
    blurb: "Tasks are things you can finish. All shows what is still open; the tabs below it slice by due date. Ongoing aims and loose ideas wait under Not tasks, so they don't clutter the list.",
    tip: "Switch tabs, then tick a task to finish it.",
    mirrors: { route: "tasks", files: ["static/js/views/tasks.js"], ids: ["task-groups", "task-list", "add-task"], classes: ["task-row", "glist-sep"],
      labels: ["All", "Overdue", "Today", "Upcoming", "Someday", "Snoozed", "Done", "Goals", "Ideas", "Habits", "Not tasks"] } },
  { id: "tasks-more", screen: "tasks",
    title: "Too much? Shrink the list",
    blurb: "Not today? Press the 💤 button to hide a task until a day you pick. Press Just one thing to see only your next task. I have 10 minutes shows what fits in a gap.",
    tip: "Press 💤 on a task, then press Just one thing.",
    mirrors: { route: "tasks", files: ["static/js/views/tasks.js", "static/js/views/focus.js", "static/js/views/jot.js", "static/js/views/snooze.js"], ids: ["jot-open", "fit-open"], classes: ["snz"], labels: ["Just one thing", "I have 10 minutes", "Reschedule ▾"] } },

  // ── Reflect, Statistics, Settings ────────────────────────────────────────────────────────────
  { id: "reflect", screen: "reflect",
    title: "Reflect: a look back",
    blurb: "Still being built (that is the little warning mark on its tab). Reflect gives you This week at a glance, a short Week in words, Plan my day, and a Today summary.",
    tip: "Press Write it for a sample week in words.",
    mirrors: { route: "reflect", files: ["static/js/views/reflect.js"], labels: ["Plan my day", "Week in words", "Work in progress", "Write it", "This week"] } },
  { id: "stats", screen: "stats",
    title: "Statistics: your streak and totals",
    blurb: "Dump once a day to keep the streak alive. Miss a whole day and it resets. Below the flame: longest streak, days dumped, words dumped, and where your AI calls go.",
    tip: "Switch between 7, 30 and 90 days.",
    mirrors: { route: "stats", files: ["static/js/views/stats.js"], classes: ["streak-hero", "tile", "tiles"], labels: ["longest streak", "days dumped", "Words dumped", "Model activity"] } },
  { id: "settings", screen: "settings",
    title: "Settings: make it yours",
    blurb: "Eight sections down the left. Want this tutorial again? It lives in About, under Replay tutorial.",
    tip: "Click a section to see what is inside.",
    mirrors: { route: "settings", files: ["static/js/views/settings.js"], settings: ["appearance", "templates", "ai", "voice", "data", "integrations", "extend", "about"], labels: ["Replay tutorial"] } },
];

/** The first card of a screen (what a rail click jumps to). */
export const firstStepOf = (screen) => STEPS.findIndex((s) => s.screen === screen);
