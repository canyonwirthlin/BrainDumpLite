// The plugin manifest for the Brain map: one side-effect import per feature module.
// Each module registers itself (LAYOUTS.push / registerOverlay / registerFilter / infoSections.push / onGraphReady)
// when imported. Add YOUR import on YOUR reserved line below (uncomment it) so parallel branches never touch the
// same line. Order of imports = order of registration = order shown in the UI.
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


// Info-box sections (static/js/graph/info-<name>.js)
// import "./info-extra.js";


// Everything that subscribes to the event bus: keyboard navigation, hover card, export ...
import "./keyboard.js";
import "./info-sparkline.js";
import "./drag-merge.js";

import "./hovercard.js";

import "./export.js";
