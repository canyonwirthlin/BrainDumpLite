# Phase 6: Markdown Interop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase6-markdown-interop-design.md`.

**Architecture:** Four small backend modules (`export_md`, `import_md`, `wikilinks`, `profiles`, `gitsync`) + routes; frontend: wikilink autocomplete component, export/import/vaults/git panels in Settings → Data, export button in dump detail.

## Global Constraints
- Export must round-trip through import (same `id` → skipped, not duplicated).
- Imports never block the request: files are stored as pending dumps, the queue processes them.
- Git is optional: every git feature degrades to a clear message when `git` isn't on PATH.
- Each task: pytest, lint, browser check, commit.

### Task 1: Export + wikilinks
- [ ] `wikilinks.extract`, pipeline merge (explicit `[[x]]` → concepts, or people if known), `export_md.dump_markdown`/`vault_markdown_zip`, routes, tests.
- [ ] Commit `feat(export): Obsidian-compatible markdown export with wikilinks`.

### Task 2: Importer + queue
- [ ] `import_md.parse_file/import_files`, queue thread, `POST /import/markdown`, `GET /import/status`, tests.
- [ ] Commit `feat(import): markdown folder importer`.

### Task 3: Profiles + git mirror
- [ ] `profiles.py` (profiles.json + pointer), `gitsync.py` (subprocess git), routes, tests (git test skipped without git).
- [ ] Commit `feat(vault): multiple vaults and git mirror sync`.

### Task 4: Frontend
- [ ] `[[` autocomplete (`static/js/wikilinks.js`) on Capture + Today editors; dump detail Export .md; Settings → Data: Export, Import, Vaults, Git mirror panels.
- [ ] Browser verification; commit `feat(ui): markdown export/import, wikilink autocomplete, vaults, git mirror`.

### Task 5: Release 0.10.0
- [ ] Changelog, tick plan, merge, `.\release.ps1 0.10.0`.
