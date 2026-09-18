# Phase 4 — Conversational Capture Modes

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to decide
and proceed; decisions flagged inline. Brief: `2026-09-18-phases-3-9-design-briefs.md`
(Phase 4 + cross-cutting rows assigned to it: idle nudges, PIN/passphrase lock).

## Goal

Therapy and Brainstorm become conversations: the AI replies live while you talk, items are
noticed as you go, and ending the session collapses the transcript into one normal dump that
runs through the Phase 3 pipeline. Plus two small native-shell features: an idle nudge
notification and a local app lock.

## Decisions (flagged)

- **Sessions are a separate table**; a session becomes a dump only when ended. Abandoned
  sessions stay listed (History shows them as "unfinished conversation") and can be resumed
  or ended later.
- **Streaming over SSE** (`text/event-stream`) from FastAPI using the OpenAI client's
  `stream=True`; works for built-in llama.cpp, LM Studio and cloud providers alike.
- **Live extraction is a preview.** After each user turn a small classify-lite call
  (type + content only, strict schema, ≤ 300 tokens) runs in a background thread and
  appends to `session_items`. Ending the session runs the full pipeline on the transcript,
  which produces the authoritative items; the preview is discarded. This keeps the local
  4k-token budget safe and avoids duplicate items.
- **Personas are prompt templates in `app/personas.py`** (therapy, brainstorm), ≤ 120-word
  replies, one question at a time. Freeform/Execution stay one-shot dumps.
- **Voice in sessions** reuses the existing recorder; the transcript lands in the session
  input (push-to-talk per turn).
- **Idle nudge:** on launch, if the newest dump is older than 3 days, the shell shows one
  native notification ("It's been N days — anything on your mind?"); at most once per
  launch, off by default until the user enables it in Settings → Data → Notifications.
- **App lock:** optional passphrase (PBKDF2-SHA256 hash + salt in settings). When set, the
  UI shows a lock overlay at launch and after 10 minutes idle; the backend refuses every
  `/api/*` call except `/status`, `/unlock`, `/changelog` while locked (`423 Locked`).
  Forgotten passphrase = delete `app_lock` from the DB with any SQLite tool (documented);
  there is no recovery by design.

## Schema (additive)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  transcript TEXT NOT NULL DEFAULT '[]',   -- JSON [{role, content, at}]
  dump_id TEXT, status TEXT NOT NULL DEFAULT 'active'   -- active|ended
);
CREATE TABLE IF NOT EXISTS session_items (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
```

## Backend

- `app/personas.py`: `SYSTEM = {"therapy": …, "brainstorm": …}`, `EXTRACT_LITE_SYSTEM`,
  `EXTRACT_LITE_SCHEMA`.
- `app/ai.py`: `chat_stream(system, messages, max_tokens, temperature) -> Iterator[str]`
  (yields text deltas; records usage when the provider sends it in the final chunk).
- `app/sessions.py`: `start(mode)`, `get(id)`, `append(id, role, content)`,
  `reply_stream(id) -> Iterator[str]` (builds messages from the transcript, streams, then
  appends the assistant turn), `extract_lite(id, turn)` (background), `end(id) -> dump_id`
  (formats transcript as `You: …\nAI: …` raw text, inserts the dump with `mode`, runs the
  pipeline via a background thread, marks the session ended), `list_open()`.
- `app/lock.py`: `is_set()`, `set_passphrase(p)`, `clear(p)`, `verify(p)`, `locked` flag
  (process memory), `unlock(p)`, `lock()`; a FastAPI middleware in `main.py` returns 423
  for non-allowlisted routes while locked.
- Routes: `POST /sessions {mode}`, `GET /sessions/{id}`, `GET /sessions?open=1`,
  `POST /sessions/{id}/message {text}` → SSE stream (`data: <delta>` … `event: done`),
  `GET /sessions/{id}/items`, `POST /sessions/{id}/end → {dump_id}`,
  `DELETE /sessions/{id}`; `GET /lock`, `POST /lock/set {passphrase}`,
  `POST /lock/clear {passphrase}`, `POST /unlock {passphrase}`, `POST /lock/now`;
  `GET /status` gains `locked`, `lock_set`, `last_dump_at`.

## Frontend

- Capture: when Therapy or Brainstorm is selected, a second button "Talk it through →"
  starts a session (`#session/<id>`); "Dump it" still works as today.
- `views/session.js` (`#session/<id>`): `.split.right` layout — chat column (bubbles, the
  streaming assistant bubble grows token by token, input textarea with Ctrl+Enter, mic)
  and a 300px right panel "Noticed so far" listing `session_items` (kind badge + content,
  polled every 3 s while streaming). Header slot: mode label, "End & save" (→ ends and
  routes to `#history/<dump>` where the processing view runs) and "Discard".
- History list: open sessions appear at the top as rows with a "conversation" tag and a
  Resume link.
- Lock: `shell.js` mounts a full-screen `#lock` overlay when `status.locked`; unlock form
  posts the passphrase; idle timer (10 min without pointer/keyboard) posts `/lock/now` and
  shows the overlay. Settings → Data → "App lock": set / change / remove passphrase.
- Idle nudge: `native.js` on boot, if `status.last_dump_at` is > 3 days old and the
  preference is on, calls `__TAURI__.notification.sendNotification` (Tauri notification
  plugin, permission `notification:default`). Preference in Settings → Data.

## Testing

pytest with the fake AI: session start → message (stream collected) → transcript has both
turns; extract_lite stores preview items; end creates a dump with mode `therapy` and the
formatted transcript and marks the session ended; lock: set/verify/wrong/clear, middleware
423 while locked and 200 after unlock. Playwright: session UI streaming (fake provider not
possible in the browser → use the built-in model live), right panel, end → history.

## Release: 0.8.0
