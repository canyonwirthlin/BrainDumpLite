# Phase 5: Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase5-knowledge-graph-design.md`.

**Architecture:** New backend module `app/graph.py` (types, nodes/edges, concept/people browsers, backlinks, today, resurface) wired into routes; frontend: graph legend from the API + item nodes + focus mode, a browser view, backlinks card, Today view, Reflect card.

## Global Constraints
- No schema changes except none needed; everything is computed from existing tables.
- Item nodes are opt-in per device; default legend = dump/concept/person on.
- Each task: pytest, lint, browser check, commit.

### Task 1: Backend graph module + endpoints
**Files:** create `app/graph.py`, `tests/test_graph.py`; modify `app/routes.py` (`/graph` uses the module; new endpoints).
- [x] Tests: `types()` = dump/concept/person + enabled item types; `build(items=True)` adds item nodes + `in` edges; `concepts()` counts case-insensitively; `for_concept("Work Fog")` returns the dump; `backlinks(id)` returns similar + via_concepts; `today(date)` filters by local day; `resurface()` prefers same-day and caches (setting `resurface:<date>`).
- [x] Implement + routes; commit `feat(graph): types, item nodes, concept/people browsers, backlinks, today, resurface`.

### Task 2: Graph view — API legend, item nodes, focus mode, navigation
**Files:** modify `static/js/views/graph.js`, `static/css/views.css`.
- [x] Legend chips from `/graph/types` with persisted hidden set; item nodes small (r 4); `Focus` chip; concept/person click → `#graph/concept/<name>`; item click → dump; info box "Open" link.
- [x] Commit `feat(ui): graph legend from types, item nodes, focus mode`.

### Task 3: Browser view + backlinks
**Files:** create `static/js/views/browse.js`; modify `static/js/main.js` (route `graph` sub-paths handled inside graph.render → delegate), `static/js/views/review.js` (chips + Linked-from card), `static/js/views/history.js` (paintDetail loads backlinks).
- [x] Route `#graph/concept/<name>` and `#graph/person/<name>` → browse view (master/detail); header "Show in graph".
- [x] Dump detail: concept/people chips (from dump JSON `concepts`/`people` — add to `_dump_out`) linking to the browser; "Linked from" card from `/dumps/{id}/backlinks`.
- [x] Commit `feat(ui): concept/people browser and backlinks`.

### Task 4: Today stream + resurfacing
**Files:** create `static/js/views/today.js`; modify `static/js/shell.js` (NAV), `static/js/main.js`, `static/js/views/reflect.js`, `static/js/ui.js` (ICONS.today), `static/css/views.css`.
- [x] Today view with quick capture (POST /dumps, then re-render), prev/next day; Reflect "On this day" card.
- [x] Commit `feat(ui): Today stream and on-this-day resurfacing`.

### Task 5: Release 0.9.0
- [ ] Changelog, tick plan, merge, `.\release.ps1 0.9.0`.
