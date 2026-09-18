# BrainDump Lite

A standalone, send-to-a-friend version of BrainDump. One exe, no Docker, no
Postgres, no Neo4j, no LM Studio requirement — the friend picks how the AI runs:

| Provider | What they need | Embeddings (semantic search) |
|----------|----------------|------------------------------|
| **Built-in** | Nothing — app downloads llama.cpp + a GGUF picked by VRAM (see `app/engine.py`) | ✓ (nomic-embed, CPU-only second server) |
| **Claude** | Anthropic API key (via Anthropic's OpenAI-compat endpoint) | ✗ → keyword-search fallback |
| **OpenAI** | OpenAI API key | ✓ (`text-embedding-3-small`) |
| **Self-hosted** | Any OpenAI-compatible server URL (LM Studio, Ollama) | ✓ if they set an embed model |
| **Off** | Nothing | app still works, dumps stored raw |

Voice is always local (faster-whisper, CPU) — audio never leaves the machine.

## Architecture (vs. big BrainDump)

- **SQLite** (one file in `%LOCALAPPDATA%\BrainDumpLite`) replaces Postgres + pgvector + Neo4j.
  Embeddings live as JSON columns, cosine similarity in pure Python, keyword search
  via SQLite **FTS5**. Fine up to thousands of dumps.
- **Vanilla-JS SPA** (`static/`) replaces Next.js — no node, no build step, served
  straight by FastAPI on the same port.
- **Sync SQLite + threadpool** replaces async SQLAlchemy — the pipeline still runs
  as a FastAPI BackgroundTask.
- **Kept**: capture (text+voice, 4 modes), pipeline (cleanup→classify→expand→embed→link,
  same prompts incl. the weekday→date table + people/concepts extraction),
  review/approve, tasks, search, reflect, and an Obsidian-style **brain map**
  (force-directed canvas graph of dumps/concepts/people — ~200 lines of vanilla
  JS physics, no graph DB, no chart library).
- **Cut**: week planner, Google Calendar, Todoist, habits, templates,
  admin hot-swap, live dictation. See `RECOMMENDATIONS.md` for the port-back list.

## Dev

```powershell
.\dev.ps1                 # backend + UI in your browser (fastest loop, no Rust needed)
.\build-backend.ps1       # freeze the backend into src-tauri\backend\ (needed by the two below)
npm run tauri dev         # the real native window + tray, debug build
npm run tauri build       # local installer: src-tauri\target\release\bundle\nsis\
.\.venv\Scripts\python -m pytest -q        # Python tests
cd src-tauri; cargo test                   # Rust tests
```

One-time: Rust (`rustup`, MSVC Build Tools with the C++ workload) and `npm install`.
After rebuilding the backend with changed `static/` files, WebView2 may keep serving its
cached JS/CSS (same `?v=` cache-buster) — clear `%LOCALAPPDATA%\com.canyonwirthlin.braindumplite`
or bump the `?v=` in `static/index.html` while iterating.
If `tauri dev` fails with `Access is denied (os error 5)` while copying resources, delete
`src-tauri	arget\debugackend` and run it again.
Data dir override for testing: set `BRAINDUMP_LITE_DATA=<path>`.

## Release

1. Write a `## X.Y.Z — date` section at the top of `CHANGELOG.md`. This is the
   release notes on GitHub and the "What's New" panel in the app.
2. `.\release.ps1 [patch|minor|major|X.Y.Z]` — bumps every version file,
   commits, tags, pushes.
3. GitHub Actions builds the installer and publishes the release. Installed
   apps see it on next launch and offer "Install and restart".

The updater only needs a static `latest.json` URL (`src-tauri/tauri.conf.json`
→ `plugins.updater.endpoints`); GitHub Releases hosts it today. Update
artifacts are signed with a minisign key (`TAURI_SIGNING_PRIVATE_KEY` +
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as GitHub Actions secrets); the public
half lives in `tauri.conf.json`.

## Repo layout

```
run.py                # backend entry (sidecar of the native shell, or standalone)
app/                  # FastAPI backend
  main.py             # app factory, static mount
  db.py               # SQLite schema + helpers (settings/dumps/items/links/FTS)
  ai.py               # provider abstraction — ALL LLM/embedding calls go through here
  engine.py           # built-in AI: downloads + manages llama.cpp servers
  pipeline.py         # cleanup→classify→expand→embed→link (graceful no-AI fallback)
  transcribe.py       # faster-whisper, lazy, optional
  routes.py           # every API route
  launch.py           # sidecar helpers: port, log file, parent watchdog
  changelog.py        # CHANGELOG.md parser -> /api/changelog
static/               # vanilla-JS SPA, served by the backend (no build step)
  js/                 # ES modules: main, shell (rail/top bar), palette, theme, router, views/*
  css/                # tokens.css (theme tokens), shell.css (layout), views.css
shell-ui/             # splash page + icon source for the native window
src-tauri/            # Tauri 2 shell (Rust): window, tray, sidecar spawn, updater
build-backend.ps1     # PyInstaller -> src-tauri/backend/
release.ps1           # version bump + tag; CI (.github/workflows/release.yml) does the rest
```
