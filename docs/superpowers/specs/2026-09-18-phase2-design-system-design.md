# Phase 2 — Design System & "Studio" Layout

**Status:** Design approved by Canyon on 2026-09-18 (mockup in `assets/phase2-mockup.png`,
source `assets/phase2-mockup.html`). Roadmap context:
`2026-09-17-native-app-migration-roadmap-design.md`, Phase 2.

## Goal

Give BrainDump Lite a sleek, quiet, desktop-app visual language that every later phase
builds on once: a left icon rail, master/detail data views, a focused Capture stage,
sectioned Settings with progressive disclosure, a Ctrl+K command palette, and a formal
theme system (JSON themes, import/export). No feature logic changes; the backend, DB,
pipeline and engine stay as they are apart from a small themes API.

## Non-goals (explicitly deferred)

- Theme marketplace (stretch goal in the roadmap; deferred, the JSON theme format is the
  groundwork).
- Any new capture/pipeline features, graph overhaul, backlinks, Today stream, AI inbox.
  The layout leaves room for them (rail + content + optional right panel) but does not build them.
- A JS build step or framework. The SPA stays vanilla ES modules served by FastAPI.
- Mobile/touch layouts. Minimum supported window width is 720px (the Tauri window's `minWidth`).

## Layout ("Studio")

```
┌──────┬────────────────────────────────────────────────────────────┐
│ rail │ top bar: view title · subtitle/actions ……… AI pill · update │
│ 60px ├────────────────────────────────────────────────────────────┤
│      │ view container (each view decides its own inner layout)     │
│ nav  │   Capture/Processing/Review/Search/Reflect: centered column │
│ …    │   History, Tasks: master (left list) / detail (right)        │
│      │   Graph: full width, legend toolbar above the canvas         │
│ AI ● │   Settings: sub-nav (200px) / section body                   │
│ gear │                                                              │
└──────┴────────────────────────────────────────────────────────────┘
```

- **Rail** (always visible, 60px): brain mark; nav items Capture, History, Tasks, Graph,
  Search, Reflect as icon + 9.5px label; spacer; AI status dot (green = provider available,
  grey = off); Settings gear (amber dot badge when an update is available). Active item gets
  the `--accent-soft` background. Tooltips are the label (native `title`).
- **Top bar** (52px): current view title, a per-view slot for subtitle or controls (History
  filter box, Graph legend toggles), right cluster: AI provider pill, update pill, `Ctrl K`
  hint. Replaces today's header entirely.
- **Master/detail** views split at 360px | rest. Below 900px content width they stack: the
  list is the route, selecting an item navigates to the detail route, a back link returns.
- **Motion:** 150ms ease for hover/active, the existing 180ms view "rise" on route change.
  `prefers-reduced-motion` disables both.
- **Density:** `data-density="comfortable"` (default) or `"compact"` on `<html>`; spacing
  tokens scale (`--sp` unit 8px → 6px), row padding and font size step down one notch.

## Visual language & tokens

- Typography: bundled **Inter Variable** (`static/fonts/InterVariable.woff2`, served locally,
  no network fetch; fallback `"Segoe UI", system-ui`). UI 14px/1.5, headings 650 weight
  with −0.01em tracking, data/monospace via `ui-monospace, Consolas`.
- One accent per theme, hairline `1px var(--line)` borders, `--radius` 12px (cards 14px),
  a single ambient radial glow on the Capture stage only, no other gradients.
- Semantic tokens (all themes must define every one):
  `bg, rail, panel, panel-2, line, text, dim, accent, accent-2, accent-soft, green, red,
  amber, shadow, radius, scheme`.
- Six built-in themes keep their names and palettes (Midnight, Ocean, Forest, Ember, Paper,
  Sakura), tightened to the token list above (each gains `rail`).

## Theme system

**Theme JSON schema** (`app/themes.py`, validated on import):

```json
{
  "id": "midnight",            // [a-z0-9-]{2,32}; built-ins are reserved
  "name": "Midnight",          // 1-40 chars
  "scheme": "dark",            // "dark" | "light"  → color-scheme
  "colors": {                  // every key required, #rgb/#rrggbb/#rrggbbaa or rgba()
    "bg": "#0d1017", "rail": "#0a0d13", "panel": "#151b28", "panel2": "#1b2334",
    "line": "#263049", "text": "#e6e9f2", "dim": "#8b93a8",
    "accent": "#8b7cf6", "accent2": "#5ea2f7", "accentSoft": "rgba(139,124,246,.16)",
    "green": "#4ade80", "red": "#f87171", "amber": "#fbbf24"
  },
  "radius": 12                 // optional, 6-20
}
```

- Built-in themes live in Python (`app/themes.py: BUILTIN`) so the API is the single source
  of truth; the frontend renders them from `GET /api/themes` and applies a theme by setting
  CSS custom properties on `<html>` (no per-theme CSS blocks any more) and `data-theme=<id>`.
- Custom themes are stored in the `settings` table under key `custom_themes` (JSON list).
  The active theme id is stored in setting `theme` **and** mirrored to `localStorage
  bdl-theme` (plus a cached copy of the active theme's colors in `localStorage bdl-theme-css`)
  so first paint has no flash before `/api/themes` answers.
- Endpoints (all under `/api`): `GET /themes` → `{active, themes:[…]}`;
  `PUT /themes/active {id}`; `POST /themes/import` (body = theme JSON; 400 with a
  human-readable reason on validation failure; a custom theme with an existing custom id
  replaces it); `DELETE /themes/{id}` (custom only, 400 for built-ins; if active, falls back
  to midnight); `GET /themes/{id}/export` → the JSON with `Content-Disposition: attachment`.
- Appearance section UI: theme grid (swatches from `colors.bg/panel/accent`), "Import theme"
  (file picker → POST), "Export" on the active theme, "Delete" on custom themes.

## Command palette (Ctrl+K)

- Opens over any view; `Esc` closes; `↑/↓` move; `Enter` runs. Query matching is a simple
  subsequence/prefix score (no library). Groups in order: **Actions**, **Go to**,
  **Recent dumps**, **Themes** (only when the query matches a theme name).
- Actions: New dump (Ctrl+N, goes to Capture and focuses the editor), Check for updates
  (native only), Switch theme → `<name>` (one entry per theme).
- Go to: the six views plus each Settings section (`#settings/appearance`, …).
- Recent dumps: latest 8 from `GET /dumps` (title, relative date) → `#history/<id>`.
- Global shortcuts: `Ctrl+K` palette, `Ctrl+N` new dump. Nothing else in this phase.

## Settings (progressive disclosure — standing rule)

Route `#settings/<section>`; sections: **Appearance**, **AI**, **Voice**, **Data**, **About**.
Each section header has an **Advanced** switch (persisted per section in `localStorage
bdl-adv-<section>`), hidden when a section has no advanced fields.

| Section | Simple | Advanced |
|---|---|---|
| Appearance | theme grid, import/export | density (comfortable/compact), reduce motion |
| AI | provider cards; built-in model list; API key for cloud | base URL, chat model + List, embedding model; built-in: engine folder, ports (read-only), context size (read-only until Phase 7) |
| Voice | whisper model (tiny/base/small) | — (no switch shown) |
| Data | data folder path, "Reveal in Explorer" (native: `opener.revealItemInDir`; browser: copy path) | — |
| About | version, What's new, Check for updates (native) | — |

Every settings screen added in later phases follows this table's pattern.

## Views (behaviour is unchanged; only layout moves)

- **Capture / Processing / Review:** centered 720px column on the stage with the ambient glow.
- **History:** master list (title, relative date, mode tag, item count, 2-line snippet) with
  mode filter chips and a text filter (client-side); detail = today's dump detail (summary,
  items with the existing due-date editing and calendar buttons, related dumps, delete).
  Route `#history/<id>`; `#history` alone selects the newest dump on wide layouts.
- **Tasks:** master = groups (Today, Upcoming, No date, Done) with counts; detail = the task
  list for the group with today's row interactions. Route `#tasks/<group>`.
- **Graph:** full width; legend becomes a toolbar of toggle chips above the canvas (Dumps,
  Concepts, People) that hide/show node types; canvas resizes with the window.
- **Search / Reflect:** centered column, restyled only.

## Code structure (vanilla ES modules, no build)

```
static/index.html            shell skeleton: rail, top bar, #view, #palette, toasts; <script type="module">
static/css/tokens.css        base tokens, density, reduced-motion, fonts (@font-face Inter)
static/css/shell.css         rail, top bar, layout grid, master/detail, palette, modal, toast, pills
static/css/views.css         per-view styles (capture stage, items, settings, graph, lists)
static/fonts/InterVariable.woff2
static/js/main.js            boot: theme first paint, status, router, shell, native
static/js/api.js             fetch helper (today's `api`)
static/js/ui.js              $, $$, esc, md, toast, modal(), icon(name), relTime
static/js/state.js           status/settings cache + tiny pub/sub (`on`, `emit`)
static/js/router.js          hash routes with sub-paths: parse(), go(), onRoute()
static/js/shell.js           rail + top bar rendering, active state, pills, shortcuts
static/js/palette.js         command palette
static/js/theme.js           apply(theme), first-paint from localStorage, import/export
static/js/native.js          Tauri bridge (openExternal, updater UI, What's New) — moved from app.js
static/js/views/{capture,processing,review,history,tasks,graph,search,reflect,settings}.js
app/themes.py                BUILTIN themes, validate(), CRUD helpers
app/routes.py                + /themes endpoints
tests/test_themes.py         validation + endpoint tests
```

Each view module exports `render(ctx)` where `ctx = {params, setTitle(title, slotHtml)}` and
returns nothing; views own their inner layout and event binding. `app.js` and `style.css`
are deleted at the end of the phase. Cache-busters move to `?v=` on the module and CSS URLs
(release.ps1 already rewrites `?v=` anywhere in `index.html`).

## Error handling

- API errors surface as toasts (existing pattern). Theme import shows the server's reason
  inline under the import button. Palette actions that fail toast and keep the palette closed.
- If `/api/themes` fails at boot, the cached `bdl-theme-css` keeps the last theme applied.
- Narrow windows never lose content: master/detail stacks instead of clipping.

## Testing

- `pytest`: theme schema validation (good/bad colors, reserved ids, missing keys), import →
  list → export round trip, delete rules, active theme persistence.
- `node --check` on every module and a `node` import smoke (`import()` each module via a
  jsdom-free static parse) in a `npm run lint:js` script.
- Playwright (interactive, via the MCP during execution; commands documented in the plan):
  rail navigation, master/detail routes, palette open/navigate/run, Advanced toggle
  persistence, theme switch + import/export, reduced density. Final visual pass in `tauri dev`.

## Migration notes

- The `bdl-theme` localStorage key is kept, so friends keep their chosen theme.
- No DB migration: custom themes and the active theme are settings rows.
- Version bump for the release that ships this: 0.6.0.
