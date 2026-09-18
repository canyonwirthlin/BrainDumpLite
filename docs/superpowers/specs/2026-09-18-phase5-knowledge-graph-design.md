# Phase 5 — Knowledge Graph Overhaul

**Status:** Designed 2026-09-18 by Claude under Canyon's standing instruction to decide
and proceed; decisions flagged inline. Brief: `2026-09-18-phases-3-9-design-briefs.md`
(Phase 5 + cross-cutting rows assigned to it: resurfacing, running "Today" stream).

## Goal

Make the graph a real navigation surface: item types are node types (colored, toggleable,
customizable via the Phase 3 editor), concepts and people open a browser listing every dump
that mentions them, every dump/concept/person shows its backlinks, and the graph gains a
focus mode. Two lighter surfaces come with it: a chronological "Today" stream and an
"on this day" resurfacing card in Reflect.

## Decisions (flagged)

- **Node types = `dump`, `concept`, `person` + every enabled item type.** Item nodes are
  off by default (they multiply the node count); the legend toggles are remembered per
  device (`localStorage bdl-graph-types`). Item nodes link to their dump.
- **No concept merging/aliasing yet.** Names are matched case-insensitively as today;
  merging is a Phase 9-era feature.
- **Backlinks are computed, not stored.** A dump's backlinks = dumps whose `links` row
  points at it + dumps sharing a concept/person. A concept's backlinks = dumps mentioning
  it. Cheap at this scale (SQLite, thousands of dumps).
- **Focus mode** dims everything beyond 2 hops of the selected node; Esc clears.
- **Today stream** = the dumps captured today (local time), newest last, each with its
  items inline, plus a quick-capture box at the top; a "Yesterday / earlier" link walks
  back one day at a time (`#today/YYYY-MM-DD`). It is the graph-averse view.
- **Resurfacing** = one card in Reflect: a dump from the same calendar day in an earlier
  month/year if any, else a random dump older than 14 days. One per day (cached by date).

## Backend

- `GET /api/graph?items=1` adds item nodes (`type` = item kind, `label` = content[:40],
  `dump` = dump id) and `item→dump` edges (`type: "in"`). Legend data:
  `GET /api/graph/types → [{id, label, color, icon, builtin}]` (dump/concept/person + item types).
- `GET /api/concepts` → `[{name, count, last_at}]`; `GET /api/concepts/{name}` → dumps
  mentioning it (id, title, created_at, mode, tone, item_count); same for `/api/people`.
- `GET /api/dumps/{id}/backlinks` → `{similar: [...], via_concepts: [{concept, dumps:[...]}],
  via_people: [...]}`.
- `GET /api/today?date=YYYY-MM-DD` → dumps of that local day with items.
- `GET /api/resurface` → `{dump, reason: "on this day, 2 months ago" | "from a while ago"}`.

## Frontend

- Graph: legend from `/graph/types` (colors from item types, dump = accent, concept =
  amber, person = blue); item nodes rendered smaller; click concept/person → browser;
  click item → its dump; **Focus** chip; node info box gains "Open" links.
- Browser view `views/browse.js` at `#graph/concept/<name>` and `#graph/person/<name>`:
  master = the dumps mentioning it (reusing History's row markup), detail = the selected
  dump; header slot shows count and a "Show in graph" link.
- Dump detail (review.js): concept and people chips become links into the browser; a
  "Linked from" card lists similar dumps and dumps sharing concepts/people.
- `views/today.js` at `#today` (rail item between Capture and History): date header with
  prev/next day, quick-capture textarea (posts a dump like Capture), the day's dumps as
  cards with their items.
- Reflect: "On this day" card at the top with the resurfaced dump.

## Testing

pytest: graph types list includes item types; `?items=1` adds item nodes/edges; concepts
and people endpoints count correctly and are case-insensitive; backlinks include similar
and shared-concept dumps; today filters by local date; resurface prefers same-day matches
and caches per day. Playwright: legend toggles incl. an item type, focus mode dims, browser
route, backlinks card, today view with quick capture, reflect card.

## Release: 0.9.0
