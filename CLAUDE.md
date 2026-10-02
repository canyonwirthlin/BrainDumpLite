# BrainDump Lite — working notes

Stack: Python/FastAPI backend (`app/`), vanilla-JS frontend with no build step (`static/`), Tauri shell (`src-tauri/`), SQLite vault. Schema lives in `app/db.py` (`SCHEMA` + additive `_migrate()`); there is no migration framework.

## Commands
- Tests: `.venv/Scripts/python -m pytest -q` (≈45 s, 160+ tests)
- Lint (JS syntax check): `npm run lint:js`
- Typecheck: none exists (Python/JS untyped); the lint + tests are the gate. Rust: `cargo check --manifest-path src-tauri/Cargo.toml --filter-platform` is CI-only here — don't run it.
- Run from source against a sandbox vault: `.\dev.ps1` (see DEVELOPING.md). Never touch the real vault.

## 34-feature batch: rules for parallel agents
- Work in your own git worktree on branch `feat/<agent-name>`, branched from `integration` as it stands when your wave starts.
- Only edit files for your assigned features. A shared-file edit (`app/main.py`, `static/js/router.js`, `shell.js`, `settings.js`, `tasks.js`, `app/routes.py`) must be minimal and listed in your report. No reformatting or refactors of unrelated code.
- Put new endpoints in your own module (`app/routes_<name>.py`) and add one `include_router` line in `app/main.py`; put new UI in its own `static/js/views/<name>.js`. This keeps merges clean.
- Schema was done once in Phase 0 (`app/db.py`). Do NOT add migrations; if you need a schema change, say so in your report instead.
- Use a distinct data dir and port per worktree: `BRAINDUMP_LITE_DATA=<worktree>/.data` and a unique port. Tests already use temp dirs.
- One commit per feature, clear message. Run pytest + `npm run lint:js` before each commit. Add tests for new logic (tests/test_<name>.py).
- Commit with `git -c core.safecrlf=false`. Never push, never tag, never run release.ps1, never download models (use catalog metadata only).
- Final report: shipped, files touched, shared files edited, incomplete / needs-decision.

## Schema added in Phase 0 (already in `app/db.py`)
dumps: `pinned`, `is_private`, `deleted_at`, `merged_into`; dumps.status may be `queued`. items (tasks): `pinned`, `folder_id`, `recurrence` (JSON), `tags` (JSON), `actual_minutes` (est_minutes, snoozed_until pre-existed). Tables: `task_folders`, `saved_searches`, `recent_searches`, `dump_merges` (habits/habit_log pre-existed). Settings keys are free-form JSON in `settings`: `journal_prompt_enabled` and `backup` already exist.
