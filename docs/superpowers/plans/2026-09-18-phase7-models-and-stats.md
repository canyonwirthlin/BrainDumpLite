# Phase 7: Models & Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase7-models-and-stats-design.md`.

**Architecture:** `catalog/models.json` (bundled + remote-refreshed, cached in settings) feeds `engine.CHAT_MODELS()`; `app/stats.py` summarises `runs` and samples `stats_daily` at boot; Gemini is a new entry in `ai.DEFAULTS`. Frontend: Gemini card, model browser controls, Stats section.

### Task 1: Backend
- [x] `catalog/models.json` seeded from the old hardcoded list + prices; `app/catalog.py` (bundled → remote → cache → bundled fallback, validated); `engine` reads the catalog, generic `recommended_id`; `ai` gemini provider + embeddings; `stats_daily` table + `stats.summary`; routes `/catalog`, `/stats`; `build-backend.ps1` bundles `catalog/`; tests.
- [x] Commit `feat: Gemini provider, curated model catalog, stats summaries (backend)`.

### Task 2: Frontend
- [x] Gemini provider card; model browser (search, VRAM chips, tags, refresh); Settings → Stats (tiles, single-hue bars, tables, 7/30/90 range); palette section list.
- [x] Browser verification; commit `feat(ui): model browser, Gemini card, Stats section`.

### Task 3: Release 0.11.0
- [ ] Changelog, merge, `.\release.ps1 0.11.0`.
