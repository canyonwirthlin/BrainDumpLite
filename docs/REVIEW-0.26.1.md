# Review notes for 0.26.1

Written during the post-update cleanup. Ranked, plain English. Nothing here was changed; the bugs that were fixed are in the
cleanup commits, not here. "Effort" is a rough guess for one person who knows the code.

## 1. The local API trusts anything that can reach it (security) - medium/high
- Where: `app/main.py` (only middleware is the app-lock gate), `run.py` (uvicorn on 127.0.0.1).
- Why it matters: there is no Host or Origin check and no per-session token. Any web page open in the same browser can fire
  GET/DELETE requests at `http://127.0.0.1:<port>/api/...`, and a DNS-rebinding page can read the answers too. The API can
  export the whole vault (`/api/data/export.json`), delete dumps, rewrite settings and start MCP servers/plugins. The phone page
  (`app/phone.py`, 0.0.0.0) is a separate app and is token-gated, which is good.
- Fix: a middleware that rejects requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` and whose `Origin` (when sent)
  is not the same origin; optionally a random per-launch token the shell injects. Effort: half a day plus tests.

## 2. No browser tests in CI, so UI regressions ship silently (test gap) - medium/high
- Where: `.github/workflows/release.yml` runs `pytest` only; the Brain map, tutorial and templates are checked by Node unit
  tests, static string tests and a manual headless walk (`scripts/tour_walk.mjs`).
- Why it matters: the bugs found in this cleanup (invisible Search buttons, overlay out of step with Link mode) were all
  invisible to the suite. Drag, Ctrl+Z, hover cards, focus handling and light/dark contrast have zero automated coverage.
- Fix: run `scripts/graph_shot.mjs`/`tour_walk.mjs` in CI against `scripts/graph_serve.py` (headless Chrome is on the runner) and fail on
  `[error]` lines; add 3-4 scripted flows (link, merge, undo, search chips). `npm run lint:js` is also not run in CI. Effort: 1-2 days.

## 3. Whole-vault rewrites with no automatic safety net (data loss) - medium
- Where: `app/graph.py: merge_names`, `app/routes_graph_undo.py`, `dump_templates` and other free-form settings keys.
- Why it matters: a concept/person merge rewrites every dump that carries the name (trashed and private ones too). Undo is exact but
  lives in a 30-entry cache in the settings table and refuses (409) once any touched dump was edited. Settings documents (templates,
  accepted links) are whole-document last-write-wins, so two windows or a stale tab overwrite each other. The vault backup is opt-in.
- Fix: take a lightweight pre-merge snapshot (or turn on a rolling automatic backup by default) and add a version/ETag to the
  settings documents that users edit by hand. Effort: 1 day for the backup default, 2 days for versioned documents.

## 4. Release process is long, Windows-centred and verified by hand (fragile release) - medium
- Where: `release.ps1`, `.github/workflows/release.yml`, `src-tauri/`; the macOS build is CI-only and was never run locally.
- Why it matters: one script edits versions, the changelog gate, the codemap and tags; a half-finished run needs manual repair
  (cargo metadata quirks, line-ending flags). Dependency pins such as `av<19` exist because an upstream release broke transcription
  after the fact; there is no scheduled job that installs the latest of each dependency and runs the tests to catch that early.
- Fix: a dry-run flag that does everything except push; a weekly CI job on unpinned dependencies; a smoke test that launches the
  frozen backend and hits `/api/status` before installers are built. Effort: 1-2 days.

## 5. Every map edit reloads and rebuilds the whole graph (performance cliff) - medium
- Where: `static/js/graph/edit-tools.js: reloadMap`, `blueprint.js: reload`, `overlay-links.js: remount`.
- Why it matters: linking, unlinking, merging, undo and redo each refetch `GET /api/graph` (all nodes and edges) and rebuild the engine.
  Fine at 250 nodes; at the 1,500+ node large-map threshold each edit is a multi-second stall, and the physics restarts.
- Fix: return the changed nodes/edges from the edit endpoints and patch `state.data` in place, or at least debounce and skip the
  physics reheat. Effort: 2-3 days.

## 6. One shared SQLite connection and a global lock (architecture / scale) - low/medium
- Where: `app/db.py` (`check_same_thread=False`, one connection, `db.lock()`), `app/routes.py` (1,475 lines, the biggest module).
- Why it matters: every request, the pipeline worker and the importer queue behind one connection; a long reprocess or import makes
  the UI feel stuck. `routes.py` mixes many unrelated endpoints, which makes the "own module per feature" rule easy to forget.
- Fix: a connection per thread (WAL is already on) with the lock kept only for multi-step edits; keep splitting `routes.py` as
  features touch it. Effort: 2-3 days for the connection change, ongoing for the split.

## 7. Small races and sharp edges worth a ticket (not fixed) - low
- `static/js/graph/undo-stack.js`: if a new edit is pushed while an undo is still running, the finished entry is not popped and can
  appear twice. Rare, but the buttons only grey out, they do not block edits during the undo.
- `app/import_md.py: enqueue/_worker`: the worker exits after 2 s idle; an item queued in that instant is not processed until the next
  import.
- `static/js/ui.js: md()`: a link or bold/italic marker inside a URL gets turned into markup (not an XSS hole, text is escaped first,
  but the link is wrong).
- Several graph modules clean up on `hashchange` as well as through the ready-hook cleanup; both paths work, but the pattern is
  easy to get wrong in a new module. A single `onGraphLeave` hook would remove it.
- No dead-endpoint audit was done: `GET /api/graph/insights/lonely`, `/loops`, `DELETE /api/graph/insights/dismissed` and the
  `/api/suggestions*` family show no caller in the codemap (the frontend builds some URLs dynamically). Check before removing.
