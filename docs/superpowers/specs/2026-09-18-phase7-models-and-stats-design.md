# Phase 7 — Model & Provider Flexibility + Stats

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to decide
and proceed; decisions flagged inline. Brief: `2026-09-18-phases-3-9-design-briefs.md`.

## Goal

Add Google Gemini as a provider, turn the built-in model list into a browsable, curated,
updatable catalog that downloads nothing until picked, and add a Stats section that reads
the Phase 3 `runs` table.

## Decisions (flagged)

- **Gemini via its OpenAI-compatible endpoint** (`https://generativelanguage.googleapis.com/v1beta/openai/`),
  API key from Google AI Studio (free tier). Default chat model `gemini-2.5-flash`,
  embeddings `text-embedding-004`. It slots into `ai.DEFAULTS`/`config()` like OpenAI;
  no new SDK.
- **Catalog = one JSON file** (`catalog/models.json` in this repo, fetched from the raw
  master URL, cached 24 h in settings, bundled copy as fallback). Entries carry hardware
  tiers (`vram_gb`), tags (`fast`, `quality`, `writing`, `reasoning-off`), sha256, size,
  and a `recommended` flag per tier. The engine's hardcoded list becomes the seed of this
  file; `engine.CHAT_MODELS` is replaced by `catalog.chat_models()`.
- **Browse-only:** the Settings list shows every catalog model with a VRAM filter and
  search; only "Get" downloads. Downloaded models show "Use" / "Delete" as today.
- **Prices** live in the catalog (`prices: {provider/model: {input, output per 1M}}`); the
  Stats cost estimate is explicit about being an estimate.
- **Stats section** (Settings → Stats): last 30 days by default (7/30/90 selector):
  calls, success rate, median and p90 latency per stage, tokens in/out per provider,
  estimated cost per provider, dumps per day, vault size over time (sampled daily into
  `stats_daily` at boot). Rendered as small tables with inline CSS bars; no chart library.

## Backend

- `app/catalog.py`: `load(refresh=False)`, `chat_models()`, `prices()`; settings keys
  `catalog_cache` `{fetched_at, data}`.
- `app/engine.py`: `CHAT_MODELS` → property fed by the catalog; `status()` unchanged shape
  plus `tags`.
- `app/stats.py`: `sample_daily()` (dumps count, db bytes), `summary(days)`.
- `app/ai.py`: provider `gemini` in `DEFAULTS`; `available()`/`embed()` handle it.
- Routes: `GET /catalog?refresh=1`, `GET /stats?days=30`; settings `provider` accepts `gemini`.

## Frontend

- Settings → AI: Gemini card (help: free tier, key from aistudio.google.com); built-in
  panel gets search + VRAM chips + tags; "Check for new models" refreshes the catalog.
- Settings → Stats: new section (rail unchanged) with the tables and bars.

## Testing

pytest: catalog fallback + cache + refresh with a fake fetch; engine list derived from the
catalog; stats summary from seeded `runs` (rates, medians, cost); gemini config defaults
and `available()`. Browser: model browser filters, Stats renders with seeded data.

## Release: 0.11.0
