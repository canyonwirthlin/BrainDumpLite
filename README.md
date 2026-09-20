# BrainDump Lite

One night, when sitting in my room, I realized that all of my systems for journaling were scattered and messy. What I needed was a way to just dump my brain in an unorganized fashion and get back something that gives me intuitive information about myself and my day-to-day.

I had a distrust of cloud AI and commercially available journaling tools with my private and personal information. That's why I built BrainDump: a local-first "second brain" app where you type or speak an entire dump of whatever is on your mind, and an AI pipeline extracts tasks, events, goals, ideas, concerns, people, concepts and more. It can optionally push to Google Calendar or Todoist, and it runs on your own machine. Nothing leaves it unless you connect a cloud AI or an outside service yourself.

**BrainDump Lite is the single-app version of BrainDump.** It is a Windows desktop app you install with one installer. There is no Docker, no database server and no separate AI program to set up.

## How I built it

As a computer science major in my junior year, I had limited experience developing ambitious projects like this one. I combined the concepts I've learned in school with what I found online to develop a rough tech stack. After designing the architecture, the data model and making the product decisions, I built the app through AI-assisted development rather than writing each line by hand.

This project is still a work in progress. I like to call it a living project, not a finished artifact that I'm walking away from.

## Who uses it?

My goal is to eventually put this in front of a large user base. When I first started, I built it around Supabase so users could create their own logins, with the intention of hosting it as a web service. Partway through I realized I was tailoring the app to myself, friends and family, so I removed Supabase and turned it into a personal web service, still leaving room to bring multi-user functionality back.

I use BrainDump each night for about 15 minutes before bed.

BrainDump Lite exists for friends and family. It is the same idea packaged so that anyone can install it like any other program, without setting up Docker or a local AI server first. They act as beta testers and give me occasional feedback, and I ship them updates through GitHub Releases: the installed app checks for a new version, shows the release notes ("What's New"), and installs it when they press the button.

## Moving from the Docker service to the single app

The original BrainDump ran as a set of services under Docker Compose. Lite folds all of it into one program, and the whole stack that used to be separate now lives inside the app:

| Original BrainDump (Docker service) | BrainDump Lite (single app) |
|---|---|
| Next.js frontend on port 3000 | Vanilla-JS single-page app (`static/`), no build step, in a native WebView2 window |
| FastAPI on port 8001, async SQLAlchemy | The same FastAPI, synchronous SQLite behind a threadpool, run as a bundled sidecar of a Tauri shell |
| PostgreSQL + pgvector | One SQLite file, with embeddings stored as JSON, cosine similarity in Python and **FTS5** for keyword search |
| Neo4j thought graph (`SIMILAR_TO` edges) | A `links` table in the same SQLite file, drawn as an Obsidian-style brain map on a canvas |
| LM Studio on port 1234 | A built-in llama.cpp engine that the app downloads and manages, with a catalog of models chosen by your hardware (LM Studio, Ollama, Claude, OpenAI and Gemini remain available as providers) |
| faster-whisper | faster-whisper, still local and still CPU |
| `docker compose up`, then a browser tab | An installer, a Start Menu entry, a tray icon and automatic updates |

What that means in practice:

- **Nothing to run first.** No containers, no ports to remember. The backend listens on `127.0.0.1` only, on a free port in the 8756-8780 range, and only the app talks to it.
- **Your data is one folder**, `%LOCALAPPDATA%\BrainDumpLite`, which holds the database, the AI engine and downloaded models, and your plugins. `BRAINDUMP_LITE_DATA` overrides it for testing.
- **There is no automatic import from the Postgres/Neo4j database.** The two versions keep separate data. If you can get old entries out as markdown or text files, Settings -> Data can import them (select as many as you like), and each file runs through the pipeline as a new dump. Going the other way, any dump or the whole vault exports as Obsidian-compatible markdown.
- **Phone access is gone for now.** The Docker version was reachable from a phone on the local network, and I was working toward a PWA for offline capture. Lite is a desktop app that only listens on the machine it runs on.
- **Not ported yet:** habits, templates, per-stage admin settings and live dictation. `RECOMMENDATIONS.md` lists what I'd port back.
- **The confidence gate did not port as-is.** The original flagged low-confidence extractions as "needs clarification". In Lite every extracted item arrives as *suggested*, and you approve or reject it in Review.
- **Coming from the old zip version of Lite?** Just install the new one. It picks up the same data folder, so your dumps, settings and downloaded models carry over.

## What does it do?

A user records or types a raw stream of consciousness:

```
"Today was a crazy day and I got a lot to do tomorrow. I need to go to the grocery store and hang out with Eric. I also just really am kind of bummed because I haven't reached my goal weight of xyz pounds in the gym yet"
```

BrainDump runs it through an AI pipeline and gives you back:

- **Extracted items**: typed and prioritized: tasks ("go to grocery store"), goals ("hit xyz pounds in gym"), ideas, concerns, and any extra types you define yourself, each with an effort estimate, an urgency marker and the time phrase it came from.
- **A tone, people and concepts**: every dump gets a tone (calm, anxious, excited...) and the people and topics it mentions, so you can click "Eric" or "gym" and see every dump that mentions them.
- **A mode-aware response**: execution mode gives you the smallest first step and the procrastination trap; therapy mode reflects the feeling back and digs deeper; brainstorm mode helps you expand your ideas. Therapy and Brainstorm can also run as a live conversation that is saved as one dump when you end it.
- **A thought graph**: each dump is linked to past dumps with similar meaning, so you can see that you've mentioned gym consistency seven times this month.
- **Inbox suggestions**: dated tasks and events are proposed for Google Calendar or Todoist, and nothing is sent until you press the button. "Plan my day" fits your open tasks into the free gaps around your real calendar.

Everything stays local unless you connect a cloud AI or an external service.

## Architecture

```
Tauri shell (Rust): native window, tray icon, updater
    │  spawns
    ▼
FastAPI sidecar on 127.0.0.1 (PyInstaller bundle)
    │   ── serves the vanilla-JS single-page app
    │
    ├── SQLite ─────────────── dumps, items, links, embeddings, FTS5 search
    ├── llama.cpp (built-in) ── chat model + a CPU-only embedding model (nomic)
    │      or Claude / OpenAI / Gemini / any OpenAI-compatible server
    ├── faster-whisper ─────── local voice transcription
    └── MCP servers, plugins ── optional, gated through the Inbox
```

### Choosing how the AI runs

| Provider | What you need | Embeddings (semantic search) |
|----------|---------------|------------------------------|
| **Built-in** | Nothing: the app downloads llama.cpp plus a model you pick | Yes (nomic-embed, CPU-only second server) |
| **Claude** | Anthropic API key | No, falls back to keyword search |
| **OpenAI** | OpenAI API key | Yes |
| **Gemini** | Google AI Studio key (free tier) | Yes |
| **Self-hosted** | Any OpenAI-compatible server URL (LM Studio, Ollama) | Yes, if you set an embed model |
| **Off** | Nothing | The app still works and dumps are stored raw |

The built-in engine has a browsable model catalog (`catalog/models.json`, refreshed from this repo at most once a day). Nothing downloads until you press **Get**. Each entry lists its size, parameter count, quantization, license, the GPU memory it needs, the system RAM a CPU-only run needs, and caveats, and you can filter by VRAM. The catalog only lists models that answer directly: models that think out loud first would burn the response budget. The VRAM and RAM figures are estimates from one size-based formula, not benchmarks.

## AI pipeline

Processing runs in a background thread after a dump is saved. Every stage degrades gracefully, so the app is useful even when the AI is off or fails.

| Stage | What happens |
|---|---|
| **Cleanup** | LLM pass to fix speech artifacts and normalize the transcript |
| **Classify** | One structured call extracts a title, summary, typed items (priority, effort, urgency, time hints), tone, people and concepts |
| **Expand** | A mode-specific prompt (execution / brainstorm / therapy / freeform) writes the response |
| **Embed** | The embedding model turns the dump into a vector |
| **Index and link** | Adds it to the FTS5 index and links it to the most similar past dumps (cosine similarity, with a keyword fallback) |
| **Propose** | Dated items become suggestions in the Inbox; plugins are notified |

How long it takes depends heavily on the model and the hardware.

## Interesting technical designs

**Small models need guardrails.** The built-in models are small, so the app doesn't trust them. The classify call uses a JSON *schema* that llama.cpp compiles into a grammar, so the output is always valid and correctly shaped. Small models love inventing due dates, so a date is kept only if the item's own text contains a time word, and a literal weekday-to-date table is handed to the model instead of asking it to do date arithmetic. If classification fails entirely, a heuristic fallback still saves the dump.

**Nothing leaves without a human press.** Every extracted item starts as *suggested*. Everything that would touch the outside world (Calendar, Todoist, a plugin, an MCP tool) lands in the Inbox first, where you can edit it or reject it.

**Local vs cloud, always visible.** Every dump carries an on-device or cloud badge showing where its text went. Tokens for connected services are encrypted with Windows DPAPI.

**Local-first, not lock-in.** Markdown export with `[[wikilinks]]`, a markdown importer, whole-vault backup and restore, movable vault folders, multiple vaults and an optional Git mirror mean your notes are never stuck inside the app.

**Updates that tell you what changed.** Releases are signed, and the changelog section I write by hand for each release is what the app shows as "What's New" before you install.

### Extending it

- **MCP**: Settings -> Plugins & MCP takes the same `mcpServers` block other desktop clients use. Each tool is hidden from the AI, proposed-and-confirmed, or free to run. Tool output is treated as data, never as instructions.
- **Plugins**: a folder with `plugin.json` plus a Python entry module in `%LOCALAPPDATA%\BrainDumpLite\plugins\`. They run unsandboxed, in-process, and only after you enable them. See `docs/plugins.md` and `examples/plugins/daily-digest/`.
- Anything either one proposes lands in the Inbox and runs only when you press the button.

## Tech stack

- **Shell**: Tauri 2 (Rust), WebView2, NSIS installer
- **Frontend**: vanilla JavaScript ES modules, no build step
- **Backend**: Python, FastAPI, synchronous SQLite (FTS5), packaged with PyInstaller
- **AI**: llama.cpp (built-in), or Claude / OpenAI / Gemini / any OpenAI-compatible server; faster-whisper for local transcription
- **Integrations**: Google Calendar (OAuth with PKCE), Todoist, MCP servers, Python plugins
- **Release**: GitHub Actions builds and signs the installer; the app updates itself from GitHub Releases

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
`src-tauri\target\debug\backend` and run it again.
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

The model catalog is separate from app releases: installed apps re-fetch
`catalog/models.json` from `master` at most once a day, so a catalog-only change
reaches everyone as soon as it is pushed. Keep new fields optional, because older
installs read the same file.

### Checking install counts

The app has no telemetry — nothing about usage is ever sent anywhere. For a
rough sense of reach without tracking anyone, `scripts/install_count.py` reads
the download counts GitHub already publishes for every release asset (public
data about the repo, not about any individual) and prints installer downloads
per release plus total update-check pings:

```
python scripts/install_count.py
```

## Repo layout

```
run.py                # backend entry (sidecar of the native shell, or standalone)
app/                  # FastAPI backend
  main.py             # app factory, static mount
  db.py               # SQLite schema + helpers (settings/dumps/items/links/FTS)
  ai.py               # provider abstraction — ALL LLM/embedding calls go through here
  engine.py           # built-in AI: downloads + manages llama.cpp servers
  catalog.py          # model catalog: bundled copy + daily refresh from master
  pipeline.py         # cleanup→classify→expand→embed→link (graceful no-AI fallback)
  transcribe.py       # faster-whisper, lazy, optional
  routes.py           # every API route
  launch.py           # sidecar helpers: port, log file, parent watchdog
  changelog.py        # CHANGELOG.md parser -> /api/changelog
  suggestions.py      # the Inbox: every proposed action waits here for a human press
  secrets.py          # DPAPI-protected tokens in the settings table
  google_cal.py       # Calendar OAuth (PKCE, loopback) + event push
  todoist.py          # Todoist API v1 push
  planner.py          # "Plan my day": free gaps + backlog -> slots
  mcp_client.py       # stdio JSON-RPC client for MCP servers, per-tool gating
  plugins.py          # folder plugins: loader, narrow API, isolation
catalog/models.json   # curated built-in models: hashes, sizes, hardware tiers, caveats, prices
examples/plugins/     # a working example plugin, bundled with the app
docs/plugins.md       # how to write one
static/               # vanilla-JS SPA, served by the backend (no build step)
  js/                 # ES modules: main, shell (rail/top bar), palette, theme, router, views/*
  css/                # tokens.css (theme tokens), shell.css (layout), views.css
shell-ui/             # splash page + icon source for the native window
src-tauri/            # Tauri 2 shell (Rust): window, tray, sidecar spawn, updater
build-backend.ps1     # PyInstaller -> src-tauri/backend/
release.ps1           # version bump + tag; CI (.github/workflows/release.yml) does the rest
```
