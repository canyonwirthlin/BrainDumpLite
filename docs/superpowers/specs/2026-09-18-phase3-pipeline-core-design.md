# Phase 3 — Pipeline Core Upgrades

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to
decide and proceed through the remaining phases; decisions are flagged inline.
Brief: `2026-09-18-phases-3-9-design-briefs.md` (Phase 3 + the cross-cutting rows
assigned to Phase 3: full-vault search, backup/restore, trust indicator, vault location).

## Goal

Make the pipeline structured and observable so Phases 4-9 can build on it: a
customizable extractable-type schema, time-relevance and tone captured per dump/item,
per-call instrumentation, a local-vs-cloud trust marker, "search everything", one-file
backup/restore, and vault location control. No new capture modes, no new views.

## Decisions (flagged)

- **Tone = fixed label + scores**, extracted inside the existing classify call (no extra
  model call; local models have a 4k budget). Labels: `calm, hopeful, excited, neutral,
  reflective, anxious, frustrated, overwhelmed, low`. Scores: `valence` −2..2, `energy` 0..2.
- **Time-relevance fields ride in the classify call too:** per item `estimated_minutes`
  (5/15/30/60/120/240 buckets or null), `urgency` 0-3, `time_hint` (the raw phrase). Per
  dump `captured_local` (ISO local time with offset). The prompt already carries the
  local date table; it gains "time of day" so urgency can use it.
- **Types are rows, not code.** `item_types` seeds today's six kinds as built-ins
  (renamable, recolorable, cannot be deleted or disabled) and allows custom types.
  The classify prompt and the strict JSON schema enum are generated from enabled rows.
- **Instrumentation is a table (`runs`) written by the pipeline**, one row per model
  call, tokens from the provider's `usage` when present. No UI in this phase
  (Phase 7's Stats tab reads it). `dumps.provider` records which provider processed the
  dump → the trust badge.
- **Backup = the SQLite file.** `GET /api/backup` streams a consistent copy made with
  the SQLite backup API; restore swaps the file after `PRAGMA integrity_check`.
  Models/engine are not part of the vault and are never backed up.
- **Vault location = where `braindump.db` lives.** A pointer file
  `<default data dir>/vault-location.txt` overrides it. Moving copies the DB (with a
  checkpoint) and reopens the connection in place, no restart. Engine/models stay in
  the default data dir.
- **Search everything** = the existing dump search plus item matches (FTS over items)
  merged into the same result list, with matched items listed under their dump.

## Schema (additive migrations in `db._migrate`)

```sql
CREATE TABLE IF NOT EXISTS item_types (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,            -- CSS color token name (accent|green|amber|red|blue|dim) or #hex
  hint TEXT NOT NULL DEFAULT '',  -- one-line rule shown to the model
  builtin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
-- seeded: task, goal, idea, concern, event, note (builtin=1) with today's prompt rules as hints
ALTER TABLE dumps ADD COLUMN captured_local TEXT;   -- ISO local time with offset
ALTER TABLE dumps ADD COLUMN tone TEXT;             -- JSON {label, valence, energy}
ALTER TABLE dumps ADD COLUMN provider TEXT;         -- builtin|local|openai|anthropic|off
ALTER TABLE items ADD COLUMN est_minutes INTEGER;
ALTER TABLE items ADD COLUMN urgency INTEGER;       -- 0 none, 1 low, 2 soon, 3 now
ALTER TABLE items ADD COLUMN time_hint TEXT;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, dump_id TEXT, stage TEXT NOT NULL, provider TEXT, model TEXT,
  started_at TEXT NOT NULL, ms INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
  ok INTEGER NOT NULL, error TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(item_id UNINDEXED, dump_id UNINDEXED, body);
```

## Backend modules

- `app/item_types.py`: `seed()`, `enabled() -> list[dict]`, `all() -> list[dict]`,
  `create(label, icon, color, hint) -> dict` (id = slug of label, must not collide),
  `update(id, **fields)`, `delete(id)` (custom only; items of that kind become `note`),
  `prompt_rules() -> str`, `enum() -> list[str]`.
- `app/instrument.py`: `record(dump_id, stage, provider, model, ms, usage, ok, error)`;
  `ai.chat`/`ai.embed` set `ai.last_usage` (thread-local) from `resp.usage`; the pipeline
  wraps each stage in `instrument.timed(dump_id, stage)` (context manager that writes the
  row with whatever `last_usage` holds).
- `app/pipeline.py`: builds `_CLASSIFY_SYSTEM`/schema from `item_types` at run time;
  parses tone/time fields; stores `provider`, `captured_local`, `tone`; indexes items in
  `items_fts`; writes `runs`.
- `app/vault.py`: `backup_to(path)`, `restore_from(zip_path)`, `location()`, `move(path)`.
- Routes: `GET/POST /item-types`, `PUT/DELETE /item-types/{id}`; `GET /backup`
  (zip attachment `braindump-backup-YYYY-MM-DD.zip`), `POST /restore` (multipart zip),
  `GET /vault`, `POST /vault/move {path}`; `GET /search?q=` returns `matched_items`;
  `GET /dumps/{id}` and lists include `tone`, `provider`, `captured_local`, item
  `est_minutes/urgency/time_hint`; `GET /status` includes `vault_dir`.

## Frontend

- Item `kind` badge takes its color/label from `/api/item-types` (cached in `state.types`);
  unknown kinds fall back to `note` styling.
- Detail + History rows: tone chip (label, colored by valence), trust badge
  ("on-device" green / "cloud" amber / "raw" grey) from `provider`.
- Item rows: `est_minutes` chip ("~30m") and urgency dot (3 = red, 2 = amber) when present.
- Settings → AI → Advanced: **Extraction types** editor (list with color swatch, label,
  hint; add / rename / recolor / enable toggle; delete for custom).
- Settings → Data: **Backup** (download), **Restore…** (file picker + confirm), **Vault
  location** (path + "Move…": native uses `__TAURI__.dialog.open({directory:true})`,
  browser uses a text field).
- Search: results show matched items under the dump card.
- Palette: no change.

## Testing

pytest with a fake AI (`monkeypatch` `ai.available/chat/chat_json/embed`): pipeline end
to end stores tone/time/provider and `runs` rows; item_types CRUD + prompt/enum generation
+ delete fallback to `note`; search returns item matches; backup produces a zip with a
valid DB; restore rejects a bad file and applies a good one; vault move relocates the DB
and the pointer file. Browser checks via Playwright for the editor, badges and Data actions.

## Release: 0.7.0
