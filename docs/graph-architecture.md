# Brain map architecture

The Brain map (`#graph`) is a canvas force graph with no libraries and no build step. It lives in
`static/js/graph/` as ES modules; `static/js/views/graph.js` is only the router entry. Everything below is
the contract parallel feature work builds on. Read `docs/CODEMAP.md` for the rest of the app.

## Testing your work

All commands run from your worktree root. Worktrees have no `.venv`, so use the main checkout's interpreter.
Pick YOUR port (never 8756-8780 outside your own assignment, never 8790/8820) and a throwaway data dir.
`.data/` is git-ignored. **Never point any of this at the real vault**: the scripts refuse to run without an
explicit data dir.

```powershell
$py = "C:\Users\canyo\Desktop\Home\Coding\BrainDumpLite\.venv\Scripts\python.exe"
$port = 8761                                   # your assigned port
# 1. serve a seeded sandbox vault (seeds on first run, foreground; use Start-Process / run_in_background)
& $py scripts/graph_serve.py --data "$PWD\.data" --port $port --dumps 140
#    bigger: --dumps 2500        re-seed: --force-seed        just seed: see below
# 2. screenshot + drive it (second terminal)
node scripts/graph_shot.mjs --url http://127.0.0.1:$port/#graph --width 1500 --height 900 --wait 2500 --out shot.png
```

Seed without serving (refuses without `BRAINDUMP_LITE_DATA`, refuses a vault that already has dumps unless `--force`):

```powershell
$env:BRAINDUMP_LITE_DATA = "$PWD\.data"; & $py scripts/seed_graph_demo.py --dumps 140 [--force] [--seed 7]
```

What the seed contains: ~8 topic clusters over ~18 months, people, concepts with spelling variants
("Internship"/"internships"), cross-cluster bridge concepts (Burnout, Sleep ...), `similar` links, items of every
kind (tasks with due dates, some overdue, some done), lonely dumps with no concepts, two rising concepts
(`Half marathon`, `Beta testers`/`Launch plan`) and fading ones (`Internship`, `Spanish vocabulary`), plus a
**trashed** dump (`seed-trashed`, concept `TrashedOnlyConcept`) and a **private** dump (`seed-private`, concept
`PrivateOnlyConcept`) that must never appear on the map, in search or exports. `onboarded` is true, so the app opens
straight onto the page in the URL. Item nodes (tasks, ideas ...) are off by default on the map; pre-seed
`localStorage['bdl-graph-types'] = '[]'` to show them.

### `scripts/graph_shot.mjs` (Node 22+, built-ins only; headless Edge, falls back to Chrome)

```text
node scripts/graph_shot.mjs --url URL --width 1500 --height 900 [--dpr 1]
   --pre  "JS"      run on a blank same-origin page BEFORE the app loads (seed localStorage)
   --init "JS"      run on every new document before page scripts (Page.addScriptToEvaluateOnNewDocument)
   --seed-random N  deterministic Math.random: two runs of the same code give byte-identical PNGs
   --wait MS        settle time after load (default 2500; use ~5000 when you need the physics fully settled)
   --wait-for "JS"  poll until truthy (max 20 s) before settling
   --eval  "JS"     evaluated after settling, JSON result printed as `EVAL <json>`
   --steps 'JSON'   [{"key":"ArrowRight"},{"click":[x,y]},{"hover":"css sel"},{"drag":[x0,y0,x1,y1]},
                     {"wheel":[x,y,dy]},{"type":"text"},{"wait":300},{"eval":"js"},{"shot":"a.png","clip":"#graph-wrap"}]
   --out FILE       final screenshot
```

Targets (`click`, `dblclick`, `rclick`, `hover`, `drag`) are `[x,y]` in CSS px, a CSS selector, or `{"js":"expr"}`
returning `[x,y]`, `{x,y}` or an element. `key` accepts `ctrl/shift/alt/meta: true`. Console errors, uncaught
exceptions and failed resource loads are printed as `[error] ...` and make the exit code 1 (a failed driver step
counts too); 2 = the driver itself failed. In the browser console the live engine api is `window.__bdlGraph`
(`__bdlGraph.nodes`, `.view.toScreen(x, y)`, `.select(id)`, ...), so tests can aim at nodes by id:

```powershell
node scripts/graph_shot.mjs --url http://127.0.0.1:$port/#graph --seed-random 1 --wait 4000 `
  --pre "localStorage.setItem('bdl-graph-layout','galaxy')" `
  --steps '[{"hover":{"js":"(()=>{const g=__bdlGraph,n=g.byId[\"concept:sleep\"];return g.view.toScreen(n.x,n.y)})()"}},{"wait":300},{"shot":"hover.png"}]' `
  --eval "__bdlGraph.nodes.length"
```

PowerShell quoting is fiddly: for anything long, write a small `.mjs` that calls `spawnSync(process.execPath, [shotScript, ...args])` so
the JSON never goes through a shell.

Checks to run before you commit (all must be green): `.venv python -m pytest -q` (full suite), `npm run lint:js`,
and a screenshot of your feature with **no `[error]` lines** from `graph_shot.mjs`. To prove you changed nothing you
did not mean to, take `--seed-random 1 --wait 5000` shots of organic and galaxy before and after and compare file
hashes (the layouts are deterministic under a seeded `Math.random`).

## Module map

```text
static/js/views/graph.js      router entry: render(ctx); owns the view `state`; builds the api; rebuilds the map
static/js/graph/prefs.js      every persisted pref (localStorage keys unchanged) + prefs.define(); pins, saved views, overlay ids
static/js/graph/data.js       fetch, filter pipeline (types -> range -> mentions), registerFilter()
static/js/graph/filter-edges.js  edge filters (mention / similar links, similarity threshold) + their prefs
static/js/graph/engine.js     createGraphApi(): canvas, pan/zoom, draw loop, hit-testing, input, event bus
static/js/graph/physics.js    makeSim / placeOrganic / placeGalaxy / step  (plain functions, DEFAULT_FORCES)
static/js/graph/layouts.js    LAYOUTS registry + the two built-in layouts (organic, galaxy)
static/js/graph/layout-*.js   ego (Ego rings), lanes (Topic timeline), islands (Cluster islands), concepts (Concept map),
                              matrix (People x concepts grid); layout-util.js = their shared helpers and in-canvas chrome
static/js/graph/community.js  community detection (islands, Cluster outlines)
static/js/graph/overlays.js   OVERLAYS registry, HULL_PAINTERS, overlay runtime (api.overlays)
static/js/graph/overlay-*.js  hulls (Cluster outlines), bridges (Connectors), trends (Rising & fading), lonely (Lonely dumps),
                              loops (Open loops), links (Suggested links); overlay-common.js = shared palette/legend/info helpers,
                              overlay-bridges-calc.js = the connector maths
static/js/graph/infobox.js    the #graph-info box and its section registry
static/js/graph/info-sparkline.js  mention-history sparkline + Rising/Fading summary (info box and hover card)
static/js/graph/hovercard.js  hover card (GET /api/graph/card/<id>), a DOM element on <body>
static/js/graph/keyboard.js   keyboard navigation, cheat sheet, screen-reader announcements, selectAndReveal()
static/js/graph/drag-merge.js Shift-drag a concept/person onto another of the same kind -> POST /api/merge
static/js/graph/timelapse.js  time-lapse controller (api.timelapse); timelapse-bar.js = transport bar; timelapse-record.js = WebM recorder
static/js/graph/export*.js    Export menu (export.js), PNG/SVG/Obsidian canvas builders (export-svg.js, export-canvas.js),
                              shared helpers (export-common.js), save/download (export-save.js -> POST /api/graph/export/save)
static/js/graph/path.js       Path mode (BFS between two clicked nodes)
static/js/graph/find.js       "Find a node" box
static/js/graph/panel.js      the slim bar + collapsible side panel (section 9)
static/js/graph/hooks.js      onGraphReady(fn): subscribe to the bus once per visit
static/js/graph/plugins.js    manifest of side-effect imports: add your module here
static/css/graph.css          @imports only; graph-panel / -layouts / -cards / -overlays / -tools .css, one owner each
app/graph_cards.py + routes_graph_cards.py       GET /api/graph/card/{node id}
app/graph_insights.py + routes_graph_insights.py GET /api/graph/insights/{lonely,loops,suggested-links,links}, POST/DELETE links, POST dismiss
app/routes_graph_export.py    POST /api/graph/export/save (target of the native Save dialog; see "Security")
```

Ownership rule of thumb: a new feature adds **new files** (`layout-<x>.js`, `overlay-<x>.js`, `filter-<x>.js`, ...),
one import line on its own line in `plugins.js`, and CSS in its own `graph-*.css`. Touch `engine.js`, `physics.js`,
`views/graph.js` only for genuine platform gaps, and list that in your report.

### Lifecycle (read this once)

`render()` (every visit to `#graph`) creates **one persistent `api`**, installs infobox / path / time-lapse, runs the
`onGraphReady` hooks, renders the panel, loads data and calls `state.mount()`. `state.mount()` applies the filters
and calls `api.mount(canvas, {nodes, edges})`, which builds a **fresh engine instance** (new canvas, new node objects)
and emits `nodesChanged`. Mounts happen whenever a filter, layout, node type or Focus changes. So: subscribe to the
bus once (in an `onGraphReady` hook or an install function), re-derive per-node data in a `nodesChanged` handler,
and always read `api.nodes` / `api.view.scale` through `api` instead of caching them.

### View state (`state`, passed to `renderPanel` and ready hooks)

`{ types, hidden: Set, prefs, data (unfiltered dataset + hasItems), api, panel,
mount(), refresh(), toggleType(id), setFocus(bool) }`. `api.viewState` is the same object.

## 1. Layout registry (`layouts.js`)

```js
LAYOUTS.push({
  id: "lanes", label: "Swim lanes", icon: "≡",
  desc: "One lane per topic, dumps in time order along each lane.",   // 1-2 sentences, shown by the control panel
  prepare(data, api) { return { nodes: data.nodes.filter(n => n.type !== "dump"), edges: data.edges }; }, // optional
  place(api) { api.nodes.forEach((n, i) => { n.x = i * 40; n.y = 0; n.tx = n.x; n.ty = n.y; }); },
  forces: { repulsion: 0, linkPull: 0.2, anchor: 0.1 },   // optional knobs, see below
  fixed: false,                                           // true: no physics, positions come straight from place()
  drawUnder(ctx2d, api) { /* lane lines, in world coords */ },
  hitTest(x, y, api) { return null; },                    // x,y in world coords, runs when no node is under the pointer
  onClick(hit, api) {},
});
```

* `prepare(data, api)` runs on the filtered dataset before node objects exist (`api.nodes` is still empty); return
  `{nodes, edges}`; new nodes need only `id, label, type` and may carry `meta`.
* `place(api)` runs once per mount, with `api.nodes/edges/byId`, `api.sim`, and `api.env()` = `{W, H, spacing}`.
  Set `n.x, n.y` (and `n.tx, n.ty` if you use `anchor`). Saved positions and pins are applied **after** `place`, for
  any layout id, using the existing per-layout `bdl-graph-view-<id>` snapshot.
* `forces` is merged over `DEFAULT_FORCES` (`physics.js`): `repulsion` (x), `reach` (px), `linkPull` (x),
  `linkLength` (x), `centerPull`, `anchor` (number or `(node) => strength`; pulls toward `tx/ty`), `collide`,
  `collidePad`. `fixed: true` disables the simulation entirely (dragging still moves a node directly).
* Selection is the `layout` pref (`bdl-graph-layout`): any registered id; an unknown id falls back to `organic`.
  Switch with `prefs.set("layout", id); state.mount()`.
* `placeOrganic(sim, env)` / `placeGalaxy(sim, env)` / `hash01` / `GOLDEN` are exported from `physics.js` for reuse.
* Optional fields beyond the above (read by `engine.js` / `layout-util.js`):
  `locked: true` positions come from the data, so no saved arrangement, no pins, and nodes can't be dragged (a drag pans);
  `edgeStyle(e, a, b, api)` returns `false` (don't draw) or `{alpha, width, color}` multipliers;
  `hideNode(n)` the layout paints this node itself (lane headers, grid labels): the engine skips it, exports still include it;
  `hint: "text"` a dismissible tip chip bottom-right (remembered per layout under `bdl-graph-hint-<id>`);
  `note(api)` html shown mid-map when there is too little data; `caption(api)` a status pill top-left;
  `relayout(api)` called when the Spacing slider moves; `noHulls: true` the Cluster outlines overlay draws nothing
  (islands already are outlines). `prepare` may return fewer nodes than the filters left: the count in the bar then
  says "Showing X of Y nodes" for what is on screen. Concepts/people that lose their dumps keep a `born` time only if the
  layout sets it (concepts does); the time-lapse fills in the rest from the full dataset, see section 7.
* Built-ins in registration order: organic, galaxy, ego, lanes, islands, concepts, matrix.

## 2. Overlay registry (`overlays.js`)

```js
registerOverlay({
  id: "trends", label: "Trends", icon: "📈", desc: "Colour concepts by whether they are rising or fading.",
  needs: ["items"],                                  // optional: dataset must include item nodes
  load(api) { return fetch(...).then(r => r.json()); },   // state; reruns after every rebuild of the map
  nodeStyle(n, state, api) { return state[n.id] ? { color: "#f87171", ring: "#fff", glow: "#f87171", scale: 1.3, alpha: 1, badge: "↑" } : null; },
  drawUnder(ctx2d, api, state) {}, drawOver(ctx2d, api, state) {},   // world coords
  legend(state) { return `<span class="chip">Rising</span>`; },
  info(n, state, api) { return `<div class="small">12 mentions this month</div>`; },
});
```

`nodeStyle` fields: `color`, `glow`, `scale`, `alpha`; `ring` is a css color or `{ color, width, dash: [on, off], gap }` (px,
`gap` = extra distance from the node); `badge` is a string or `{ text, bg, color }` (a pill at the node's top-right).
Shipped overlays (ids): `hulls` Cluster outlines, `bridges` Connectors, `trends` Rising & fading, `lonely` Lonely dumps,
`loops` Open loops, `links` Suggested links. Precedence when several are on is in the header of `overlay-common.js`.
`legend(state)` html is shown by the panel in the map's bottom-right card under the overlay's own heading, so it must
not repeat the title (use `legend()` from `overlay-common.js`, which only wraps the keys). An overlay with an `info` for a
dump makes a plain click on that dump select it instead of opening it (info box with an "Open dump" button), see
`api.overlays.infoHtml(node)`; with no such overlay a click on a dump opens its history page as before.

Active ids are stored under `bdl-graph-overlays` (JSON array). Runtime on `api.overlays`: `list()`, `active()`,
`isActive(id)`, `setActive(id, bool)` (persists, loads state, redraws, emits `overlaysChanged`), `state(id)`,
`legendHtml()`. The engine applies `nodeStyle` (merged: later overlays win for color/ring/glow/badge, scale/alpha
multiply) every frame, and the info box shows each active overlay's `info` html. `HULL_PAINTERS` /
`registerHullPainter(fn(ctx2d, api))` is the empty hook between edges and nodes for cluster hulls.

## 3. Engine api and event bus (`engine.js`)

Passed to every plugin function. Properties are live getters:

```text
api.nodes api.edges api.byId api.nbrIds{id:[ids]} api.sim api.canvas api.wrap api.colors{colors,bg,text,edge,dump}
api.selectedId api.hoverId api.width api.height api.spacing api.layout api.highlight api.prefs api.overlays
api.view  { scale, panX, panY (settable), toWorld(clientX,clientY)->{x,y}, toScreen(x,y)->{x,y} client coords }
api.neighborsOf(id, hops=1)->Set   api.select(id|null)   api.hover(id|null)   api.focusOn(id)->bool
api.requestDraw()  api.reheat()  api.fit()  api.snapshot()  api.env()->{W,H,spacing}
api.setNodeVisibility(pred|null, id="default")   // drawn only while every registered pred(node) is true
api.setHighlight({nodes:Set(id), edges:Set(api.edgeKey(a,b))}|null)  // emphasise these, dim the rest
api.on(event, fn(payload, api)) -> unsubscribe     api.emit(event, payload)
```

Node objects keep stable fields: `id label type created_at dump deg r x y w fx fy tx ty vx vy born` plus a free
`meta` object (fx/fy non-null = pinned; `born` = ms timestamp the node first "appears"; `dump` = owning dump id for item
nodes). Selection, hover and click events carry the node.

| event | payload | notes |
|---|---|---|
| `hover` | `{ id, prev, node }` | `id` null = pointer left every node |
| `select` | `{ id, node }` | `id` null = cleared; the info box listens |
| `click` | `{ node\|null, e, point, handled }` | set `handled = true` to suppress the default (Path does) |
| `dblclick` | `{ node\|null, e, point, handled }` | default: release a pinned node |
| `dragstart` | `{ node, e }` | pointer pressed on a draggable node (not in `locked` layouts) |
| `drag` | `{ node, e, point }` | every mousemove while dragging; `point` in world coords |
| `dragend` | `{ node, e, dragged, restore }` | set `restore = true` to put the node back and not pin it (drag-merge does) |
| `keydown` | `{ e, node }` | `node` = hovered, else selected; not fired while typing in an input. Handlers run in registration order: call `e.preventDefault()` for a key you used, and skip events with `e.defaultPrevented` (the time-lapse owns Space / Left / Right / Esc while open and keyboard.js yields to it) |
| `beforeDraw` / `afterDraw` | `{ ctx }` | inside the pan/zoom transform (world coords); `ctx.save()` yourself |
| `tick` | `{ alpha }` | every animation frame, before the physics step |
| `nodesChanged` | `{ nodes, edges }` | after every (re)mount; reset per-node caches here |
| `overlaysChanged` | `{ id, on }` | |

Subscribe once per visit with a ready hook (return a cleanup function if you add window listeners):

```js
import { onGraphReady } from "./hooks.js";
onGraphReady((api, state) => api.on("keydown", ({ e, node }) => { if (e.key === "f" && node) api.focusOn(node.id); }));
```

## 4. Data filter pipeline (`data.js`)

`filters = [{ id, apply(nodes, edges, prefs, ctx) -> { nodes, edges } }]`, run in order; `ctx.all` is the unfiltered
dataset. Built-ins, in order: `types` (legend toggles), `range` (date range; a dump outside it takes its items),
`mentions` (min mentions for concepts/people). `keep(nodes, edges)` drops dangling edges.

```js
import { registerFilter, keep } from "./data.js";
import { prefs } from "./prefs.js";
prefs.define("minSimilar", { key: "bdl-graph-min-similar", def: 0.6, parse: (raw) => { const v = parseFloat(raw); return v >= 0 && v <= 1 ? v : undefined; } });
registerFilter({ id: "similar", apply: (nodes, edges, p) => keep(nodes, edges.filter(e => e.type !== "similar" || e.score >= p.get("minSimilar"))) }, { after: "mentions" });
```

After changing a pref your panel control calls `state.mount()`. `prefs.define(name, {key, def, parse, serialize})`,
`prefs.get/set/onChange`. Built-in prefs: `spacing layout hoverTitles minMentions range focus` (focus is never persisted).

## 5. Draw layers (fixed order, world coordinates)

`beforeDraw` event -> `layout.drawUnder` -> edges -> `HULL_PAINTERS` -> `overlay.drawUnder` -> nodes (with `nodeStyle`) ->
`overlay.drawOver` -> labels -> `afterDraw` event. The hover card is a DOM element positioned with
`api.view.toScreen`, not a canvas layer.

## 6. Info panel (`infobox.js`)

```js
import { infoSections } from "./infobox.js";
infoSections.push({ id: "mood", order: 20, render(node, api) { return `<div class="small muted">tone: ${node.meta.tone ?? "?"}</div>`; } });
```

`render` returns an HTML string, an `Element`, or null to skip. Sections sort by `order` (the built-in node summary is
0, overlay info is 100). `showHtml(html)` / `hide()` / `showNode(node, api)` are exported for other tools (Path uses them).

## 7. Time-lapse (`timelapse.js`)

`installTimelapse(api)` (called by the view) keeps its own state, registers `alive(n)` via
`api.setNodeVisibility(ctl.alive, "timelapse")` and exposes the controller as `api.timelapse`:
`start() stop() toggle() play() pause() seek(ms) step(±1) setSpeed() setLoop() setFollow() toggleRecording() shownCount()
noun(n) alive(n) onChange(fn)`, plus `active` (a time-lapse is open), `running` and `state {on, playing, cur, from, to,
unit, ...}`. The transport bar (`timelapse-bar.js`, `#graph-tl-bar`) is a DOM strip inside the map wrap; it publishes its
height as `--tl-off` on the wrap so legends, tips and the "?" button sit above it. Keys while open: Space, Left/Right, Esc.
The timeline is the dumps on the map; in layouts that show no dumps (concept map, grid) it is the concepts/people,
dated by their first dump (`fillBorn()` reads the unfiltered `viewState.data`), and `unit` is `"topic"`. Layouts that
paint their own data should honour `api.timelapse.alive(n)` / `state.cur` (the grid counts only dumps up to `cur`).
The single start button is `#graph-tl-btn` in the panel's Tools section; `mountTimelapseUI(container, api)` is the older
one-button control and only mounts into `#graph-slot-timelapse` when no `#graph-tl-btn` exists.

## 8. Path mode (`path.js`)

`installPath(api)`, `togglePath(api)` (the toolbar button), `isPathMode()`. It listens to `click`, marks the click
`handled` while the mode is on, runs BFS over `api.nbrIds`, sets `api.setHighlight(path)` and writes the summary with
`showHtml`. Mode survives rebuilds; a half-made path does not.

## 9. Panel seam (`panel.js`)

`renderPanel(ctx, state)` is the only thing `views/graph.js` calls for chrome. It must call `ctx.setTitle(...)`, write
the chrome plus an empty `<div class="graph-wrap" id="graph-wrap"></div>` into `#view`, wire every control, and return
`{ paintLegend(), setCount(text) }`. Structure: a slim bar (`#graph-find` + `#graph-find-list`, layout quick-switch
`#gp-layout-bar`, Fit, count `#graph-count`, Panel toggle) above `#graph-main` = the map wrap + `<aside id="graph-panel">`.
The panel body is generated from the registries, in this order: **Layout** (every `LAYOUTS` entry; the chosen one shows
its full `desc`, the others a 2-line preview + tooltip), **Overlays** (every `OVERLAYS` entry as icon + label + desc +
switch `#gp-ov-<id>`, grouped by `group`), **Show** (node types, date range, minimum mentions, Reset filters, live
count), **Links** (mention / similar switches, similarity threshold), **Display** (spacing, titles on hover, Focus),
**Tools** (Path, Fit, `#graph-tl-btn`, and three mount points). Mount points inside Tools: `#graph-slot-timelapse`,
`#graph-slot-export` (the Export menu opens inline there), `#graph-slot-keys` (the "Keyboard shortcuts" button; a floating
"?" on the map is always present too). The body is re-rendered after node-type edits and filter resets, which throws
mounted content away, so after every render the panel dispatches `window` event **`bdl-graph-panel-rendered`**: listen
to it (and also mount once at ready) and refill your slot idempotently. Persisted UI state: `bdl-graph-panel-open`
(`"1"/"0"`, default open from 1150 px wide), `bdl-graph-panel-collapsed` (JSON array of section ids). Active overlays'
legends are drawn in a card at the bottom-right of the map (`.gp-legend`), rebuilt on `nodesChanged` / `overlaysChanged`.
Other ids kept for other modules: `#graph-tl-btn`, and in the map wrap `#graph-info`, `#graph-tl`, `#graph-canvas`
(created by `state.mount()`). Bottom-edge furniture (tip chip, legends, "?", cheat sheet, transport bar) is positioned
in `graph-panel.css` so they stack instead of overlapping.

## Behaviour notes / things that are easy to break

* Physics results are deterministic given a seeded `Math.random`; keep the order of `Math.random()` calls in
  `placeGalaxy` and `step` if you refactor them (that is how "no behaviour change" is checked pixel for pixel).
* The server sends `Cache-Control: no-cache` for static files, so edits show on reload; `?v=` strings in
  `static/index.html` are rewritten by `release.ps1`.
* `localStorage` keys (do not rename): `bdl-graph-spacing`, `-layout`, `-hover-titles`, `-min`, `-range`, `-types`
  (hidden node types), `-pins`, `-view-<layoutId>`, `-overlays`; newer: `-edge-mention`, `-edge-similar`, `-edge-min-similar`,
  `-tl-speed`, `-tl-loop`, `-tl-follow`, `-hint-<layoutId>`, `-panel-open`, `-panel-collapsed`, `-export-transparent`.
  Every reader must tolerate junk (an unknown layout falls back to organic; non-array lists are ignored).
* Click rule (engine): a plain click on a dump or item opens its history page, unless Focus is on, the node is already
  selected, Path mode handled it, or an active overlay has `info` for it (then it selects and the info box offers
  "Open dump"). The hover card is not shown for the selected node.
* Toggling Focus rebuilds the map; `state.setFocus` re-selects the previous selection afterwards.
* Time-lapse start button, Keys button, Export: one entry point each in the panel (see section 9), never a second copy.

## Security of the new endpoints

* `POST /api/graph/export/save` (the client names an absolute path): extension whitelist (`.png .svg .canvas .webm`), the
  bytes must look like that type (PNG/WebM magic numbers, `<svg`, JSON object), no UNC/network paths, no hidden
  (dot) files or dot-directories, nothing inside the app data folder or the code folder (symlinked parents are resolved
  first), refuses symlink targets and directories, body capped at 256 MB (`Content-Length` checked before reading), write
  is a temp file + `os.replace`, errors carry no stack traces or paths. Tests: `tests/test_graph_export_save.py`.
* `GET /api/graph/card/*` and `/api/graph/insights/*` read through `db.PRIVATE_SQL` and `deleted_at IS NULL`, use only
  bound parameters, and the link endpoints validate both node ids against the live (non-trashed, non-private) universe.
* `docs/CODEMAP.md` is generated: run `python scripts/codemap.py` after adding or removing modules.
