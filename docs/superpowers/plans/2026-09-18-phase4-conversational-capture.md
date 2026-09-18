# Phase 4: Conversational Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase4-conversational-capture-design.md`: streaming Therapy/Brainstorm sessions with live item previews that collapse into a dump, plus the app lock and the idle nudge.

**Architecture:** `app/sessions.py` owns session state and streaming replies (SSE via `StreamingResponse`); `app/personas.py` holds the prompts; `app/lock.py` + a middleware in `main.py` gate the API while locked. Frontend adds `views/session.js`, a lock overlay in `shell.js`, and the Data-section controls. Tauri gains `tauri-plugin-notification`.

**Tech Stack:** unchanged; SSE over fetch + `ReadableStream` in the browser.

## Global Constraints

- Works with the built-in 3B model within a 4k context: session prompts keep the last 12 turns; extract-lite is ≤ 300 completion tokens with a strict schema.
- Ending a session reuses the Phase 3 pipeline unchanged; the dump's `mode` is the session mode so the existing expand persona still runs.
- Lock state lives in process memory + a settings row; no plaintext passphrase is ever stored.
- Every task: pytest green, `npm run lint:js`, a browser check, commit.

---

### Task 1: Backend — personas, streaming, sessions, lock
**Files:** create `app/personas.py`, `app/sessions.py`, `app/lock.py`, `tests/test_sessions.py`, `tests/test_lock.py`; modify `app/ai.py` (`chat_stream`), `app/db.py` (schema), `app/routes.py` (sessions + lock routes, status fields), `app/main.py` (lock middleware).
- [ ] Tests: start → message stream (fake `ai.chat_stream` yields "Hel","lo") → transcript has user+assistant; extract_lite stores preview items; end → dump exists with `mode=="therapy"`, raw text `You: … / AI: …`, session `ended` with `dump_id`; `list_open` excludes ended; delete cascades. Lock: set (min 4 chars), verify, wrong passphrase, clear with wrong → ValueError, middleware 423 while locked, 200 after unlock, `/api/status` always allowed.
- [ ] `ai.chat_stream(system, messages, max_tokens=400, temperature=0.7)` → generator of text deltas (builtin: `engine.ensure_chat_running()` first; provider param rules copied from `chat`; `stream=True`).
- [ ] Schema `sessions`, `session_items`; routes; `/status` gains `locked`, `lock_set`, `last_dump_at`.
- [ ] Commit `feat(sessions): streaming therapy/brainstorm sessions, live preview items, app lock`.

### Task 2: Frontend — session view, capture entry, history rows
**Files:** create `static/js/views/session.js`; modify `static/js/main.js` (route), `static/js/views/capture.js` ("Talk it through →" for therapy/brainstorm), `static/js/views/history.js` (open sessions on top), `static/css/views.css`, `static/css/shell.css` (`.split.right`).
- [ ] `session.js`: transcript bubbles, streaming bubble, input (Ctrl+Enter, mic), right panel "Noticed so far" polled every 3 s during a turn, header slot "End & save" / "Discard".
- [ ] SSE client: `fetch` POST, `res.body.getReader()`, parse `data:` lines, append deltas.
- [ ] Verify live with the built-in model: start a therapy session, two turns, preview items appear, end → History detail shows the dump with mode Therapy.
- [ ] Commit `feat(ui): conversational capture sessions`.

### Task 3: App lock + idle nudge (shell, settings, Tauri notification plugin)
**Files:** modify `static/js/shell.js` (overlay + idle timer), `static/js/views/settings.js` (Data → App lock, Notifications), `static/js/native.js` (nudge), `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `static/css/shell.css`.
- [ ] Overlay when `status.locked`; unlock form; idle timer 10 min → `POST /lock/now` + overlay; Ctrl+K/N disabled while locked.
- [ ] Settings → Data: set/change/remove passphrase; "Nudge me when I haven't captured anything for 3 days" toggle (localStorage `bdl-nudge`).
- [ ] `native.js`: on boot, if `bdl-nudge` on and `status.last_dump_at` older than 3 days → notification via `__TAURI__.notification` (request permission first).
- [ ] `cargo check`; browser check of lock flow (set → lock now → overlay → unlock).
- [ ] Commit `feat: app lock and idle nudge`.

### Task 4: Release 0.8.0
- [ ] `CHANGELOG.md` entry, tick plan, merge to master, `.\release.ps1 0.8.0`.
