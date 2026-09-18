# Phase 8: Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase8-integrations-design.md`.

**Architecture:** `suggestions` table + module as the single gate; `secrets` (DPAPI); `google_cal` (PKCE OAuth, loopback callback route outside `/api`); `todoist` (token); `planner`. Pipeline hook creates suggestions for connected targets. Frontend: Inbox view + rail badge, Settings → Integrations, Send-to menu on tasks, Plan-my-day card in Reflect.

### Task 1: Backend
- [ ] Modules + tests; schema; routes (`/suggestions*`, `/integrations*`, `/oauth/google/callback`, `/items/{id}/send`, `/plan*`); `/status.inbox_pending`; pipeline hook.
- [ ] Commit `feat(integrations): suggestions inbox, Google Calendar OAuth, Todoist, daily planner (backend)`.

### Task 2: Frontend
- [ ] `views/inbox.js` + rail item with badge; Settings → Integrations (Google sign-in/disconnect, Todoist token, Advanced client id/secret); Tasks "Send to…"; Reflect "Plan my day".
- [ ] Browser verification with fakes where network is needed; commit `feat(ui): inbox, integrations settings, send-to, plan my day`.

### Task 3: Release 0.12.0
- [ ] Changelog, merge, `.\release.ps1 0.12.0`.
