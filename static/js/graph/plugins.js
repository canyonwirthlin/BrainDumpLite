// The plugin manifest for the Brain map: one side-effect import per feature module.
// Each module registers itself (LAYOUTS.push / registerOverlay / registerFilter / registerTool / infoSections.push /
// onGraphReady) when imported. Order of imports = order of registration = order shown in the UI.
// Not listed here on purpose: the modules these import (engine, data, prefs, find, path, timelapse*, infobox ...) are
// pulled in by views/graph.js or by the modules below. Index of every file: docs/graph-architecture.md.
//
// Layout modules (static/js/graph/layout-<name>.js)
import "./layout-ego.js";
import "./layout-lanes.js";
import "./layout-islands.js";
import "./layout-concepts.js";
import "./layout-matrix.js";

// Overlay modules (static/js/graph/overlay-<name>.js)
import "./overlay-hulls.js";
// Insight overlays (order = precedence when several are on: later wins ring/glow/badge, see overlay-common.js)
import "./overlay-bridges.js";
import "./overlay-trends.js";
import "./overlay-lonely.js";
import "./overlay-loops.js";
import "./overlay-links.js";

// Data filters (static/js/graph/filter-<name>.js)
import "./filter-edges.js";

// Everything that subscribes to the event bus: keyboard navigation, hover card, export ...
import "./keyboard.js";
import "./info-sparkline.js";
import "./drag-merge.js";
import "./hovercard.js";
import "./export.js";

// Toolbar features. Contract: toolbar.js (registerTool, modes), undo.js (pushUndo).
import "./ribbon.js";          // draws the tabbed ribbon from the tool registry
import "./blueprint.js";       // Link mode (wires between notes)
import "./edit-tools.js";      // Undo / Redo buttons + keys
