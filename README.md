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
.\dev.ps1        # venv + deps + run from source (http://127.0.0.1:8756)
```

Data dir override for testing: set `BRAINDUMP_LITE_DATA=<path>`.

## Build & ship

```powershell
.\build.ps1              # → BrainDumpLite-win64.zip (with voice)
.\build.ps1 -NoVoice     # smaller zip, no mic button
```

Send the zip. Friend unzips, double-clicks `BrainDumpLite.exe`, follows
`READ ME FIRST.txt`. SmartScreen will warn once (unsigned exe) — the readme
tells them about "More info → Run anyway".

## Repo layout

```
run.py              # entry point: free port, open browser, uvicorn
app/
  main.py           # app factory, static mount
  db.py             # SQLite schema + helpers (settings/dumps/items/links/FTS)
  ai.py             # provider abstraction — ALL LLM/embedding calls go through here
  engine.py         # built-in AI: downloads + manages llama.cpp servers (stdlib only!)
  pipeline.py       # cleanup→classify→expand→embed→link (graceful no-AI fallback)
  transcribe.py     # faster-whisper, lazy, optional
  routes.py         # every API route
static/             # index.html + app.js + style.css (no build step)
```
