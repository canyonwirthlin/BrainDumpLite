# Phase 8 — Task & Calendar Integrations + AI Suggestions Inbox

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to decide
and proceed; decisions flagged inline. Brief: `2026-09-18-phases-3-9-design-briefs.md`
(Phase 8 + the cross-cutting "Unified AI Suggestions inbox").

## Goal

Google Calendar and Todoist as push targets, gated by a single clean inbox where every
AI-proposed action waits for a yes/no/edit; plus a daily plan that looks at the real
calendar and the task backlog together.

## Decisions (flagged)

- **The inbox comes first and everything routes through it.** A `suggestions` table holds
  every proposed action (`calendar_push`, `todoist_push`, later `node_type` and plugin
  actions). Nothing is ever pushed silently: accept = execute, dismiss = forget, edit =
  change title/date before accepting. Rail gets an **Inbox** item with a pending count badge.
- **Google OAuth needs an OAuth client that only Canyon can register** (Google Cloud
  Console → "Desktop app" client). The app ships the mechanism — one-click "Sign in with
  Google" using PKCE + a loopback redirect on the app's own port — and reads the client id
  and secret from Settings → Integrations → Advanced until Canyon bakes a default pair into
  `catalog/integrations.json`. Tokens are stored encrypted at rest with Windows DPAPI
  (`CryptProtectData`, stdlib `ctypes`); on other platforms they fall back to the DB with a
  visible warning. Scopes: `calendar.readonly` + `calendar.events`. No SDK; plain HTTPS.
- **Todoist uses a personal API token** (Settings → Integrations, pasted from Todoist's
  Integrations page). REST v2 `POST /tasks`.
- **Producers:** when a dump finishes processing, each `task`/`event` item with a due date
  becomes a `calendar_push` suggestion if Calendar is connected; each `task` becomes a
  `todoist_push` suggestion if Todoist is connected (max 10 per dump). Manual: "Send to…"
  buttons on any task create a suggestion too (already-confirmed intent → executes at once).
- **Daily plan:** Reflect → "Plan my day": today's (or tomorrow's) calendar events + the
  open task backlog (approved, not done, sorted by urgency then estimate) go to one model
  call that proposes what to put in the free gaps. The result is a list of `{start, end,
  task}` slots; each has "Add to Calendar" which creates a suggestion. Without Calendar
  connected the plan uses a 9:00–18:00 default day with no events.
- **Push-only, no two-way sync.** Calendar events created by the app are tagged in their
  description; nothing is read back except free/busy for planning.

## Schema

```sql
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL,   -- JSON
  source TEXT, item_id TEXT, dump_id TEXT, status TEXT NOT NULL DEFAULT 'pending',      -- pending|accepted|dismissed|failed
  result TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
```

## Backend

- `app/secrets.py`: `protect(str) -> str`, `unprotect(str) -> str` (DPAPI on Windows, plain
  with `plain:` prefix elsewhere); `set_secret(key, value)`, `get_secret(key)`.
- `app/suggestions.py`: `create(kind, title, payload, source, item_id, dump_id)`,
  `pending()`, `accept(id, edits=None)` → runs the kind's executor, `dismiss(id)`,
  `count_pending()`; executors registry `{kind: fn(payload) -> result}`.
- `app/google_cal.py`: `auth_url(port)` (PKCE), `handle_callback(code, state)`, `connected()`,
  `disconnect()`, `events(day)`, `create_event(title, start, end|all_day, description)`.
- `app/todoist.py`: `connected()`, `set_token(t)`, `create_task(content, due, description)`.
- `app/planner.py`: `plan(day) -> {events, slots, proposal}` (one `ai.chat_json` call with a
  strict schema of `{slots: [{start, end, task_id, reason}]}`).
- Pipeline hook: after `status='ready'`, `suggestions.from_dump(dump_id)`.
- Routes (`/api`): `GET /suggestions`, `POST /suggestions/{id}/accept {edits?}`,
  `POST /suggestions/{id}/dismiss`; `GET /integrations` (status of both),
  `POST /integrations/google/start` → `{url}`, `GET /oauth/google/callback` (non-API,
  renders a tiny "you can close this tab" page), `POST /integrations/google/disconnect`,
  `POST /integrations/todoist {token|null}`, `POST /items/{id}/send {target}`,
  `GET /plan?day=YYYY-MM-DD`, `POST /plan/accept {slot}`; `/status` gains `inbox_pending`.

## Frontend

- Rail: **Inbox** (between Tasks and Graph) with a pending badge; `views/inbox.js` lists
  suggestion cards grouped by kind with Accept / Edit (inline title + date) / Dismiss, and a
  "dismiss all" for a kind.
- Settings → **Integrations** section: Google Calendar card (Sign in with Google → opens the
  system browser; shows the connected account; Disconnect), Todoist card (token field),
  Advanced: Google client id/secret fields.
- Tasks rows: "Send to…" menu (Calendar / Todoist) when connected.
- Reflect: "Plan my day" card with day toggle (today/tomorrow), the proposal, and per-slot
  "Add to Calendar".

## Testing

pytest with fakes: suggestions lifecycle (create → accept runs executor → status/result;
dismiss; failed executor → `failed` with message); pipeline creates suggestions only when
a target is connected; DPAPI round trip (Windows) / plain fallback; Google auth URL has
PKCE + state, callback rejects a bad state, token exchange stored via a fake HTTP; Todoist
push with a fake HTTP; planner with fake calendar + fake AI returns slots. Browser: inbox
cards, integrations section, plan card.

## Release: 0.12.0
