# Phase 6 — Markdown Export / Interop

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to decide
and proceed; decisions flagged inline. Brief: `2026-09-18-phases-3-9-design-briefs.md`
(Phase 6 + cross-cutting rows: recurring importer, vault sync, multiple vaults).

## Goal

Your data is never stuck in the app: export any dump or the whole vault as
Obsidian-compatible markdown with `[[wikilinks]]`, write `[[wikilinks]]` in the editor
with autocomplete, import a folder of markdown notes, keep several vaults and switch
between them, and optionally push a readable markdown mirror of the vault to a git repo.

## Decisions (flagged)

- **Markdown format:** one file per dump, `YYYY-MM-DD HHMM <title>.md`, YAML frontmatter
  (`id, created, mode, tone, provider, concepts, people`), then `# Title`, the summary
  bullets, `## Items` as a task list (`- [ ]`/`- [x]` for tasks, `- ` for the rest, with
  `(~30m, urgency 2, due 2026-09-25)` suffixes when present), `## Reflection`, and the
  clean text under `## Text`. Concepts/people render as `[[Name]]` when wikilinks are on
  (default on, toggle in the export UI), plain names otherwise.
- **Editor wikilinks:** typing `[[` in the Capture editor (and the Today quick box) opens
  an autocomplete of concepts, people and dump titles. Saved text keeps the syntax; the
  pipeline treats `[[x]]` as an explicit concept (or person if it matches a known person)
  and adds it to the dump's list even if the model misses it.
- **Importer:** markdown files only (`.md`, `.txt`). Each file → one dump: title = first
  `# heading` or filename, `created_at` = frontmatter `created`/`date` or file mtime, text =
  body without frontmatter; `[[links]]` are honoured. Processing runs through the normal
  pipeline in a background queue, one at a time (local models are single-flight anyway).
  Re-importing a file with the same `id` frontmatter (our own export) is skipped.
- **Multiple vaults:** a `profiles.json` in the default data dir lists `{name, dir}`; the
  active one is the existing `vault-location.txt` pointer. Switching = repoint + reopen.
  "Create vault" = empty DB in a new folder. The default location is always listed as
  "Default".
- **Vault sync:** two flavours, both in Settings → Data:
  1. Cloud folder: just move/create the vault inside Dropbox/OneDrive/Drive (copy text).
  2. Git mirror: point at a folder that is a git repo (user creates it, `git` must be on
     PATH); "Sync now" exports all dumps as markdown into `<repo>/dumps/`, writes a
     `braindump-backup.zip`, then `git add -A && git commit -m … && git push`. Output of
     git is shown verbatim. No auto-sync in this phase.

## Backend

- `app/export_md.py`: `dump_markdown(dump_id, wikilinks=True) -> (filename, text)`,
  `vault_markdown_zip(wikilinks) -> bytes`, `write_all(dir, wikilinks)`.
- `app/import_md.py`: `parse_file(name, text, mtime) -> {title, text, created_at, id?}`,
  `import_files(files) -> {imported, skipped}`, a queue thread that runs `run_pipeline`.
- `app/wikilinks.py`: `extract(text) -> list[str]`; pipeline merges them into concepts/people
  before classify.
- `app/profiles.py`: `list()`, `add(name, dir)`, `create(name, dir)`, `switch(name)`,
  `remove(name)`, `active()`.
- `app/gitsync.py`: `configure(repo_dir)`, `status()`, `sync_now(message) -> log`.
- Routes: `GET /dumps/{id}/markdown?wikilinks=1`, `GET /export/markdown.zip?wikilinks=1`,
  `POST /import/markdown` (multipart, many files), `GET /import/status`,
  `GET /profiles`, `POST /profiles/add|create|switch|remove`, `GET /gitsync`,
  `POST /gitsync/configure`, `POST /gitsync/now`, `GET /wikilinks/suggest?q=`.

## Frontend

- Capture + Today editors: `[[` autocomplete popover (arrow keys, Enter, Esc).
- Dump detail: "Export .md" button. Settings → Data: **Export** (all dumps zip, wikilinks
  toggle), **Import** (file picker, multiple; progress text), **Vaults** (list with
  Switch/Remove, Add existing, Create new), **Git mirror** (repo folder, Sync now, log).
- Search results and History unchanged.

## Testing

pytest: markdown rendering (frontmatter, tasks, wikilinks on/off), zip contains one file per
dump; import parses frontmatter dates and headings, skips own exports by id, queues the
pipeline; wikilink extraction and pipeline merge; profiles add/switch/create/remove with
pointer + reopen; gitsync with a temp `git init` repo (skipped when git is missing).

## Release: 0.10.0
