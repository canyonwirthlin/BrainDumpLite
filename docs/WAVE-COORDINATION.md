# Wave coordination: v0.26.1 patch (graph toolbar, links, merge/undo, templates)

Read this fully before touching anything. It extends the "rules for parallel agents" in `CLAUDE.md`.
Base branch: `integration-0.26.1`. Work in your own worktree on `feat/<agent-name>`.

## The board (how agents know about each other's changes)
Live board file (append-only, shared on disk by absolute path):
`C:\Users\canyo\AppData\Local\Temp\claude\7f749fba5216fc9b\262feffc-529e-4421-828f-966fe2b633fa\scratchpad\wave-board.md`
- READ it before you start and again before every commit.
- APPEND one line per commit or per contract change: `[<agent>] <commit-short-hash> <what> | others must know: <API/DOM-id/file changes, or "nothing">`
- APPEND `REQUEST <owner>: <what you need>` if you need a file you do not own changed. Do not edit it yourself. Keep working on
  something else and re-read the board; the owner answers with `DONE <agent>: ...`. If the owner is idle or it blocks you, put
  `BLOCKED <agent>: ...` and finish what you can; the orchestrator reads the board.
- Append with `echo "[agent] ..." >> "<path>"` (never rewrite or truncate the file).

## Agents, ports, file ownership (a file has exactly ONE owner)
| agent | port | owns (create/edit freely) |
|---|---|---|
| graph-shell | 8761 | `static/js/graph/ribbon.js`, `static/js/graph/panel.js`, `static/js/views/graph.js`, `static/css/graph-toolbar.css`, `static/css/graph-panel.css`, `docs/graph-architecture.md` (the ribbon section), `tests/test_graph_panel.py`, `tests/test_graph_ribbon*.py` |
| graph-blueprint | 8762 | `static/js/graph/blueprint*.js`, `static/css/graph-blueprint.css`, `app/routes_graph_links.py`, `tests/test_graph_links.py` |
| graph-undo | 8763 | `static/js/graph/undo.js`, `static/js/graph/edit-tools.js`, `static/js/graph/drag-merge.js`, `static/css/graph-edit.css`, `app/routes_graph_undo.py`, `tests/test_graph_undo.py` |
| templates | 8764 | `static/js/templates.js`, `static/js/templates-ui.js` (new), `static/js/views/capture.js` (template row only), `app/routes_templates.py`, `static/css/templates.css`, `tests/test_templates.py` |
Nobody edits `static/js/graph/engine.js`, `static/js/graph/toolbar.js` (contract, owned by the orchestrator) or anything under
`docs/CODEMAP.md`, `CHANGELOG.md`, `release.ps1`, version files. Need a change there? `REQUEST orchestrator`.

## Shared one-line edits (everyone may do these, nothing more)
- `static/js/graph/plugins.js`: uncomment YOUR reserved import line only.
- `static/css/graph.css`: uncomment YOUR reserved `@import` line only.
- `app/main.py`: add ONE `include_router(...)` line for your own router at the end of the router block.
- `static/js/views/settings.js` (templates only): one section hook, minimal.
- `static/index.html`: only if a new top-level stylesheet is unavoidable (templates.css); one `<link>` line, version-query like the others.

## Contracts (already on the branch, read the file headers)
- `static/js/graph/toolbar.js`: `registerTool({tab,id,label,icon,tip,help,kind,...})`, tabs `view|layout|overlays|filter|edit|tools`, and the exclusive
  mode switch `getMode/setMode/onModeChange` (default mode `"select"`; link = `"link"`, merge = `"merge"`).
  Tools that exist today (Find, layouts, overlays, filters, Fit, Path, Time-lapse, Export...) are migrated by graph-shell, which also registers the
  `select` mode tool. graph-blueprint registers `link`, graph-undo registers `merge`, `undo`, `redo`.
- `static/js/graph/undo.js`: `pushUndo({label,undo,redo})` after a successful edit. graph-blueprint and graph-undo both push; graph-undo owns the file.
- Event bus (engine): `select hover click dblclick dragstart drag dragend keydown beforeDraw afterDraw nodesChanged`. Draw extras in `afterDraw`.
  Subscribe through `onGraphReady` (graph/hooks.js). While a mode other than `select` is active, plain drag/click on nodes belongs to that mode.
- Tooltips: every tool has a one-sentence `tip`; every tab's "?" shows the tab `help` plus each tool's `help`. Write both in plain English.
- Theme: only `var(--...)` colours (see tokens.css); light and dark must both look right. Keyboard reachable, aria-labels on icon-only buttons.

## Rules (from CLAUDE.md, repeated because they matter here)
- Python tests: `.venv/Scripts/python -m pytest -q` via the main checkout interpreter (`C:\Users\canyo\Desktop\Home\Coding\BrainDumpLite\.venv\Scripts\python.exe`); JS gate `npm run lint:js`.
  Run only your own tests while iterating, the full suite once before your final commit. Add tests for new logic.
- No schema/migration changes (`app/db.py` untouched). Free-form `settings` keys are fine. Trash/private rules in CLAUDE.md apply to every dumps query.
- Sandbox vault only (`scripts/graph_serve.py --data "$PWD\.data" --port <yours>`; see `docs/graph-architecture.md`). Never touch the real vault, never download models.
- Commit per feature with `git -c core.safecrlf=false`, messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
  Never push, tag, bump the version, edit CHANGELOG, run `release.ps1` or regenerate `docs/CODEMAP.md` (the orchestrator does all of these once).
- Prove UI work in the real page: serve the sandbox, drive it with `scripts/graph_shot.mjs` (or Playwright), look at the screenshots, check the console is clean.
- Final report (to the orchestrator): shipped; files touched; shared files edited; contract changes; a 2-4 line plain-English changelog blurb; open problems.
