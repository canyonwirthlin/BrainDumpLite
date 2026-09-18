# Phases 3–9 — Design Briefs

**Status:** Drafted 2026-09-18 from the roadmap
(`2026-09-17-native-app-migration-roadmap-design.md`) at Canyon's request so the whole
runway is written down. Each brief records what is already decided, a proposed design, the
schema it touches, and the questions to settle in that phase's own brainstorm before its
plan is written. Briefs are inputs to those brainstorms, not substitutes for them: later
phases depend on code that does not exist yet.

**Cross-cutting features are assigned here** (last section) so nothing floats.

---

## Phase 3 — Pipeline core upgrades

**Locked:** time-relevance awareness (capture time, estimated duration, urgency), tone
analysis, concept/people extraction (exists; formalise), customizable extractable-type
schema, instrumentation (timing, tokens, success/fail) built now, displayed in Phase 7.

**Proposed design**
- `item_types` table: `{id, label, icon, color, prompt_hint, builtin, enabled, sort}` seeded
  with today's hardcoded kinds (task, idea, worry, insight, note, …). The classify prompt and
  `_CLASSIFY_SCHEMA` are generated from enabled rows, so Phase 5's user-defined node types
  become extractable by inserting a row.
- New columns on `items`: `est_minutes`, `urgency` (0-3), `time_hint` (raw phrase) and on
  `dumps`: `tone` (JSON: valence, energy, top labels), `captured_local_time`. Time-relevance
  runs as one extra pipeline stage after classify, using the capture timestamp in the prompt.
- `runs` table for instrumentation: `{id, dump_id, stage, provider, model, started_at, ms,
  prompt_tokens, completion_tokens, ok, error}` written by `ai.py` around every call
  (usage from the OpenAI-compatible response; estimated for providers that omit it).
- Settings → AI gains an **Extraction types** editor (Advanced) that edits `item_types`.

**Open questions:** tone label set (fixed list vs free text)? Should urgency feed Tasks
sorting immediately? Keep small-model prompt budget (4096) — which stages merge?

**Depends on:** Phase 2 (settings pattern). **Unblocks:** 4, 5, 7, 8.

---

## Phase 4 — Conversational capture modes

**Locked:** Therapy mode (deeper questioning, therapist-flavoured persona) and Brainstorm
mode (expands ideas); live AI replies during the session; continuous extraction as the
conversation happens; transcript collapses into one simplified dump on end.

**Proposed design**
- `sessions` table `{id, mode, started_at, ended_at, transcript JSON, dump_id}`; a session
  is a chat UI on the Capture stage (mode chips Therapy/Brainstorm switch Capture into
  session mode). Streaming replies via the existing OpenAI-compatible streaming path.
- After each user turn, a background classify pass extracts items into a "live" side panel
  (the right-panel slot reserved by Phase 2), so nothing is lost if the session is abandoned.
- "End session" → summarise transcript into `raw_text`/`clean_text`, create the dump, attach
  the already-extracted items, link `sessions.dump_id`.
- Personas are prompt templates in `app/personas.py`; editable later via Phase 9 plugins.

**Open questions:** voice in sessions (push-to-talk per turn)? Max session length for local
models? Should Freeform/Execution stay non-conversational (yes, proposed)?

**Depends on:** Phase 3 (typed extraction, instrumentation). **Unblocks:** PIN lock urgency.

---

## Phase 5 — Knowledge graph overhaul

**Locked:** Obsidian-style graph, legend at the top; user-customisable node types (add,
rename, recolor) that become pipeline-extractable; concept/people browser; backlinks panel.

**Proposed design**
- Node types come from Phase 3's `item_types` plus the fixed `dump`, `concept`, `person`
  rows; Graph toolbar (Phase 2) grows a "Node types" editor (colour, label, show/hide).
- `links` table already exists; add `link_kind` (mentions, related, backlink) and indexes.
- Browser: `#graph/concept/<id>` and `#graph/person/<id>` routes reuse the master/detail
  shell: left = every dump referencing it, right = the selected dump. Backlinks panel = the
  right-panel slot on any dump/concept/person, listing inbound links.
- Keep the vanilla canvas force layout; add pinning, hover highlight of neighbours, and a
  "focus" mode (selected node + 2 hops).

**Open questions:** performance ceiling (nodes count) before switching to WebGL? Should
concepts merge/alias (e.g. "sleep" vs "sleep schedule")?

**Depends on:** Phase 3 schema. **Unblocks:** Phase 6 wikilinks, resurfacing.

---

## Phase 6 — Markdown export / interop

**Locked:** Obsidian-compatible markdown export of dumps; graph relations become
`[[wikilinks]]` by default (toggleable); `[[wikilink]]` syntax supported in the editor.

**Proposed design**
- `app/export_md.py`: one file per dump (`YYYY-MM-DD <title>.md`) with YAML frontmatter
  (id, mode, created, tone, items) and sections; concepts/people rendered as `[[Concept]]`
  when the toggle is on. Zip download for bulk; single-file download from the dump detail.
- Editor: `[[` autocomplete popover over existing concepts/people/dump titles; saved raw
  text keeps the link syntax; pipeline treats `[[x]]` as an explicit concept mention.
- Settings → Data gains "Export markdown…" with the wikilink toggle (Advanced: folder layout).

**Open questions:** import of markdown edited outside (round trip) — in scope or Phase 9?

**Depends on:** Phase 5 (link kinds). **Pairs with:** recurring importer.

---

## Phase 7 — Model & provider flexibility + Stats tab

**Locked:** Google Gemini free API as a provider; browsable local model catalog that
downloads nothing until picked, curated for hardware fit; Stats tab (inference speed,
token/cost, extraction success, storage growth); depends on Phase 3 instrumentation.

**Proposed design**
- `ai.py` provider table gains `gemini` (OpenAI-compatible endpoint) and a `catalog.json`
  (versioned, fetched from the app's GitHub Releases like `latest.json`, cached) listing
  models with VRAM tiers, quality notes and sha256; the engine's hardcoded `CHAT_MODELS`
  becomes the offline fallback of that catalog.
- Stats tab in Settings reads `runs` (Phase 3): latency/tokens per stage and provider,
  success rate, cost estimate from a per-provider price table, DB size over time (sampled
  daily into `stats_daily`).

**Open questions:** how often to refresh the catalog; where price tables live (catalog).

**Depends on:** Phase 3.

---

## Phase 8 — Task & Calendar integrations

**Locked:** Google Calendar via one-click OAuth (never an API key); pushes only with
per-item confirmation; Todoist as a second target, same pattern; daily-plan feature that
looks at backlog + real calendar and suggests gap fills, built on Phase 3 time-relevance.

**Proposed design**
- OAuth via the system browser + loopback redirect handled by the backend (`/oauth/callback`
  on the app's port); tokens encrypted at rest with a key stored via the OS credential store
  (Windows Credential Manager through a small Tauri command; browser mode falls back to the
  DB with a warning).
- Confirmations route through the **AI Suggestions inbox** (cross-cutting, built here first):
  every proposed push is a suggestion row `{kind, payload, status}` shown in one inbox with
  yes/no/edit.
- Daily plan: a Reflect sub-view that lists calendar gaps for today/tomorrow and proposes
  backlog tasks by `est_minutes`/`urgency`.

**Open questions:** Google OAuth app verification (test users only at first)? Two-way sync
or push-only (push-only proposed)?

**Depends on:** Phase 3 (durations), Phase 2 (settings), native shell (credential store).

---

## Phase 9 — Extensibility

**Locked:** user-connectable MCP servers; user-developed plugin system; deliberately last;
Todoist/Calendar integrations are the template for "what a plugin looks like".

**Proposed design**
- Plugins are folders under `<data>/plugins/<id>/` with `plugin.json` (id, name, version,
  permissions, entry) and a Python entry module loaded in-process with a narrow API surface
  (`register_provider`, `register_action`, `register_settings_section`, `on_pipeline_stage`).
- MCP client in the backend (`app/mcp_client.py`) using stdio/HTTP transports; connected
  servers appear as tools the pipeline and sessions can call, gated per-tool in Settings.
- Plugin-proposed actions land in the AI Suggestions inbox, never auto-run.

**Open questions:** sandboxing level for Python plugins (none vs subprocess); plugin
distribution (git URL install?).

---

## Cross-cutting features → phase assignment

| Feature | Phase | Note |
|---|---|---|
| Command palette (Ctrl+K) | 2 | built |
| Full-vault semantic search | 3 | embeddings already local; add "search everything" mode |
| Backup/restore (whole vault) | 3 | zip of DB + settings; Settings → Data |
| Local-vs-cloud trust indicator | 3 | per-dump `provider` recorded by instrumentation; badge in History/detail |
| Idle nudges (native notifications) | 4 | after sessions exist; Tauri notification plugin |
| Resurfacing / "on this day" | 5 | needs time-relevance + concepts |
| Running "Today" stream | 5 | alternative to graph; reuses master/detail |
| PIN/passphrase app lock | 4 | Therapy content; lock screen in the shell |
| Recurring importer (Obsidian/markdown) | 6 | Settings → Data → Import |
| Vault location control | 3 | Settings → Data: path, reveal, move/relink |
| Vault sync (cloud folder / git) | 6 | after export format exists |
| Multiple vaults/profiles | 6 | with location control |
| Unified AI Suggestions inbox | 8 | first consumer: Calendar/Todoist pushes |
