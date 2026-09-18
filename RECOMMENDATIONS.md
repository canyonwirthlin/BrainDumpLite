# Recommendations for big BrainDump (based on building Lite)

Things learned building the Lite fork that are worth porting back to
`C:\Users\canyo\Desktop\Home\Coding\BrainDump`. **None of these have been
applied** — this is a to-consider list.

## 1. Provider abstraction in `lm_studio.py` (highest value)

Lite's `app/ai.py` proves the whole pipeline runs unmodified against Claude,
OpenAI, or LM Studio through one OpenAI-SDK client with three base URLs.
Big BrainDump already funnels everything through `get_chat_completion()` /
`get_embedding()` — adding a `provider` setting (`local | anthropic | openai`)
would be ~50 lines in `core/lm_studio.py` + a Settings UI field, and would let
YOU use cloud models on a laptop away from the GPU box. Gotchas already solved
in Lite's `ai.py`, steal them:
- OpenAI's gpt-5-family rejects `max_tokens` (wants `max_completion_tokens`)
  and non-default `temperature` — Lite retries once with swapped params.
- Anthropic compat endpoint: `https://api.anthropic.com/v1/` with the plain
  OpenAI SDK. No embeddings there — `get_embedding()` must be allowed to
  return None, with FTS fallback (see #2).

## 2. Full-text search fallback when embeddings are missing

Lite indexes every dump in SQLite FTS5 and merges keyword + semantic results.
Big BrainDump's search dies entirely if the embedding model isn't loaded.
Postgres has `tsvector` — a `to_tsvector` column on `brain_dumps` + merged
results in `/brain/search` would make search resilient to LM Studio being down.

## 3. SQLite as an install-free infra mode

The entire schema (incl. links-as-a-table instead of Neo4j edges) fits SQLite
comfortably at personal scale. If you ever want big BrainDump to run without
Docker (e.g. on a laptop), the SQLAlchemy layer could straddle
`sqlite+aiosqlite` vs `postgresql+asyncpg` behind one env var. The graph is
the only hard part — but `assign_communities` is already computed in Python,
so Neo4j is fundamentally a persistence choice, not a compute one.

## 4. Windows console encoding guard

Lite crashed on first launch printing box-drawing chars: Windows consoles
default to cp1252. `launch.ps1` output and any Python `print` with emoji/
unicode should survive `sys.stdout.reconfigure(encoding="utf-8",
errors="replace")` (Lite does this in `run.py`). Worth adding to the API's
startup for when it runs outside a UTF-8 terminal.

## 5. One-expand-per-dump as a cost mode

Lite runs a single expand call over the whole dump instead of per-item.
Quality is genuinely lower, but for API-metered users it's ~5x cheaper. If
big BrainDump ever gets a cloud-provider mode, consider a per-stage setting
(`expand_scope: per_item | per_dump`) in the existing admin per-stage settings.

## 6. First-run friendliness patterns worth copying

- Status pill in the header showing provider + model, click → settings.
- "AI is off — saved raw" banner instead of failing: pipeline degrades to a
  heuristic classifier (line-split + action-verb regex) so the app never
  *needs* the LLM to be useful.
- `Test connection` button that round-trips a real chat call and reports
  whether embeddings work, in plain words.

## 7. Serialize LLM calls against local servers (latent bug in big BrainDump too)

Firing several dumps back-to-back (before the first finishes processing) queues
overlapping requests into LM Studio; on this machine the responses came back
interleaved/truncated and classify silently fell back. Lite now serialises all
chat/embedding calls behind a `threading.Lock` in `ai.py`. Big BrainDump's
pipeline runs one BackgroundTask per dump with `AsyncOpenAI` — two quick dumps
produce exactly the same concurrent-request pattern. An `asyncio.Semaphore(1)`
inside `get_chat_completion()`/`get_embedding()` (only when the base_url is
local) would close it.

## 8. Tame reasoning models: floor budgets, detect truncation, cap effort

qwen3.x/gpt-5-family burn completion tokens on hidden reasoning BEFORE the
answer: a small `max_tokens` yields EMPTY content (all reasoning) and a medium
one yields JSON cut off mid-string — both look like "model returned garbage"
unless you check `finish_reason == "length"`. Lite floors cloud requests at
8192 completion tokens (a ceiling, not a cost) and raises a distinct error on
truncation. Worth auditing big BrainDump's per-stage `max_tokens` math in
`pipeline.py` for the same failure mode, especially `stage_cleanup`'s
`len(transcript)+200` cap, which reasoning eats instantly.

**BUT never let `max_tokens` exceed a local server's context window.** With
llama.cpp/LM Studio, a budget larger than remaining context lets the model
reason until the context is EXHAUSTED — every failed call becomes a
minutes-long wait for an empty reply, which reads as "the app is frozen."
Lite clamps local budgets to `min(max(requested, 2048), 4096)`; combined with
low reasoning effort that fits comfortably in the common 4k default context.

Bigger win, measured on LM Studio + qwen3.5-9b: passing
`extra_body={"reasoning_effort": "low"}` made pipeline-style calls **5x
faster** (10.6s → 1.9s on cleanup; ~3000 → ~600 reasoning chars) with no
quality change — these are simple extraction tasks that don't need deep
thinking. Under queue pressure (several dumps at once) unbounded reasoning is
also what made calls blow through 8192 tokens entirely. Big BrainDump already
has per-stage settings in admin — a per-stage reasoning-effort knob (default
low for cleanup/classify, high for expand/reflect) fits right in. Retry once
without the param when a server rejects it (Lite's `ai.py` shows the pattern).

## 9. Distribution reality check (why Lite is a fork, not a build target)

Attempting to package big BrainDump directly would mean bundling Node +
Postgres + Neo4j or rewriting the data layer — the fork-with-shared-prompts
approach (Lite reuses the cleanup/classify/expand prompts and the
weekday→date table verbatim) costs one afternoon and keeps the main app's
architecture free to stay heavyweight. If Lite gets traction with friends,
consider extracting the prompts into a shared file both apps read.
