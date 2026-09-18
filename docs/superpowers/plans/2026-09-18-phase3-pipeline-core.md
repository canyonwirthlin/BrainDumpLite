# Phase 3: Pipeline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase3-pipeline-core-design.md`: customizable item types, tone + time-relevance in the classify pass, per-call instrumentation, provider trust marker, search-everything, backup/restore, vault location.

**Architecture:** Additive SQLite migrations; new small modules `item_types.py`, `instrument.py`, `vault.py`; the pipeline composes its classify prompt/schema from the type rows and records `runs`. Frontend reads `/api/item-types` once into `state.types` and renders badges from it; Settings gains the types editor and the Data actions.

**Tech Stack:** unchanged (FastAPI, SQLite, vanilla ES modules, Tauri + `tauri-plugin-dialog` for the folder picker).

## Global Constraints

- Every pipeline change must keep working with **no AI** (heuristic fallback) and with the **4k-token local model** (no extra model calls; the classify call carries the new fields).
- Migrations are additive and idempotent (`_migrate` runs on every boot).
- Existing dumps without the new columns must render (nulls everywhere are fine).
- Tests never touch the real data dir (`tests/conftest.py`) and never call a real model (fake `ai`).
- Commit after each task; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Item types table, API and dynamic classify prompt

**Files:** create `app/item_types.py`, `tests/test_item_types.py`; modify `app/db.py` (schema + migrate), `app/pipeline.py` (KINDS → dynamic), `app/routes.py` (CRUD).

**Interfaces:** `item_types.all()`, `enabled()`, `create(label, icon="", color="accent", hint="") -> dict`, `update(id, **fields) -> dict`, `delete(id)`, `enum() -> list[str]`, `prompt_rules() -> str`, `seed()`; routes `GET /api/item-types → [..]`, `POST /api/item-types {label, icon?, color?, hint?}`, `PUT /api/item-types/{id} {label?, icon?, color?, hint?, enabled?}`, `DELETE /api/item-types/{id}`.

- [ ] Tests: seed yields the six built-ins in order; create "Question" → id `question`; duplicate id → ValueError; update label/color/enabled; delete built-in → ValueError; delete custom re-kinds its items to `note`; `enum()` excludes disabled; `prompt_rules()` contains each enabled label+hint; API round trip.
- [ ] `db.py`: add `item_types`, `runs`, `items_fts` tables to `SCHEMA`; `_migrate` adds the dump/item columns listed in the spec.
- [ ] `item_types.py` with `BUILTIN_SEED` (hints copied from today's `Item type rules`), `_slug()`, CRUD over `db`.
- [ ] `pipeline.py`: `_classify_system()` builds the prompt from `item_types.prompt_rules()` and the type enum string; `_classify_schema()` sets the enum; `_parse_items` accepts `it["type"] in item_types.enum()`; `_fallback_items` unchanged.
- [ ] `main.create_app()` calls `item_types.seed()` after `db.init_db()`.
- [ ] Commit `feat(pipeline): customizable item types (table, API, dynamic classify prompt)`.

### Task 2: Tone, time-relevance, provider and instrumentation

**Files:** create `app/instrument.py`, `tests/test_pipeline.py`; modify `app/ai.py` (usage capture), `app/pipeline.py`, `app/routes.py` (expose fields).

**Interfaces:** `ai.last_usage()` → `{"prompt_tokens", "completion_tokens"}|None` for the current thread; `instrument.timed(dump_id, stage)` context manager; `instrument.record(...)`; `instrument.recent(limit)`; dump JSON gains `tone`, `provider`, `captured_local`; item JSON gains `est_minutes`, `urgency`, `time_hint`.

- [ ] Tests (fake ai via monkeypatch: `available→True`, `chat→"clean"`, `chat_json→fixture with tone/items`, `embed→None`): after `run_pipeline`, dump has `tone.label=="anxious"`, `provider=="openai"`, `captured_local` set; item has `est_minutes==30, urgency==2, time_hint=="by Friday"`; `runs` has rows for cleanup/classify/expand with `ok=1`; with `chat_json` raising `AIError` the dump still becomes `ready` with fallback items and a `runs` row `ok=0`.
- [ ] `ai.py`: thread-local `_usage`; after each successful completion/embedding set it from `resp.usage` (prompt_tokens/completion_tokens; embeddings: prompt_tokens only); `last_usage()`; `reset_usage()`.
- [ ] `instrument.py`: `timed()` measures wall time, catches nothing (re-raises) but records `ok=0` + error class/message; `record()` inserts into `runs`.
- [ ] `pipeline.py`: set `provider` + `captured_local` at start; classify prompt gains `TONE`/time fields (schema: `tone: {label enum, valence int, energy int}`, per item `estimated_minutes`, `urgency`, `time_hint`); `_parse_items` validates buckets; each stage wrapped in `timed`; items inserted with the new columns; `items_fts` rows written.
- [ ] `routes.py`: `_dump_out` adds the new fields (`tone` parsed from JSON); items rows include the three item fields; `/status` adds `vault_dir` (from Task 5 — leave for Task 5).
- [ ] Commit `feat(pipeline): tone + time-relevance extraction, provider marker, runs instrumentation`.

### Task 3: Frontend — types, badges, tone/time chips, types editor

**Files:** modify `static/js/state.js` (`state.types`), `static/js/main.js` (load types), `static/js/views/review.js` (badges + chips), `static/js/views/history.js` (tone/trust in rows + meta), `static/js/views/tasks.js` (urgency/est chips), `static/js/views/settings.js` (Extraction types editor under AI → Advanced), `static/css/views.css`.

- [ ] `state.types = []`; `loadTypes()` in `main.js` after `refreshStatus()` (GET `/item-types`); `typeOf(kind)` helper in `ui.js` reading `state.types` with fallback `{label: kind, color: "dim"}`.
- [ ] `itemRow`: `<span class="kind" style="--kc: var(--<color>) or #hex">${icon} ${label}</span>`; CSS `.kind { color: var(--kc); background: color-mix(in srgb, var(--kc) 12%, transparent); border-color: color-mix(in srgb, var(--kc) 25%, transparent); }`, remove per-kind classes; chips: `~30m`, urgency dot.
- [ ] `reviewHtml` meta: tone chip (`.tone` with `data-valence`), trust badge (`.trust.local|cloud|raw`); History rows: tiny trust dot + tone label.
- [ ] Settings → AI → Advanced → "Extraction types": table rows (swatch select of 6 token colors + hex input, label input, hint input, enabled switch, delete for custom), "Add type" form; saves per row on blur/Enter via PUT; toast on error.
- [ ] Verify in browser (Playwright): badges colored, editor add/rename/recolor/disable/delete, chips visible on a re-processed dump.
- [ ] Commit `feat(ui): item types editor, tone/time chips, trust badge`.

### Task 4: Search everything

**Files:** modify `app/routes.py` (`/search`), `static/js/views/search.js`, `tests/test_search.py`.

- [ ] Test: a dump whose item content contains "dentist" but whose body does not → `/search?q=dentist` returns the dump with `matched_items=[{id, kind, content}]`.
- [ ] Route: FTS query over `items_fts`, merge into `results[dump_id]["matched_items"]`, `via` gains `"items"`.
- [ ] UI: under each result card list matched items as `kind · content` lines.
- [ ] Commit `feat(search): match items too (search everything)`.

### Task 5: Backup, restore, vault location

**Files:** create `app/vault.py`, `tests/test_vault.py`; modify `app/db.py` (`vault_dir()`, `reopen()`), `app/routes.py`, `static/js/views/settings.js` (Data section), `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json` (dialog plugin).

**Interfaces:** `db.vault_dir()` (pointer file `<data>/vault-location.txt` → that dir, else `data_dir()`), `db.db_path()`, `db.reopen()`; `vault.backup_zip() -> bytes`, `vault.restore_zip(bytes)`, `vault.move(new_dir: str)`; routes `GET /backup`, `POST /restore` (UploadFile), `GET /vault → {dir, db_path, size_bytes}`, `POST /vault/move {path}`; `/status.vault_dir`.

- [ ] Tests: backup zip contains `braindump.db` that opens and passes `integrity_check`; restore with a zip lacking the file → ValueError; restore with a good zip replaces rows (dump count changes); move copies the DB into a temp dir, writes the pointer, `db_path()` points there, data still readable; move to a non-writable/invalid path raises.
- [ ] `db.py`: `_conn` swap under `_lock`; `reopen()` closes and clears `_conn`; `conn()` uses `db_path()`.
- [ ] `vault.py`: backup via `sqlite3.Connection.backup()` into a temp file → zip in memory; restore: extract to temp, `integrity_check`, `reopen()` after replacing (Windows: close first, `os.replace`); move: checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`), copy, write pointer, `reopen()`; never delete the old file.
- [ ] Tauri: add `tauri-plugin-dialog = "2"`, `.plugin(tauri_plugin_dialog::init())`, capability `dialog:allow-open`; JS: `native.dialog.open({ directory: true })`.
- [ ] Settings → Data: buttons Download backup (`<a href="/api/backup" download>`), Restore… (file input + confirm + reload), Vault location row with Move… (native picker / text prompt) → POST → toast + refresh status.
- [ ] Commit `feat(vault): one-file backup/restore and movable vault location`.

### Task 6: Release 0.7.0

- [ ] Rebuild nothing locally; run `pytest`, `npm run lint:js`, a Playwright pass over Settings (AI Advanced types editor, Data actions) and a dump detail; `tauri dev` check of the folder picker.
- [ ] `CHANGELOG.md` `## 0.7.0` entry (types you can customize, tone + time estimates, on-device/cloud badge, search finds items, backup/restore, move your vault).
- [ ] Merge to master, `.\release.ps1 0.7.0`.
