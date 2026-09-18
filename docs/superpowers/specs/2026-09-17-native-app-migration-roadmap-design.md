# BrainDump Lite — Native App Migration & Feature Roadmap

**Status:** Design approved by user (Canyon), 2026-09-17. Handoff doc for continuing in
a fresh session (model: Fable). Read this in full before proposing any implementation.

## Why this doc exists

This is a condensed record of a long brainstorming conversation. It captures every
decision made so a new session doesn't have to re-derive them. Only **Phase 1** is
ready to turn into an implementation plan (via the `writing-plans` skill). Phases 2-9
are an ordered backlog — each needs its own brainstorm-to-plan cycle when its turn
comes. Do not attempt to plan or implement multiple phases at once.

## Current state (as of this doc)

- **Stack:** FastAPI backend + vanilla JS SPA frontend (`app/`, `static/`), single
  PyInstaller exe (`run.py`). `run.py` starts a local uvicorn server and opens the
  user's default browser to `127.0.0.1:<port>` — it is *not* a native window today.
- **Distribution:** 2 friends only, Windows. `push-update.bat` bumps
  `app/version.py`, builds `update.bin` (a zip of `app/` + `static/`), pushes it to
  GitHub repo `canyonwirthlin/BrainDumpLiteUpdateService`. Friends' exes poll
  raw.githubusercontent.com on launch and self-update. **Hard constraint today:**
  OTA code must stay stdlib-only-additive because friends run frozen exes (frozen
  deps: fastapi, uvicorn, openai, truststore, faster-whisper, ctranslate2, av).
- **Built-in local AI:** `app/engine.py` manages a local `llama-server` (llama.cpp,
  Vulkan win-x64) for chat, plus a CPU-only nomic embedding model. Friends have
  6-8GB VRAM; curated models must fit that. Ports: chat 8790+, embed 8820, web app
  8756-8780.
- **Not a git repo currently** (per environment check) — this doc was written to
  disk but not committed.

## Locked architectural decision: Tauri + Python sidecar

Not a full rewrite. Keep the FastAPI backend, DB layer, `engine.py`, classify
pipeline, and vanilla JS frontend exactly as they are. Build a Tauri (Rust) shell
that:
- Spawns the existing backend (still built via PyInstaller) as a bundled **sidecar**
  process.
- Opens a native WebView2 window pointed at the sidecar's localhost port, instead of
  opening a system browser tab.
- Produces a real installer (Start Menu entry, taskbar/tray icon, proper
  uninstaller) instead of "console window + browser tab."

This removes the current stdlib-only-additive constraint — updates ship a full new
build, so new pip/cargo deps can be added freely per release again.

### v1 scope decisions (all confirmed with user)

- **Windows only for v1.** Add Mac/Linux installer targets later, once the shell is
  proven. Eventual goal is a small public release, so don't architecturally box out
  cross-platform — just don't build it yet.
- **Ship unsigned for v1.** No code-signing cert yet (cost deferred). Revisit later —
  user's own dev machine already has Avast killing unsigned exes (see memory:
  `canyon-machine-avast-and-gpu`), so this will need a real answer before a public
  release, just not in v1.
- **Minimal Rust surface.** User has never used Rust. Keep the Tauri-side code to
  boilerplate/config (window setup, tray, sidecar spawn, updater config) and explain
  each piece when it's added, rather than assuming familiarity.
- **System tray icon is in v1.** A global-hotkey quick-capture popup was discussed
  and explicitly deferred — not in v1, don't build it yet.
- **Update system is provider-agnostic and changelog-first.** Not tied to any
  specific AI coding tool. User writes changelog entries by hand as a normal,
  intuitive step in the release flow (not auto-generated, not a rename of the old
  batch script) — the app shows this as "What's New" on update. The underlying
  publish mechanism should still be automatable (e.g. bump version + push a tag →
  CI builds and publishes), but changelog content is authored, not generated.

## Full phase roadmap

Ordered by dependency — later phases build on earlier ones' data/schema, not just
UI. Each phase is its own future brainstorm → design → plan cycle.

1. **Native shell migration** — Tauri + Python sidecar, Windows installer, unsigned,
   tray icon, provider-agnostic updater + hand-written changelog ("What's New" on
   update). *(Design above; ready for `writing-plans`.)*

2. **Design system / theming foundation** — Sleek, clean, lightweight,
   Obsidian-adjacent visual language, established early so later phases build UI
   against it once. Built-in themes + custom theme upload + theme marketplace
   (marketplace is a stretch goal, doesn't block the phase). **Settings use
   progressive disclosure**: simple view by default, an "Advanced" toggle per
   section, so the app doesn't feel eclectic as features accumulate — this is a
   standing rule for every settings screen added in later phases, not just this
   one. Keep the existing nested-tabs/settings navigation as the primary structure;
   a command palette (Ctrl+K) is additive on top of it, not a replacement.

3. **Pipeline core upgrades** — Time-relevance awareness (look at what time a dump
   is captured, estimate task duration/urgency, store that for later use by
   Calendar/backlog/etc.), tone analysis, concept/people extraction, and making
   "extractable types" a customizable schema instead of hardcoded (this is what lets
   Phase 5's user-defined graph nodes register as new things the pipeline looks
   for). Also lay down instrumentation now (timing, token counts, success/fail
   rates) even though the Stats tab that displays it doesn't ship until Phase 7 —
   retrofitting instrumentation later is much harder than building it in from the
   start.

4. **Conversational capture modes** — Therapy mode (digs deeper into concepts,
   therapist-skill-flavored AI persona) and Brainstorm mode (helps expand ideas).
   Both give live AI responses during the conversation, continuously extract items
   as the conversation happens, and collapse the full transcript into a simplified
   dump when the session ends. Moved up in the order (originally planned later)
   because these are an extension of the pipeline, not a bolt-on feature — they
   need Phase 3's pipeline work under them.

5. **Knowledge graph overhaul** — Obsidian-style graph view with the legend/key at
   the top (not the side/bottom). User-customizable nodes: add, rename, recolor.
   New node types become new pipeline-extractable categories (via Phase 3's
   schema). Concept/people browser: click a concept or person, see every dump that
   references it. Backlinks panel on any concept/person/dump, showing what else
   links to it.

6. **Markdown export / interop** — Download dumps as Obsidian-compatible markdown.
   Graph relationships convert to `[[wikilinks]]` in the export **by default**
   (toggleable off). Manual `[[wikilink]]` syntax also supported in the editor
   itself, not just on export. Explicit goal: cross-ecosystem compatibility, not
   lock-in.

7. **Model & provider flexibility + Stats tab** — Settings: connect Google Gemini's
   free API. Browsable/searchable catalog of local models — **browse-only, nothing
   downloads or increases app size until the user explicitly picks a model** —
   curated across a range of hardware compatibility, kept up to date with
   best-fit-for-the-app choices (not just "most powerful"). Stats tab in Settings
   showing model efficiency and data stats: inference speed, token/cost usage for
   paid APIs, extraction success rate, storage/data growth over time. Depends on
   Phase 3's instrumentation already being in place.

8. **Task & Calendar integrations** — Google Calendar: must be a one-click "Sign in
   with Google" OAuth flow, never a manual API key. AI pipeline can push extracted
   items to Calendar, but only with per-item confirmation on the extraction screen
   (never silent). Todoist added as a second task-push target, same
   optional-confirm pattern. Daily-plan feature: AI looks at the task backlog and
   the real Google Calendar together and recommends what to fill schedule gaps
   with — built on Phase 3's time-relevance work.

9. **Extensibility** — User-connectable MCP servers (e.g. to Google or other
   services). User-developed plugin system. Deliberately last: wants a stable core
   underneath it, and by this point task-provider integrations (Todoist, Calendar)
   are a natural template for "what a plugin looks like."

## Cross-cutting features (not owned by one phase — apply broadly)

- **Command palette (Ctrl+K)** — additive on top of the existing nested-tabs
  navigation, not a replacement. (See Phase 2.)
- **Full-vault semantic search** — nearly free once pipeline work lands, since a
  local embedding model (nomic) is already bundled in the current app.
- **Backup/restore** — single-file export/import of the *whole* local vault (DB +
  settings), distinct from the per-dump markdown export in Phase 6.
- **Local-vs-cloud trust indicator** — a clear, visible signal of whether a given
  dump or action stayed on-device or was sent to an external provider
  (Gemini/OpenAI/etc.). Matters a lot once this isn't just 2 friends who already
  trust the author.
- **Idle nudges** — native notification like "haven't captured anything in 3
  days." Cheap once Phase 1's native shell gives notification access.
- **Resurfacing / "on this day"** — periodically resurface an old dump or concept.
  Relies on Phase 3 (time-relevance) + Phase 5 (concept tracking).
- **Running "Today" stream** — a default chronological capture surface (daily-note
  style), offered as a simpler alternative to the graph view for people who find
  graphs overwhelming.
- **PIN/passphrase app lock** — local-only lock screen. Called out specifically
  because Therapy mode (Phase 4) content can be highly personal.
- **Recurring importer** — lives permanently in Settings as an "Import" action, not
  just a first-run wizard. First target: existing Obsidian vaults / plain markdown
  folders.
- **Vault location control** — Settings section showing the current data path, a
  "reveal in Explorer" action, and a "change location" action that moves/relinks
  the vault folder.
- **Vault sync** — Settings option to point the vault at any cloud-drive folder
  (Dropbox/Drive/OneDrive — just an OS-synced folder, no custom sync infra needed)
  OR a built-in Git-backed sync to a GitHub repo the user owns (commit/push the
  vault, which doubles as free version history).
- **Multiple vaults/profiles** — e.g. separate "Work" and "Personal" vaults, each
  its own data folder/settings, switchable in-app. Pairs with vault location
  control above.
- **Unified "AI Suggestions" inbox** — one sleek, clean place where *all*
  AI-proposed actions land for a yes/no/edit decision (Calendar push, Todoist push,
  new node-type creation, and any future plugin-proposed actions from Phase 9)
  instead of scattered per-feature confirm dialogs. Explicitly required to feel
  sleek/clean, not like a notifications dump.

## Overall product philosophy (applies everywhere)

- Local-first: local model + local storage is the default; cloud (Gemini, OpenAI,
  Calendar, Todoist) is opt-in and clearly marked when used.
- "Not a thousand tabs" — simple by default, advanced when you dig, never
  overwhelming. This is why Phase 2 mandates progressive disclosure in Settings.
- Cross-ecosystem compatibility over lock-in — markdown/wikilink export, importers,
  Git-backed sync all exist so a user's data is never stuck inside this app.

## Next steps

1. In the new session: confirm this doc still matches intent (things may have
   shifted; don't assume it's frozen).
2. Use the `writing-plans` skill to turn **Phase 1 only** into a concrete
   implementation plan. Do not plan Phase 2+ yet.
3. When Phase 1 ships and is stable, come back to this doc and brainstorm Phase 2
   from scratch (design systems deserve their own dedicated session, not a
   continuation of the migration plan).
