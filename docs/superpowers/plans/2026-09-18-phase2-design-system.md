# Phase 2: Design System & "Studio" Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the SPA's shell and visual language per `docs/superpowers/specs/2026-09-18-phase2-design-system-design.md` (left rail, master/detail views, Ctrl+K palette, sectioned Settings with Advanced toggles, JSON themes with import/export) without changing any backend feature logic.

**Architecture:** The backend gains one small module (`app/themes.py`) and five `/api/themes*` routes. The frontend is re-cut from one `app.js` + `style.css` into vanilla ES modules (`static/js/*`, `static/js/views/*`) and three stylesheets, served as-is by FastAPI (no build). Task 2 does the module split *without* visual change so the redesign (Tasks 4-10) lands on a stable base. Every task ends with `pytest`, a `node --check` of every module, a live check in the browser (Playwright MCP against a dev backend on port 8779, as in Phase 1), and a commit.

**Tech Stack:** Python 3.14 / FastAPI / pytest (existing), vanilla ES modules, CSS custom properties, Inter Variable (bundled woff2), Tauri shell unchanged.

## Global Constraints

- **Spec is the source of truth** for layout, tokens, theme schema, palette groups, settings table (`2026-09-18-phase2-design-system-design.md`). Copy names exactly: token keys `bg, rail, panel, panel2, line, text, dim, accent, accent2, accentSoft, green, red, amber`; CSS vars `--bg --rail --panel --panel-2 --line --text --dim --accent --accent-2 --accent-soft --green --red --amber --radius`.
- **No build step, no framework, no network fonts.** Modules are loaded with `<script type="module">`; the font is a local file.
- **No backend feature changes** beyond themes. Pipeline, engine, dumps, tasks, search, reflect APIs are untouched.
- **Minimum width 720px**; master/detail stacks below 900px content width.
- **Progressive disclosure rule:** every settings section shows essentials; extras live behind the section's Advanced switch, persisted in `localStorage bdl-adv-<section>`.
- **Keep working at every commit.** Task 2 must be pixel-equivalent to today; later tasks may look different but every view must function.
- **Dev loop for checks:** start a detached backend with `BRAINDUMP_LITE_SIDECAR=1 BRAINDUMP_LITE_PORT=8779` (PowerShell `Start-Process`, no parent PID), open `http://127.0.0.1:8779/#…` with the Playwright MCP, evaluate/screenshot, kill it after. WebView2 caches JS across backend rebuilds: for `tauri dev` checks bump `?v=` in `index.html` or clear `%LOCALAPPDATA%\com.canyonwirthlin.braindumplite`.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Release:** this phase ships as **0.6.0** (Task 10).

## File structure (end state)

```
static/index.html                  shell skeleton + first-paint theme script + module entry
static/css/tokens.css              :root defaults (= Midnight), density, motion, @font-face
static/css/shell.css               rail, top bar, layout, split, palette, modal, toast, pills, buttons, cards
static/css/views.css               capture stage, items, review, history/tasks rows, graph, settings, engine panel
static/fonts/InterVariable.woff2
static/js/main.js                  boot sequence
static/js/api.js                   fetch helper
static/js/ui.js                    $, $$, esc, md, toast, fmt*, todayIso, relTime, ICONS, modal
static/js/state.js                 state object, pub/sub, refreshStatus, clearPoll
static/js/router.js                register/parse/go/route/start, legacy #dump redirect
static/js/shell.js                 rail + top bar, setTitle, status/update indicators, shortcuts
static/js/palette.js               Ctrl+K palette
static/js/theme.js                 apply/load/setActive/import/export/delete, density + motion prefs
static/js/native.js                Tauri bridge, updater UI, What's New (moved)
static/js/views/capture.js         capture + processing + voice recording
static/js/views/review.js          itemRow, bindItemRows, reviewHtml, renderReview, due-date editing, calBtns
static/js/views/history.js         master/detail
static/js/views/tasks.js           master/detail
static/js/views/graph.js           full-width graph + legend toggles
static/js/views/search.js
static/js/views/reflect.js
static/js/views/settings.js        sections + Advanced + engine panel
app/themes.py                      schema, BUILTIN, storage helpers
app/routes.py                      + /themes routes
tests/test_themes.py
DELETED at Task 10: static/app.js, static/style.css
```

---

### Task 1: Themes backend (`app/themes.py` + `/api/themes*`)

**Files:**
- Create: `app/themes.py`, `tests/test_themes.py`
- Modify: `app/routes.py` (import + 5 routes)

**Interfaces:**
- Produces: `themes.validate(raw: dict) -> dict` (raises `ValueError(reason)`), `themes.all_themes() -> list[dict]`, `themes.get(id) -> dict|None`, `themes.active_id() -> str`, `themes.set_active(id)`, `themes.import_theme(raw) -> dict`, `themes.delete(id)`, `themes.BUILTIN`, `themes.COLOR_KEYS`.
- Produces HTTP: `GET /api/themes → {active, themes}`, `PUT /api/themes/active {id}`, `POST /api/themes/import <theme json>`, `DELETE /api/themes/{id}`, `GET /api/themes/{id}/export` (attachment).

- [x] **Step 1: Write the failing tests** — `tests/test_themes.py`:

```python
import json

import pytest
from fastapi.testclient import TestClient

from app import themes
from app.main import create_app

GOOD = {
    "id": "solar", "name": "Solar", "scheme": "dark",
    "colors": {"bg": "#000", "rail": "#050505", "panel": "#111111", "panel2": "#181818",
               "line": "#222222", "text": "#fafafa", "dim": "#999999", "accent": "#ffb000",
               "accent2": "#ff7000", "accentSoft": "rgba(255,176,0,.16)",
               "green": "#4ade80", "red": "#f87171", "amber": "#fbbf24"},
    "radius": 10,
}


def test_builtin_themes_are_valid_and_complete():
    ids = [t["id"] for t in themes.BUILTIN]
    assert ids == ["midnight", "ocean", "forest", "ember", "paper", "sakura"]
    for t in themes.BUILTIN:
        assert themes.validate(t) == t
        assert set(t["colors"]) == set(themes.COLOR_KEYS)


@pytest.mark.parametrize("mutate, reason", [
    (lambda t: t.update(id="Bad Id"), "id"),
    (lambda t: t.update(scheme="blue"), "scheme"),
    (lambda t: t["colors"].pop("dim"), "dim"),
    (lambda t: t["colors"].update(bg="red"), "bg"),
    (lambda t: t.update(radius=99), "radius"),
    (lambda t: t.update(id="midnight"), "reserved"),
])
def test_validate_rejects_bad_themes(mutate, reason):
    t = json.loads(json.dumps(GOOD))
    mutate(t)
    with pytest.raises(ValueError) as e:
        themes.import_theme(t)
    assert reason in str(e.value)


def test_import_list_export_delete_round_trip():
    client = TestClient(create_app())
    r = client.post("/api/themes/import", json=GOOD)
    assert r.status_code == 200 and r.json()["id"] == "solar"
    listed = client.get("/api/themes").json()
    assert "solar" in [t["id"] for t in listed["themes"]]
    assert client.put("/api/themes/active", json={"id": "solar"}).status_code == 200
    assert client.get("/api/themes").json()["active"] == "solar"
    ex = client.get("/api/themes/solar/export")
    assert ex.status_code == 200 and "attachment" in ex.headers["content-disposition"]
    assert ex.json()["name"] == "Solar"
    assert client.delete("/api/themes/midnight").status_code == 400
    assert client.delete("/api/themes/solar").status_code == 200
    after = client.get("/api/themes").json()
    assert after["active"] == "midnight"
    assert "solar" not in [t["id"] for t in after["themes"]]


def test_import_replaces_same_id_and_bad_json_is_400():
    client = TestClient(create_app())
    client.post("/api/themes/import", json=GOOD)
    client.post("/api/themes/import", json={**GOOD, "name": "Solar 2"})
    names = [t["name"] for t in client.get("/api/themes").json()["themes"] if t["id"] == "solar"]
    assert names == ["Solar 2"]
    assert client.post("/api/themes/import", json={"id": "x"}).status_code == 400
    assert client.put("/api/themes/active", json={"id": "nope"}).status_code == 400
    client.delete("/api/themes/solar")
```

- [x] **Step 2: Run to verify they fail**

```bash
.venv/Scripts/python -m pytest tests/test_themes.py -q
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.themes'`.

- [x] **Step 3: Create `app/themes.py`**

```python
"""Theme JSON schema, the six built-in themes, and custom-theme storage.

A theme is:
    {"id": "midnight", "name": "Midnight", "scheme": "dark"|"light",
     "colors": {bg, rail, panel, panel2, line, text, dim, accent, accent2,
                accentSoft, green, red, amber}, "radius": 12}
Custom themes live in the settings table (key "custom_themes", JSON list);
the active id is setting "theme". Built-ins are code, so the API is the
single source of truth for the frontend.
"""
from __future__ import annotations

import json
import re

from . import db

COLOR_KEYS = ["bg", "rail", "panel", "panel2", "line", "text", "dim", "accent",
              "accent2", "accentSoft", "green", "red", "amber"]
_ID = re.compile(r"^[a-z0-9-]{2,32}$")
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGBA = re.compile(r"^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$")
DEFAULT_ID = "midnight"


def _t(id, name, scheme, bg, rail, panel, panel2, line, text, dim, accent, accent2, soft,
       green="#4ade80", red="#f87171", amber="#fbbf24", radius=12):
    return {"id": id, "name": name, "scheme": scheme, "radius": radius,
            "colors": {"bg": bg, "rail": rail, "panel": panel, "panel2": panel2, "line": line,
                       "text": text, "dim": dim, "accent": accent, "accent2": accent2,
                       "accentSoft": soft, "green": green, "red": red, "amber": amber}}


BUILTIN = [
    _t("midnight", "Midnight", "dark", "#0d1017", "#0a0d13", "#151b28", "#1b2334", "#263049",
       "#e6e9f2", "#8b93a8", "#8b7cf6", "#5ea2f7", "rgba(139,124,246,.16)"),
    _t("ocean", "Ocean", "dark", "#0a121f", "#070d17", "#101a2b", "#16233a", "#23344f",
       "#e2ecf7", "#85929f", "#38bdf8", "#34d399", "rgba(56,189,248,.15)"),
    _t("forest", "Forest", "dark", "#0c1210", "#080d0b", "#121b17", "#18251f", "#24382e",
       "#e4efe8", "#86988d", "#4ade80", "#a3e635", "rgba(74,222,128,.13)"),
    _t("ember", "Ember", "dark", "#16100e", "#100b09", "#201613", "#2a1c18", "#402c25",
       "#f2e8e3", "#a3908a", "#fb923c", "#f43f5e", "rgba(251,146,60,.15)"),
    _t("paper", "Paper", "light", "#f4f5f9", "#e9ebf3", "#ffffff", "#eceef5", "#d9dded",
       "#1c2130", "#626b81", "#6d5ce6", "#2f7de1", "rgba(109,92,230,.12)",
       green="#15803d", red="#dc2626", amber="#b45309"),
    _t("sakura", "Sakura", "light", "#faf3f5", "#f1e4e8", "#ffffff", "#f5e6eb", "#e9d2db",
       "#2e2027", "#826a75", "#d6488f", "#9b5de5", "rgba(214,72,143,.12)",
       green="#15803d", red="#dc2626", amber="#b45309"),
]
_BUILTIN_IDS = {t["id"] for t in BUILTIN}


def validate(raw) -> dict:
    """Return a normalised copy or raise ValueError with a human-readable reason."""
    if not isinstance(raw, dict):
        raise ValueError("theme must be a JSON object")
    tid = str(raw.get("id", ""))
    if not _ID.match(tid):
        raise ValueError("id must be 2-32 chars of a-z, 0-9 or '-'")
    name = str(raw.get("name", "")).strip()
    if not 1 <= len(name) <= 40:
        raise ValueError("name must be 1-40 characters")
    scheme = raw.get("scheme")
    if scheme not in ("dark", "light"):
        raise ValueError("scheme must be 'dark' or 'light'")
    colors = raw.get("colors")
    if not isinstance(colors, dict):
        raise ValueError("colors must be an object")
    out_colors = {}
    for k in COLOR_KEYS:
        v = colors.get(k)
        if not isinstance(v, str) or not (_HEX.match(v.strip()) or _RGBA.match(v.strip())):
            raise ValueError(f"colors.{k} must be a #hex or rgba() color")
        out_colors[k] = v.strip()
    radius = raw.get("radius", 12)
    if not isinstance(radius, int) or not 6 <= radius <= 20:
        raise ValueError("radius must be an integer from 6 to 20")
    return {"id": tid, "name": name, "scheme": scheme, "colors": out_colors, "radius": radius}


def custom() -> list[dict]:
    try:
        data = json.loads(db.get_setting("custom_themes", "[]") or "[]")
        return [t for t in data if isinstance(t, dict)]
    except (ValueError, TypeError):
        return []


def _save_custom(items: list[dict]) -> None:
    db.set_setting("custom_themes", json.dumps(items))


def all_themes() -> list[dict]:
    return BUILTIN + custom()


def get(theme_id: str) -> dict | None:
    return next((t for t in all_themes() if t["id"] == theme_id), None)


def active_id() -> str:
    tid = db.get_setting("theme", DEFAULT_ID) or DEFAULT_ID
    return tid if get(tid) else DEFAULT_ID


def set_active(theme_id: str) -> None:
    if not get(theme_id):
        raise ValueError(f"unknown theme '{theme_id}'")
    db.set_setting("theme", theme_id)


def import_theme(raw) -> dict:
    t = validate(raw)
    if t["id"] in _BUILTIN_IDS:
        raise ValueError(f"id '{t['id']}' is reserved for a built-in theme")
    items = [c for c in custom() if c.get("id") != t["id"]] + [t]
    _save_custom(items)
    return t


def delete(theme_id: str) -> None:
    if theme_id in _BUILTIN_IDS:
        raise ValueError("built-in themes can't be deleted")
    items = custom()
    if theme_id not in [c.get("id") for c in items]:
        raise ValueError(f"unknown theme '{theme_id}'")
    _save_custom([c for c in items if c.get("id") != theme_id])
    if db.get_setting("theme", DEFAULT_ID) == theme_id:
        db.set_setting("theme", DEFAULT_ID)
```

- [x] **Step 4: Routes.** In `app/routes.py` change the module import to `from . import ai, changelog, db, engine, pipeline, themes, transcribe`, add `from fastapi import Response` next to the existing fastapi imports (keep what is already imported), and add after the `/changelog` route:

```python
# ── Themes ───────────────────────────────────────────────────────────────────

class ThemeActiveIn(BaseModel):
    id: str


@router.get("/themes")
def list_themes():
    return {"active": themes.active_id(), "themes": themes.all_themes()}


@router.put("/themes/active")
def set_active_theme(body: ThemeActiveIn):
    try:
        themes.set_active(body.id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"active": themes.active_id()}


@router.post("/themes/import")
def import_theme(body: dict):
    try:
        return themes.import_theme(body)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/themes/{theme_id}")
def delete_theme(theme_id: str):
    try:
        themes.delete(theme_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "active": themes.active_id()}


@router.get("/themes/{theme_id}/export")
def export_theme(theme_id: str):
    t = themes.get(theme_id)
    if not t:
        raise HTTPException(404, "unknown theme")
    return Response(json.dumps(t, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{theme_id}.theme.json"'})
```
(`json` is already imported in routes.py; verify with `grep -n "^import json" app/routes.py`, add it if not.)

- [x] **Step 5: Run tests**

```bash
.venv/Scripts/python -m pytest -q
```
Expected: all pass (15 existing + 9 new).

- [x] **Step 6: Commit**

```bash
git add app/themes.py app/routes.py tests/test_themes.py
git commit -m "feat(themes): JSON theme schema, built-in themes, import/export API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Split `app.js` into ES modules (no visual change)

**Files:**
- Create: `static/js/{api,ui,state,router,native,main}.js`, `static/js/views/{capture,review,history,tasks,graph,search,reflect,settings}.js`, `package.json` script `lint:js`
- Modify: `static/index.html` (module script tag), `static/app.js` stays until Task 10 but is no longer loaded

**Interfaces (used by every later task):**
- `api.js`: `export const api` (same object as today).
- `ui.js`: `export const $, $$, esc; export function md, toast, fmtDate, fmtDay, fmtTime, todayIso, relTime; export const MODES, PROVIDER_NAMES, STAGES; export function modal(html) -> {el, close}`.
- `state.js`: `export const state = {status, curMode, draft, pollTimer, themes, activeTheme}; export function on(ev, fn), emit(ev, data), clearPoll(), async refreshStatus()`.
- `router.js`: `export function register(name, render), parse() -> {name, params}, go(hash), route(), start()`; render receives `ctx = {name, params, setTitle}`; `setTitle` is a no-op until Task 4.
- `native.js`: `export const native; export function openExternal(url), initNative(), maybeShowWhatsNew(), showWhatsNew(version), checkForUpdates({silent}), showUpdateModal()`.
- `views/review.js`: `export function itemRow, bindItemRows, reviewHtml, renderReview, dueWrap, bindDue, calBtns`.
- `views/capture.js`: `export function render(ctx), renderProcessing(id)`.
- Every other view: `export function render(ctx)` (`async` where the original was async).

- [x] **Step 1: Glue modules.** Create these files verbatim.

`static/js/api.js` — lines 9-29 of `app.js` with `export` in front of `const api`.

`static/js/ui.js`:

```js
// Shared helpers + constants. Pure functions only; no app state here.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const MODES = [
  { id: "freeform", icon: "🌀", label: "Freeform" },
  { id: "brainstorm", icon: "💡", label: "Brainstorm" },
  { id: "therapy", icon: "🫂", label: "Therapy" },
  { id: "execution", icon: "⚡", label: "Execution" },
];
export const PROVIDER_NAMES = { builtin: "Built-in AI", anthropic: "Claude", openai: "OpenAI", local: "Self-hosted", off: "AI off" };
export const STAGES = [
  ["cleanup", "Cleaning transcript"], ["classify", "Extracting items"], ["expand", "Thinking deeper"],
  ["embed", "Embedding"], ["link", "Linking to past dumps"],
];

export function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 20);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
}

export const fmtDate = (iso) => new Date(iso).toLocaleString(undefined,
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso) => new Date(iso + "T00:00").toLocaleDateString(undefined,
  { weekday: "short", month: "short", day: "numeric" });
export const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// "just now", "5m", "3h", "yesterday", "Sep 9"
export function relTime(iso) {
  const d = new Date(iso), now = new Date(), s = (now - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400 && d.getDate() === now.getDate()) return Math.floor(s / 3600) + "h ago";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Minimal markdown-ish rendering: bullets + paragraphs.
export function md(text) {
  const lines = esc(text).split(/\r?\n/);
  let html = "", inList = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*[•\-\*]\s+(.*)/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (ln.trim()) html += `<p>${ln}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return `<div class="md">${html}</div>`;
}

// Modal helper: returns {el, close}. Caller fills `.modal` and binds buttons.
export function modal(innerHtml) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">${innerHtml}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  return { el: bg, close };
}

// 18px stroke icons for the rail and palette (Task 4 uses these).
export const ICONS = {
  brain: `<svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zm6 0a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z"/></svg>`,
  capture: `<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>`,
  history: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>`,
  graph: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8 7l8 1M8 8l2 8M16 10l-6 8"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>`,
  reflect: `<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>`,
  settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/></svg>`,
};
```

`static/js/state.js`:

```js
// The only mutable app state. Views import `state` and mutate its properties.
import { api } from "./api.js";

export const state = {
  status: { ai: false, whisper: false, provider: "off", model: "", version: "", data_dir: "" },
  curMode: "freeform",
  draft: "",
  pollTimer: null,
  themes: [],
  activeTheme: "midnight",
};

const subs = {};
export function on(ev, fn) { (subs[ev] ||= []).push(fn); }
export function emit(ev, data) { (subs[ev] || []).forEach((f) => f(data)); }

export function clearPoll() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

export async function refreshStatus() {
  try { state.status = await api.get("/status"); } catch {}
  emit("status", state.status);
}
```

`static/js/router.js`:

```js
// Hash router with sub-paths: #history/abc, #tasks/today, #settings/ai.
import { clearPoll, emit } from "./state.js";

const routes = {};
let setTitle = () => {};  // Task 4's shell replaces this via setTitleHandler()

export function register(name, render) { routes[name] = render; }
export function setTitleHandler(fn) { setTitle = fn; }

export function parse() {
  const h = location.hash.slice(1) || "capture";
  const [name, ...rest] = h.split("/");
  return { name, params: rest.map((p) => { try { return decodeURIComponent(p); } catch { return p; } }) };
}

export function go(hash) {
  if (location.hash === "#" + hash) route();
  else location.hash = hash;
}

export function route() {
  clearPoll();
  const { name, params } = parse();
  if (name === "dump" && params[0]) { location.replace("#history/" + params[0]); return; }  // legacy links
  const render = routes[name] || routes.capture;
  emit("route", { name, params });
  const v = document.querySelector("#view");
  v.classList.remove("fade"); void v.offsetWidth; v.classList.add("fade");
  render({ name, params, setTitle });
}

export function start() {
  window.addEventListener("hashchange", route);
  // A link whose hash equals the CURRENT hash fires no hashchange — re-route manually.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute("href") === (location.hash || "#capture")) { e.preventDefault(); route(); }
  });
  route();
}
```

`static/js/native.js` — move `app.js` lines 223-318 (native bridge, updater, What's New) into this module with these edits: add at top `import { $, esc, md, toast, modal } from "./ui.js"; import { api } from "./api.js"; import { state } from "./state.js";`; `export const native = window.__TAURI__ || null;`; wrap the document click listener and `$("#update-pill").onclick = showUpdateModal;` inside `export function initNative() { … }`; replace `status.version` with `state.status.version`; `export` the functions `openExternal, checkForUpdates, showUpdateModal, maybeShowWhatsNew, showWhatsNew`. Keep the modal markup as is (Task 4 restyles).

`static/js/main.js`:

```js
// Boot: theme first-paint is in index.html; here: status → routes → views.
import { state, refreshStatus } from "./state.js";
import { register, start } from "./router.js";
import { initNative, maybeShowWhatsNew, checkForUpdates } from "./native.js";
import * as capture from "./views/capture.js";
import * as history from "./views/history.js";
import * as tasks from "./views/tasks.js";
import * as graph from "./views/graph.js";
import * as search from "./views/search.js";
import * as reflect from "./views/reflect.js";
import * as settings from "./views/settings.js";

register("capture", capture.render);
register("history", history.render);
register("tasks", tasks.render);
register("graph", graph.render);
register("search", search.render);
register("reflect", reflect.render);
register("settings", settings.render);

(async () => {
  await refreshStatus();
  initNative();
  start();
  maybeShowWhatsNew();
  checkForUpdates();
})();
```

- [x] **Step 2: View modules — mechanical moves.** For each, create the file with the imports listed, paste the referenced `app.js` lines, and apply the substitutions: `status.` → `state.status.`, `curMode` → `state.curMode`, `draft` → `state.draft`, `pollTimer` → `state.pollTimer` (and `clearInterval(pollTimer); pollTimer = null` → `clearPoll()`), `view()` → `$("#view")`, `location.hash='dump/…'` stays (router redirects), function `renderX` → `export function render(ctx)` (async where it was).

| File | app.js lines | Imports |
|---|---|---|
| `views/review.js` | 90-169 (gcalUrl, calBtns, dueWrap, paintDue, bindDue) + 402-479 (itemRow, bindItemRows, reviewHtml, renderReview) | `$, $$, esc, md, toast, fmtDate, fmtDay, fmtTime, todayIso, MODES` from ui, `api`, `state` |
| `views/capture.js` | 322-398 (renderCapture→render, submitDump, renderProcessing) + 1091-1133 (voice) | ui `$, $$, esc, toast, MODES, STAGES`, `api`, `state, clearPoll`, `renderReview` from review |
| `views/history.js` | 483-525 (renderHistory→render; keep renderDumpDetail and call it when `ctx.params[0]` is set) | ui, api, state, review (`reviewHtml, bindItemRows`), `renderProcessing` from capture |
| `views/tasks.js` | 529-575 | ui `$, $$, esc, todayIso`, api, review `dueWrap, bindDue, calBtns` |
| `views/search.js` | 579-604 | ui `$, esc, fmtDate`, api, state |
| `views/reflect.js` | 608-633 | ui `$, $$, md`, api |
| `views/graph.js` | 637-883 | ui `$, esc`, api |
| `views/settings.js` | 887-1087 (PROVIDER_META, renderSettings→render, ENGINE_PHASES, paintEnginePanel) + THEMES/setTheme/curTheme from lines 39-52 (temporary; Task 3 replaces) | ui `$, $$, esc, toast`, api, `state, clearPoll, refreshStatus`, native `native, showWhatsNew, checkForUpdates` |

In `history.js`, `render(ctx)` = `ctx.params[0] ? renderDumpDetail(ctx.params[0]) : renderHistory()`; the old `#dump/<id>` links keep working through the router redirect.

- [x] **Step 3: index.html.** Replace `<script src="app.js?v=0.5.0"></script>` with `<script type="module" src="js/main.js?v=0.5.0"></script>`. Add to `package.json` scripts: `"lint:js": "node -e \"const fs=require('fs'),p=require('path');const walk=d=>fs.readdirSync(d).flatMap(f=>{const q=p.join(d,f);return fs.statSync(q).isDirectory()?walk(q):q.endsWith('.js')?[q]:[]});for(const f of walk('static/js')){require('child_process').execFileSync(process.execPath,['--check',f]);console.log('ok',f)}\""`.

- [x] **Step 4: Verify** (browser mode, port 8779): every view renders and behaves as before — capture a dump (AI on), processing → review, history → detail → delete, tasks due-date edit, search, reflect generate, graph drag, settings save/test, theme switch, What's new. `npm run lint:js` prints `ok` for 16 files. No console errors.

- [x] **Step 5: Commit**

```bash
git add static/index.html static/js package.json
git commit -m "refactor(ui): split app.js into ES modules (no visual change)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Theme runtime (`theme.js`, tokens.css, Appearance uses the API)

**Files:**
- Create: `static/js/theme.js`, `static/css/tokens.css`
- Modify: `static/index.html` (first-paint script, tokens.css link), `static/style.css` (delete the per-theme blocks lines 4-54, keep the rest for now), `static/js/views/settings.js` (Appearance grid from API + import/export/delete), `static/js/main.js` (`loadThemes()`)

**Interfaces:**
- `theme.js`: `export function apply(theme), cssVars(theme), setDensity(id), setMotion(id); export async function loadThemes(), setActive(id), importTheme(file), deleteTheme(id); export function exportUrl(id)`.
- `localStorage`: `bdl-theme` (id), `bdl-theme-css` (`{id, scheme, vars}`), `bdl-density` (`comfortable|compact`), `bdl-motion` (`auto|reduce`).

- [x] **Step 1: `static/js/theme.js`**

```js
// Applies a theme (from /api/themes) as CSS custom properties on <html>.
// index.html re-applies the cached vars before first paint, so no flash.
import { api } from "./api.js";
import { state, emit } from "./state.js";

const KEYS = ["bg", "rail", "panel", "panel2", "line", "text", "dim", "accent", "accent2", "accentSoft", "green", "red", "amber"];
const CSS = { panel2: "--panel-2", accent2: "--accent-2", accentSoft: "--accent-soft" };

export function cssVars(theme) {
  const out = {};
  for (const k of KEYS) out[CSS[k] || "--" + k] = theme.colors[k];
  out["--radius"] = (theme.radius || 12) + "px";
  return out;
}

export function apply(theme) {
  const root = document.documentElement;
  const vars = cssVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  try {
    localStorage.setItem("bdl-theme", theme.id);
    localStorage.setItem("bdl-theme-css", JSON.stringify({ id: theme.id, scheme: theme.scheme, vars }));
  } catch {}
  state.activeTheme = theme.id;
  emit("theme", theme);
}

export async function loadThemes() {
  try {
    const { active, themes } = await api.get("/themes");
    state.themes = themes;
    const t = themes.find((x) => x.id === active) || themes[0];
    if (t) apply(t);
  } catch {}  // cached vars from index.html stay in effect
}

export async function setActive(id) {
  await api.put("/themes/active", { id });
  const t = state.themes.find((x) => x.id === id);
  if (t) apply(t);
}

export async function importTheme(file) {
  let json;
  try { json = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON."); }
  const t = await api.post("/themes/import", json);
  await loadThemes();
  return t;
}

export async function deleteTheme(id) {
  await api.del("/themes/" + encodeURIComponent(id));
  await loadThemes();
}

export const exportUrl = (id) => "/api/themes/" + encodeURIComponent(id) + "/export";

// Density + motion are per-device preferences (localStorage only).
export function setDensity(v) {
  document.documentElement.dataset.density = v;
  try { localStorage.setItem("bdl-density", v); } catch {}
}
export function setMotion(v) {
  document.documentElement.dataset.motion = v;
  try { localStorage.setItem("bdl-motion", v); } catch {}
}
export function restorePrefs() {
  try {
    setDensity(localStorage.getItem("bdl-density") || "comfortable");
    setMotion(localStorage.getItem("bdl-motion") || "auto");
  } catch {}
}
```

- [x] **Step 2: `static/css/tokens.css`** (defaults = Midnight; themes override on `<html style>`):

```css
/* Design tokens. Values here are the Midnight defaults; the active theme
   overrides them as inline custom properties on <html> (see js/theme.js). */
@font-face {
  font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap;
  src: url("../fonts/InterVariable.woff2") format("woff2");
}
:root {
  --bg: #0d1017; --rail: #0a0d13; --panel: #151b28; --panel-2: #1b2334; --line: #263049;
  --text: #e6e9f2; --dim: #8b93a8;
  --accent: #8b7cf6; --accent-2: #5ea2f7; --accent-soft: rgba(139, 124, 246, .16);
  --green: #4ade80; --red: #f87171; --amber: #fbbf24;
  --radius: 12px; --radius-lg: 14px;
  --shadow: 0 6px 24px rgba(0, 0, 0, .25);
  --sp: 8px;                      /* spacing unit */
  --fs: 14px;                     /* base font size */
  --row-pad: 12px;
  --font: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: ui-monospace, Consolas, "Cascadia Mono", monospace;
  --ease: 150ms ease;
  color-scheme: dark;
}
:root[data-density="compact"] { --sp: 6px; --fs: 13px; --row-pad: 8px; }
:root[data-motion="reduce"] *, :root[data-motion="reduce"] *::before, :root[data-motion="reduce"] *::after {
  animation: none !important; transition: none !important;
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="auto"]) *, :root:not([data-motion="auto"]) *::before, :root:not([data-motion="auto"]) *::after {
    animation: none !important; transition: none !important;
  }
}
```

- [x] **Step 3: Font file.** Download Inter (PowerShell; the zip is ~10 MB, the woff2 ~350 KB):

```powershell
Invoke-WebRequest https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip -OutFile "$env:TEMP\inter.zip"
Expand-Archive "$env:TEMP\inter.zip" "$env:TEMP\inter" -Force
New-Item -ItemType Directory -Force static\fonts | Out-Null
Copy-Item (Get-ChildItem "$env:TEMP\inter" -Recurse -Filter InterVariable.woff2 | Select-Object -First 1).FullName static\fonts\InterVariable.woff2
(Get-Item static\fonts\InterVariable.woff2).Length
```
Expected: a file of roughly 300-400 KB. Add `static/fonts/LICENSE.txt` with the OFL text from the zip (`LICENSE.txt`).

- [x] **Step 4: index.html head.** Replace the existing inline theme script with:

```html
<link rel="stylesheet" href="css/tokens.css?v=0.5.0">
<link rel="stylesheet" href="style.css?v=0.5.0">
<script>
/* Re-apply the cached theme + prefs before first paint — no flash of Midnight. */
try {
  var r = document.documentElement, c = JSON.parse(localStorage.getItem("bdl-theme-css") || "null");
  if (c) { for (var k in c.vars) r.style.setProperty(k, c.vars[k]); r.dataset.theme = c.id; r.style.colorScheme = c.scheme; }
  r.dataset.density = localStorage.getItem("bdl-density") || "comfortable";
  r.dataset.motion = localStorage.getItem("bdl-motion") || "auto";
} catch (e) {}
</script>
```
In `style.css` delete the six `:root[data-theme=…]` blocks (lines 4-54) and change the `body` font to `font: var(--fs)/1.55 var(--font);`. In `main.js` import `{ loadThemes, restorePrefs }` from `./theme.js`, call `restorePrefs()` first thing and `loadThemes()` right after `refreshStatus()`.

- [x] **Step 5: Appearance in settings.js (temporary home until Task 6).** Replace the `THEMES`/`setTheme`/`curTheme` copies and the theme-swatch markup with:

```js
import { setActive, importTheme, deleteTheme, exportUrl } from "../theme.js";
// …inside paint():
      <div class="themes" style="margin-bottom:12px">${state.themes.map((t) => `
        <button class="theme-swatch ${t.id === state.activeTheme ? "active" : ""}" data-theme="${t.id}" title="${esc(t.name)}">
          <div class="sw"><i style="background:${t.colors.bg}"></i><i style="background:${t.colors.panel}"></i><i style="background:${t.colors.accent}"></i></div>
          <span>${esc(t.name)}</span></button>`).join("")}
      </div>
      <div class="row" style="margin-bottom:24px">
        <label class="btn ghost small">Import theme… <input type="file" id="theme-file" accept=".json,application/json" hidden></label>
        <a class="btn ghost small" href="${exportUrl(state.activeTheme)}" download>Export current</a>
        ${state.themes.find((t) => t.id === state.activeTheme && !["midnight","ocean","forest","ember","paper","sakura"].includes(t.id)) ? `<button class="btn danger small" id="theme-del">Delete current</button>` : ""}
        <span class="small muted" id="theme-msg"></span>
      </div>
// …bindings:
    $$(".theme-swatch").forEach((b) => b.onclick = async () => { await setActive(b.dataset.theme); paint(); });
    $("#theme-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const t = await importTheme(f); await setActive(t.id); paint(); toast(`Imported "${t.name}"`); }
      catch (err) { $("#theme-msg").textContent = err.message; }
    };
    if ($("#theme-del")) $("#theme-del").onclick = async () => { await deleteTheme(state.activeTheme); await setActive("midnight"); paint(); };
```

- [x] **Step 6: Verify.** Themes switch instantly and survive reload with no flash (check `localStorage bdl-theme-css`); reload with the backend stopped still shows the chosen theme; import the `GOOD` theme from `tests/test_themes.py` saved as a file → appears, applies, exports as a download, deletes; light themes flip `color-scheme`. Inter renders (DevTools → Computed → font-family shows Inter). `npm run lint:js` + `pytest -q` pass.

- [x] **Step 7: Commit**

```bash
git add static/ package.json
git commit -m "feat(ui): API-driven theme runtime, tokens.css, bundled Inter, theme import/export UI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Shell — rail, top bar, layout, sub-routes

**Files:**
- Create: `static/js/shell.js`, `static/css/shell.css`
- Modify: `static/index.html` (skeleton), `static/js/main.js`, `static/js/native.js` (indicators call shell), `static/style.css` (delete header/nav/main rules lines 79-111; keep the rest until Task 10), every view: call `ctx.setTitle(...)` once at the top of `render`.

**Interfaces:**
- `shell.js`: `export function mountShell(), setTitle(title, slotHtml = ""), setUpdate(version|null), setBusy(bool)`; `NAV` array `[{id, label}]` (Capture, History, Tasks, Graph, Search, Reflect).
- Layout classes (used by later tasks): `.stage` (centered column, 720px), `.split` with `.master`/`.detail`, `.wide` (full-width view), `.topbar-slot` (per-view controls).

- [x] **Step 1: index.html body** becomes:

```html
<body>
<aside id="rail" aria-label="Navigation"></aside>
<div id="main">
  <header id="topbar">
    <h1 id="title">BrainDump Lite</h1>
    <div id="topbar-slot" class="topbar-slot"></div>
    <div class="grow"></div>
    <span id="update-pill" class="pill update" style="display:none;cursor:pointer" title="Click to see what's new and install">⬆ update</span>
    <a href="#settings/ai" id="ai-pill" class="pill off">…</a>
    <span class="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>
  </header>
  <main id="view"></main>
</div>
<div id="palette-root"></div>
<script type="module" src="js/main.js?v=0.5.0"></script>
</body>
```
and the head links `css/tokens.css`, `css/shell.css`, `style.css` (in that order).

- [x] **Step 2: `static/js/shell.js`**

```js
// Left rail + top bar. Views call ctx.setTitle(title, slotHtml) to own the
// top bar's middle slot; the right cluster (AI pill, update pill) is global.
import { $, $$, ICONS, PROVIDER_NAMES, esc } from "./ui.js";
import { state, on } from "./state.js";
import { setTitleHandler, go } from "./router.js";

export const NAV = [
  { id: "capture", label: "Capture" }, { id: "history", label: "History" }, { id: "tasks", label: "Tasks" },
  { id: "graph", label: "Graph" }, { id: "search", label: "Search" }, { id: "reflect", label: "Reflect" },
];

export function mountShell() {
  $("#rail").innerHTML = `
    <a class="brain" href="#capture" title="BrainDump Lite">${ICONS.brain}</a>
    ${NAV.map((n) => `<a class="nav" data-v="${n.id}" href="#${n.id}" title="${n.label}">${ICONS[n.id]}<span>${n.label}</span></a>`).join("")}
    <div class="grow"></div>
    <span class="ai-dot" id="ai-dot" title="AI off"></span>
    <a class="nav" data-v="settings" href="#settings" title="Settings">${ICONS.settings}<span>Settings</span><i class="badge" id="rail-badge" hidden></i></a>`;
  on("route", ({ name }) => $$("#rail .nav").forEach((a) => a.classList.toggle("active", a.dataset.v === name)));
  on("status", paintStatus);
  setTitleHandler(setTitle);
  paintStatus(state.status);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); go("capture"); setTimeout(() => $("#dump-text")?.focus(), 50); }
  });
}

export function setTitle(title, slotHtml = "") {
  $("#title").textContent = title;
  $("#topbar-slot").innerHTML = slotHtml;
  document.title = title === "Capture" ? "BrainDump Lite" : `${title} · BrainDump Lite`;
}

function paintStatus(status) {
  const pill = $("#ai-pill"), dot = $("#ai-dot");
  if (status.ai) {
    pill.className = "pill on"; pill.textContent = `● ${PROVIDER_NAMES[status.provider] || status.provider}`; pill.title = status.model;
    dot.classList.add("on"); dot.title = pill.textContent;
  } else {
    pill.className = "pill off"; pill.textContent = "○ AI off"; pill.title = "";
    dot.classList.remove("on"); dot.title = "AI off";
  }
}

export function setUpdate(version) {
  const pill = $("#update-pill"), badge = $("#rail-badge");
  if (version) { pill.textContent = `⬆ v${esc(version)}`; pill.style.display = ""; badge.hidden = false; }
  else { pill.style.display = "none"; badge.hidden = true; }
}
```
In `native.js`, `checkForUpdates` replaces its direct `#update-pill` writes with `setUpdate(u.version)` (import from `./shell.js`). In `main.js` call `mountShell()` before `refreshStatus()`.

- [x] **Step 3: `static/css/shell.css`**

```css
* { box-sizing: border-box; margin: 0; }
* { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
::-webkit-scrollbar-track { background: transparent; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--text); font: var(--fs)/1.5 var(--font); display: flex; overflow: hidden; }
a { color: inherit; text-decoration: none; }
button { font: inherit; cursor: pointer; border: none; border-radius: 10px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
kbd { font: 11px var(--mono); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; color: var(--dim); background: var(--panel); }
.grow { flex: 1; }
.row { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.muted { color: var(--dim); } .small { font-size: 12.5px; }

/* ── Rail ─────────────────────────────────────────────────────────────────── */
#rail { width: 60px; flex: none; background: var(--rail); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; }
#rail .brain { width: 32px; height: 32px; border-radius: 10px; margin-bottom: 14px; display: grid; place-items: center;
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; box-shadow: 0 0 18px var(--accent-soft); }
#rail .brain svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.8; }
#rail .nav { position: relative; width: 48px; height: 48px; border-radius: 10px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 3px; color: var(--dim); font-size: 9.5px; letter-spacing: .02em; transition: background var(--ease), color var(--ease); }
#rail .nav svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
#rail .nav:hover { color: var(--text); background: var(--panel); }
#rail .nav.active { background: var(--accent-soft); color: var(--accent); }
#rail .badge { position: absolute; top: 6px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 6px var(--amber); }
#rail .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin: 6px 0; }
#rail .ai-dot.on { background: var(--green); box-shadow: 0 0 8px var(--green); }

/* ── Main column ──────────────────────────────────────────────────────────── */
#main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
#topbar { height: 52px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--line); }
#topbar h1 { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
.topbar-slot { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12.5px; }
.kbd-hint { display: flex; gap: 3px; opacity: .7; }
#view { flex: 1; min-height: 0; overflow: auto; position: relative; }
@keyframes rise { from { opacity: 0; transform: translateY(7px); } }
#view.fade > * { animation: rise .18s ease-out; }

/* View layouts */
.stage { max-width: 760px; margin: 0 auto; padding: 28px 20px 90px; }
.wide { padding: 16px 20px 24px; height: 100%; display: flex; flex-direction: column; }
.split { display: flex; height: 100%; min-height: 0; }
.split .master { width: 360px; flex: none; border-right: 1px solid var(--line); overflow: auto; display: flex; flex-direction: column; }
.split .detail { flex: 1; min-width: 0; overflow: auto; padding: 24px 32px 60px; }
.split .back { display: none; }
@media (max-width: 959px) {              /* 60px rail + 900px content */
  .split .master { width: 100%; border-right: 0; }
  .split.has-detail .master { display: none; }
  .split:not(.has-detail) .detail { display: none; }
  .split .back { display: inline-flex; margin-bottom: 12px; }
}

/* ── Pills, buttons, cards, chips ─────────────────────────────────────────── */
.pill { font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--dim); }
.pill.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill.update { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); animation: glowpulse 2s infinite; }
@keyframes glowpulse { 50% { opacity: .6; } }
.btn { background: var(--accent); color: #fff; font-weight: 600; padding: 9px 16px; border-radius: 10px; font-size: 13.5px;
  box-shadow: 0 6px 20px var(--accent-soft); transition: filter var(--ease), transform .12s; display: inline-flex; align-items: center; gap: 6px; }
.btn:hover { filter: brightness(1.1); } .btn:active { transform: scale(.98); } .btn:disabled { opacity: .45; cursor: default; }
.btn.ghost { background: var(--panel-2); color: var(--text); font-weight: 500; border: 1px solid var(--line); box-shadow: none; }
.btn.danger { background: transparent; color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); box-shadow: none; }
.btn.small { padding: 6px 11px; font-size: 12.5px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 16px 18px; margin-bottom: 14px;
  transition: border-color var(--ease), transform .12s, box-shadow var(--ease); }
.card.click:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); cursor: pointer; transform: translateY(-1px); box-shadow: var(--shadow); }
.chip { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); background: transparent; }
.chip.on, .chip.active { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.sec { color: var(--dim); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin: 18px 0 8px; }
h1.page { font-size: 24px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 4px; }
h2 { font-size: 16px; font-weight: 600; letter-spacing: -.01em; margin-bottom: 10px; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
input[type=text], input[type=password], select, textarea { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 12px; transition: border-color var(--ease); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
.field { margin-bottom: 12px; } .field label { display: block; color: var(--dim); font-size: 12px; margin-bottom: 5px; }
.center { text-align: center; color: var(--dim); padding: 40px 0; } .center .big { font-size: 40px; margin-bottom: 8px; }

/* ── Modal, toast ─────────────────────────────────────────────────────────── */
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); max-width: 560px; width: 100%; max-height: 80vh; overflow: auto; padding: 22px 24px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
.modal h2 { margin-top: 0; } .modal .md { margin-bottom: 16px; }
.progress { height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; margin: 12px 0; }
.progress > i { display: block; height: 100%; width: 0; transition: width .2s; background: var(--accent); }
.progress.indet i { animation: indet 1.2s infinite; } @keyframes indet { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 20px); opacity: 0; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; font-size: 13.5px; box-shadow: var(--shadow); transition: all .25s; z-index: 60; }
.toast.show { transform: translate(-50%, 0); opacity: 1; } .toast.bad { border-color: color-mix(in srgb, var(--red) 50%, transparent); }
```
Then in `style.css` delete every rule now defined in shell.css (`header`, `.logo`, `nav`, `.pill*`, `main`, `#view.fade`, `.card*`, `h1`, `h2`, `.sub`, `.muted`, `.small`, `.row`, `.grow`, `.btn*`, `.chip` base, `.field*`, `.center*`, `.toast*`, `.modal*`, `.progress*`, `body::before`) so the two files don't fight.

- [x] **Step 4: Views set their titles and wrappers.** At the top of each `render`: `ctx.setTitle("Capture")` / `"History"` / `"Tasks"` / `"Brain map"` / `"Search"` / `"Reflect"` / `"Settings"`, and wrap each view's root markup in `<div class="stage">…</div>` (Graph: `<div class="wide">…</div>`). Remove the old in-view `<h1>` + `.sub` from Capture only (its stage h1 stays as the big prompt); others keep their `h1.page`.

- [x] **Step 5: Verify.** Rail renders with icons + labels, active item follows the route, AI dot/pill reflect status, update badge appears when `setUpdate("9.9.9")` is called from the console, all views render inside `#view` with correct titles, window at 720px wide shows no horizontal scroll. Check in `tauri dev` too (bump `?v=`): rail looks right in the native window.

- [x] **Step 6: Commit**

```bash
git add static/
git commit -m "feat(ui): Studio shell - left rail, top bar, layout primitives, sub-routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Command palette (Ctrl+K)

**Files:**
- Create: `static/js/palette.js`
- Modify: `static/js/main.js` (`initPalette()`), `static/css/shell.css` (append palette rules)

**Interfaces:**
- `palette.js`: `export function initPalette(), openPalette(), closePalette()`; item shape `{group, label, hint, run}`.

- [x] **Step 1: `static/js/palette.js`**

```js
// Ctrl+K command palette: actions, navigation, recent dumps, themes.
import { $, $$, esc, relTime, ICONS } from "./ui.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { go } from "./router.js";
import { NAV } from "./shell.js";
import { setActive } from "./theme.js";
import { native, checkForUpdates } from "./native.js";

const SECTIONS = [["appearance", "Appearance"], ["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["about", "About"]];
let root, items = [], filtered = [], sel = 0, open = false;

function staticItems() {
  const out = [
    { group: "Actions", label: "New dump", hint: "Ctrl N", run: () => { go("capture"); setTimeout(() => $("#dump-text")?.focus(), 50); } },
  ];
  if (native) out.push({ group: "Actions", label: "Check for updates", run: () => checkForUpdates({ silent: false }) });
  for (const t of state.themes) out.push({ group: "Themes", label: `Switch theme → ${t.name}`, run: () => setActive(t.id) });
  for (const n of NAV) out.push({ group: "Go to", label: n.label, run: () => go(n.id) });
  for (const [id, label] of SECTIONS) out.push({ group: "Go to", label: `Settings → ${label}`, run: () => go("settings/" + id) });
  return out;
}

async function recentItems() {
  try {
    const dumps = await api.get("/dumps?limit=8");
    return dumps.map((d) => ({ group: "Recent dumps", label: d.title || (d.raw_text || "").slice(0, 60) || "Untitled",
      hint: relTime(d.created_at), run: () => go("history/" + d.id) }));
  } catch { return []; }
}

// Subsequence match with bonuses for prefix and word starts; 0 = no match.
export function score(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 60;
  let qi = 0, s = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { s += (i === 0 || t[i - 1] === " ") ? 3 : 1; qi++; }
  }
  return qi === q.length ? s : 0;
}

function paint() {
  const q = $("#pal-q", root).value.trim();
  filtered = items.map((it) => ({ it, s: score(q, it.label) })).filter((x) => x.s > 0)
    .filter((x) => q || x.it.group !== "Themes")          // themes only when searched for
    .sort((a, b) => b.s - a.s).map((x) => x.it).slice(0, 14);
  sel = Math.min(sel, Math.max(0, filtered.length - 1));
  let html = "", lastGroup = null;
  filtered.forEach((it, i) => {
    if (it.group !== lastGroup) { html += `<div class="g">${it.group}</div>`; lastGroup = it.group; }
    html += `<div class="o ${i === sel ? "on" : ""}" data-i="${i}"><span class="ic">${ICONS[it.group === "Go to" ? "search" : "capture"] || ""}</span>${esc(it.label)}${it.hint ? `<span class="r">${esc(it.hint)}</span>` : ""}</div>`;
  });
  $("#pal-list", root).innerHTML = html || `<div class="g">No matches</div>`;
  $(".o.on", root)?.scrollIntoView({ block: "nearest" });
}

function run(i) { const it = filtered[i]; closePalette(); if (it) it.run(); }

export function closePalette() { if (!open) return; open = false; root.innerHTML = ""; }

export async function openPalette() {
  if (open) return;
  open = true; sel = 0;
  root.innerHTML = `<div class="scrim"></div><div class="pal" role="dialog">
    <div class="q"><input id="pal-q" placeholder="Type a command or search…" autocomplete="off"></div>
    <div id="pal-list"></div></div>`;
  items = staticItems();
  paint();
  $("#pal-q", root).focus();
  $("#pal-q", root).oninput = () => { sel = 0; paint(); };
  $(".scrim", root).onclick = closePalette;
  $("#pal-list", root).onclick = (e) => { const o = e.target.closest(".o"); if (o) run(+o.dataset.i); };
  items = items.concat(await recentItems());
  if (open) paint();
}

export function initPalette() {
  root = $("#palette-root");
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open ? closePalette() : openPalette(); return; }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, filtered.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + filtered.length) % Math.max(1, filtered.length); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
  });
  $(".kbd-hint")?.addEventListener("click", openPalette);
}
```
`main.js`: `import { initPalette } from "./palette.js";` and call `initPalette()` after `mountShell()`.

- [x] **Step 2: Palette CSS** (append to `shell.css`):

```css
/* ── Command palette ──────────────────────────────────────────────────────── */
#palette-root .scrim { position: fixed; inset: 0; background: rgba(5,7,11,.55); backdrop-filter: blur(2px); z-index: 70; }
#palette-root .pal { position: fixed; left: 50%; top: 96px; transform: translateX(-50%); width: min(560px, calc(100vw - 32px)); z-index: 71;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: 0 24px 60px rgba(0,0,0,.5); overflow: hidden; }
#palette-root .q input { width: 100%; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; padding: 13px 16px; font-size: 15px; }
#palette-root .q input:focus { border-color: var(--line); }
#palette-root #pal-list { max-height: 60vh; overflow: auto; padding-bottom: 6px; }
#palette-root .g { padding: 8px 16px 2px; color: var(--dim); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; }
#palette-root .o { display: flex; align-items: center; gap: 10px; padding: 8px 16px; font-size: 13.5px; cursor: pointer; }
#palette-root .o.on, #palette-root .o:hover { background: var(--accent-soft); }
#palette-root .o .ic { width: 22px; height: 22px; border-radius: 6px; background: var(--panel-2); flex: none; display: grid; place-items: center; }
#palette-root .o .ic svg { width: 13px; height: 13px; stroke: var(--dim); fill: none; stroke-width: 1.8; }
#palette-root .o .r { margin-left: auto; color: var(--dim); font-size: 11.5px; font-family: var(--mono); }
```

- [x] **Step 3: Verify.** Ctrl+K opens with Actions/Go to/Recent dumps; typing "oce" surfaces "Switch theme → Ocean" and Enter applies it; arrows + Enter navigate to History; Esc and scrim click close; Ctrl+N focuses the editor; the `Ctrl K` hint in the top bar opens it. Quick unit check of `score` in the console: `score("hst","History") > 0`, `score("zzz","History") === 0`.

- [x] **Step 4: Commit**

```bash
git add static/
git commit -m "feat(ui): Ctrl+K command palette (actions, navigation, recent dumps, themes)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Settings — sections + Advanced toggles + Data section

**Files:**
- Rewrite: `static/js/views/settings.js`
- Modify: `static/css/views.css` (create; move settings/engine/theme-picker rules from style.css and add sub-nav/advanced rules)

**Interfaces:**
- Route `#settings/<section>` (`appearance|ai|voice|data|about`, default `appearance`).
- `advOn(section) -> bool`, `setAdv(section, bool)` persisted in `localStorage bdl-adv-<section>`.
- Native reveal: `native.opener.revealItemInDir(path)`.

- [x] **Step 1: Rewrite `settings.js`** around this skeleton (keep `PROVIDER_META`, `ENGINE_PHASES`, `paintEnginePanel` from Task 2 unchanged; the Appearance bindings from Task 3 move into `sectionAppearance`):

```js
import { $, $$, esc, toast } from "../ui.js";
import { api } from "../api.js";
import { state, clearPoll, refreshStatus } from "../state.js";
import { native, showWhatsNew, checkForUpdates } from "../native.js";
import { setActive, importTheme, deleteTheme, exportUrl, setDensity, setMotion } from "../theme.js";
import { go } from "../router.js";

const SECTIONS = [["appearance", "Appearance"], ["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["about", "About"]];
const BUILTIN_IDS = ["midnight", "ocean", "forest", "ember", "paper", "sakura"];
const advOn = (s) => { try { return localStorage.getItem("bdl-adv-" + s) === "1"; } catch { return false; } };
const setAdv = (s, v) => { try { localStorage.setItem("bdl-adv-" + s, v ? "1" : "0"); } catch {} };

export async function render(ctx) {
  const section = SECTIONS.some(([id]) => id === ctx.params[0]) ? ctx.params[0] : "appearance";
  ctx.setTitle("Settings");
  $("#view").innerHTML = `<div class="split settings">
    <nav class="master subnav">${SECTIONS.map(([id, label]) => `<a href="#settings/${id}" class="${id === section ? "on" : ""}">${label}</a>`).join("")}</nav>
    <div class="detail body" id="sec"></div></div>`;
  const s = await api.get("/settings");
  const paint = { appearance: sectionAppearance, ai: sectionAI, voice: sectionVoice, data: sectionData, about: sectionAbout }[section];
  paint($("#sec"), s);
}

// Header with the Advanced switch; `hasAdv=false` hides the switch.
function head(box, section, title, hasAdv, repaint) {
  const on = advOn(section);
  box.innerHTML = `<div class="h"><h2>${title}</h2><div class="grow"></div>
    ${hasAdv ? `<label class="sw">Advanced <input type="checkbox" id="adv" ${on ? "checked" : ""}><i></i></label>` : ""}</div><div id="body"></div>`;
  if (hasAdv) $("#adv", box).onchange = (e) => { setAdv(section, e.target.checked); repaint(); };
  return { on, body: $("#body", box) };
}
```

Section bodies (each is `function sectionX(box, s)` that calls `head(...)` then fills `body`; on Advanced toggle it re-calls itself):
- **Appearance**: theme grid + import/export/delete (Task 3 markup, `title: "Appearance"`, `hasAdv: true`). Advanced: `Density` select (`comfortable|compact` → `setDensity`), `Motion` select (`auto|reduce` → `setMotion`), both read from `document.documentElement.dataset`.
- **AI**: provider cards (`.providers`), then the provider `help` text, then for `builtin` the `#engine-panel` (call `paintEnginePanel()`), for cloud providers the API key field, then Save/Test/`#test-out` row. Advanced (`hasAdv: true`): for non-builtin/off providers the base URL (`local`), chat model + List button, embedding model (not for anthropic); for `builtin` read-only rows: engine folder (`state.status.data_dir + "\\engine"`), ports `chat 8790 · embed 8820`, context `4096 tokens` (display only). `gather()` reads whatever fields exist (same pattern as today), so Save works with Advanced off (server keeps stored values for fields not sent: `SettingsIn` fields are optional).
- **Voice**: whisper model select + Save (`hasAdv: false`).
- **Data**: `<code>` path from `state.status.data_dir`, buttons: "Reveal in Explorer" (native: `native.opener.revealItemInDir(path).catch(e => toast(String(e), true))`; browser: `navigator.clipboard.writeText(path)` + toast "Path copied"), note "Delete that folder to wipe everything." (`hasAdv: false`).
- **About**: version line (`native ? "native app" : "browser mode"`), What's new, Check for updates (native only) — Task 2's markup (`hasAdv: false`).

- [x] **Step 2: `static/css/views.css`** — create it, move these blocks from `style.css` unchanged: Capture (130-187), Pipeline progress (188-201), Items (202-226), Editable due date (227-265), Lists (266-280), Settings (281-296), Built-in engine panel (297-314), Theme picker (315-330), Graph (331-343), `.md p/.md ul` (354-355). Append:

```css
/* ── Settings sections ───────────────────────────────────────────────────── */
.settings .subnav { width: 200px; padding: 14px 10px; gap: 2px; }
.settings .subnav a { padding: 8px 12px; border-radius: 8px; color: var(--dim); font-size: 13.5px; }
.settings .subnav a.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.settings .body { max-width: 780px; }
.settings .h { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.settings .h h2 { font-size: 18px; font-weight: 650; margin: 0; }
.sw { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12.5px; cursor: pointer; }
.sw input { display: none; }
.sw i { width: 34px; height: 19px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); position: relative; transition: background var(--ease); }
.sw i::after { content: ""; position: absolute; left: 2px; top: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--dim); transition: transform var(--ease), background var(--ease); }
.sw input:checked + i { background: var(--accent); border-color: transparent; }
.sw input:checked + i::after { transform: translateX(15px); background: #fff; }
.adv { border-left: 2px solid var(--accent); padding-left: 14px; margin-top: 16px; }
.adv .ro { font: 12.5px var(--mono); color: #c5cbdb; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; }
```
Link `css/views.css` in `index.html` after `shell.css`; `style.css` stays linked until Task 10 (it should now contain only Voice/graph leftovers — check with `grep -c "{" static/style.css`).

- [x] **Step 3: Verify.** `#settings` opens Appearance; sub-nav switches sections and the URL; Advanced switch state persists per section across reloads; AI section with Built-in shows the engine panel and read-only Advanced rows; with OpenAI shows key + (Advanced) model/embedding fields; Save/Test work with Advanced both on and off; Voice saves; Data reveals the folder in Explorer inside `tauri dev` (copy-path toast in the browser); About buttons work. Palette "Settings → Data" lands on the section.

- [x] **Step 4: Commit**

```bash
git add static/
git commit -m "feat(ui): sectioned Settings with per-section Advanced toggles and Data section

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: History master/detail

**Files:**
- Rewrite: `static/js/views/history.js`
- Modify: `static/css/views.css` (list rows), `static/js/views/review.js` (`reviewHtml` gains a `compact` header variant)

**Interfaces:**
- Route `#history` (wide: auto-selects newest) and `#history/<id>`.
- `reviewHtml(d, {showBack, detail})`: `detail: true` renders the h1/meta/summary/items/related for the right pane and omits the "New dump →" button.

- [x] **Step 1: `history.js`**

```js
import { $, $$, esc, relTime, MODES } from "../ui.js";
import { api } from "../api.js";
import { reviewHtml, bindItemRows } from "./review.js";
import { renderProcessing } from "./capture.js";
import { go } from "../router.js";

let filterMode = "all", filterText = "";

export async function render(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle("History", `<input type="text" id="hist-q" placeholder="Filter dumps…" value="${esc(filterText)}" class="topbar-input">`);
  $("#view").innerHTML = `<div class="split ${id ? "has-detail" : ""}" id="hist">
    <div class="master"><div class="chips" id="hist-chips"></div><div id="hist-list" class="center">Loading…</div></div>
    <div class="detail" id="hist-detail"></div></div>`;
  let dumps;
  try { dumps = await api.get("/dumps?limit=200"); } catch (e) { $("#hist-list").textContent = "Couldn't load: " + e.message; return; }
  const paintList = () => {
    const modes = [["all", "All"], ...MODES.map((m) => [m.id, m.label])];
    $("#hist-chips").innerHTML = modes.map(([v, l]) => `<button class="chip ${v === filterMode ? "on" : ""}" data-m="${v}">${l}</button>`).join("");
    $$("#hist-chips .chip").forEach((b) => b.onclick = () => { filterMode = b.dataset.m; paintList(); });
    const q = filterText.toLowerCase();
    const rows = dumps.filter((d) => (filterMode === "all" || d.mode === filterMode) &&
      (!q || (d.title || "").toLowerCase().includes(q) || (d.raw_text || "").toLowerCase().includes(q)));
    $("#hist-list").className = "";
    $("#hist-list").innerHTML = rows.length ? rows.map((d) => {
      const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
      return `<a class="drow ${d.id === id ? "sel" : ""}" href="#history/${d.id}">
        <b>${esc(d.title || (d.raw_text || "").slice(0, 60) || "Untitled")}</b>
        <div class="m"><span>${relTime(d.created_at)}</span><span class="tag">${mode.label}</span><span>${d.item_count} item${d.item_count === 1 ? "" : "s"}</span>
          ${d.status === "processing" ? "<span>processing…</span>" : d.status === "failed" ? "<span>failed</span>" : ""}</div>
        <p>${esc((d.clean_text || d.raw_text || "").slice(0, 160))}</p></a>`;
    }).join("") : `<div class="center"><div class="big">🌱</div>${dumps.length ? "No dumps match." : `Nothing here yet.<br><br><a class="btn" href="#capture">Make your first dump</a>`}</div>`;
  };
  paintList();
  $("#hist-q").oninput = (e) => { filterText = e.target.value; paintList(); };
  const wide = window.matchMedia("(min-width: 960px)").matches;
  if (!id && wide && dumps.length) { location.replace("#history/" + dumps[0].id); return; }
  if (id) await paintDetail(id);
}

async function paintDetail(id) {
  const box = $("#hist-detail");
  box.innerHTML = `<div class="center">Loading…</div>`;
  let d;
  try { d = await api.get("/dumps/" + id); } catch { box.innerHTML = `<div class="center">Dump not found. <a href="#history">Back</a></div>`; return; }
  if (d.status === "processing" || d.status === "pending") { renderProcessing(id, box); return; }
  box.innerHTML = `<a class="btn ghost small back" href="#history">← All dumps</a>` + reviewHtml(d, { showBack: false, detail: true });
  bindItemRows(box, d.items, () => paintDetail(id));
  if ($("#approve-all", box)) $("#approve-all", box).onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) { await api.patch("/items/" + it.id, { status: "approved" }); it.status = "approved"; }
    $$("#items .item:not(.rejected) .ok", box).forEach((b) => b.classList.add("active"));
  };
  $("#delete-dump", box).onclick = async () => {
    if (!confirm("Delete this dump and its items?")) return;
    await api.del("/dumps/" + id);
    go("history");
  };
}
```
`renderProcessing(id, container = $("#view"))` in `capture.js` gains an optional container so the detail pane can show the stage progress. In `review.js`, `reviewHtml` with `detail: true` renders `<h1 class="page">`, the meta line as `<div class="meta">${mode.label} · ${fmtDate(...)} · ${items} items</div>`, the summary/reflection/items/related/raw sections, and a final row with only the Delete button (`id="delete-dump"`).

- [x] **Step 2: CSS** (append to `views.css`):

```css
.chips { display: flex; gap: 6px; padding: 12px 14px 8px; flex-wrap: wrap; }
.topbar-input { width: 260px; padding: 5px 10px; font-size: 12.5px; }
.drow { display: block; padding: var(--row-pad) 16px; border-bottom: 1px solid var(--line); transition: background var(--ease); }
.drow:hover { background: color-mix(in srgb, var(--panel) 60%, transparent); }
.drow.sel { background: var(--panel); box-shadow: inset 3px 0 0 var(--accent); }
.drow b { display: block; font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
.drow .m { color: var(--dim); font-size: 11.5px; display: flex; gap: 8px; margin-bottom: 4px; }
.drow p { color: color-mix(in srgb, var(--text) 75%, var(--dim)); font-size: 12.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tag { font-size: 10.5px; padding: 1px 7px; border-radius: 5px; background: var(--panel-2); color: var(--dim); }
.meta { color: var(--dim); font-size: 12.5px; margin-bottom: 18px; display: flex; gap: 14px; }
```

- [x] **Step 3: Verify.** `#history` on a wide window auto-selects the newest dump and shows it on the right; clicking rows swaps the detail without reloading the list; chips and the top-bar filter narrow the list; `#dump/<id>` legacy links redirect to `#history/<id>`; at 800px width the list shows alone, a row opens the detail with "← All dumps"; delete returns to the list; item keep/reject and due-date editing still work in the pane; a processing dump shows the stage progress in the pane.

- [x] **Step 4: Commit**

```bash
git add static/
git commit -m "feat(ui): History as master/detail with filters

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Tasks master/detail

**Files:**
- Rewrite: `static/js/views/tasks.js`
- Modify: `static/css/views.css`

**Interfaces:** route `#tasks/<group>`, groups `overdue|today|upcoming|someday|done`; default = first non-empty in that order.

- [x] **Step 1: `tasks.js`**

```js
import { $, $$, esc, todayIso } from "../ui.js";
import { api } from "../api.js";
import { dueWrap, bindDue, calBtns } from "./review.js";

const GROUPS = [["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["someday", "Someday"], ["done", "Done"]];

export async function render(ctx) {
  ctx.setTitle("Tasks");
  $("#view").innerHTML = `<div class="split has-detail" id="tasks"><div class="master" id="task-groups"></div><div class="detail" id="task-list"><div class="center">Loading…</div></div></div>`;
  const tasks = await api.get("/tasks");
  const today = todayIso(), dayOf = (t) => (t.due_date || "").split("T")[0] || null;
  const by = { overdue: [], today: [], upcoming: [], someday: [], done: [] };
  for (const t of tasks) {
    const day = dayOf(t);
    if (t.done) by.done.push(t); else if (day && day < today) by.overdue.push(t); else if (day === today) by.today.push(t);
    else if (day) by.upcoming.push(t); else by.someday.push(t);
  }
  const group = GROUPS.some(([g]) => g === ctx.params[0]) ? ctx.params[0] : (GROUPS.find(([g]) => by[g].length)?.[0] || "today");
  $("#task-groups").innerHTML = `<div class="glist">${GROUPS.map(([g, label]) => `<a href="#tasks/${g}" class="grow-row ${g === group ? "on" : ""}">
      <span>${label}</span><span class="count">${by[g].length}</span></a>`).join("")}</div>
    <div class="small muted" style="padding:12px 16px">${tasks.length} task${tasks.length === 1 ? "" : "s"} pulled from your dumps.</div>`;
  const list = by[group];
  $("#task-list").innerHTML = `<h1 class="page">${GROUPS.find(([g]) => g === group)[1]}</h1>
    ${list.length ? `<div class="card">${list.map((t) => `
      <div class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <div class="body grow">
          <span class="content">${esc(t.content)}</span>
          ${dueWrap(t)}
          ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
          ${t.status === "suggested" ? `<span class="chip">unreviewed</span>` : ""}
          <div class="detail small muted">from <a href="#history/${t.dump_id}">${esc(t.dump_title || "dump")}</a></div>
        </div>
        ${calBtns(t)}
        <button class="iconbtn no" title="Reject">✕</button>
      </div>`).join("")}</div>`
    : `<div class="center"><div class="big">🧺</div>Nothing in ${GROUPS.find(([g]) => g === group)[1].toLowerCase()}.</div>`}`;
  const reload = () => render(ctx);
  bindDue($("#task-list"), reload);
  $$(".task-row").forEach((el) => {
    const t = tasks.find((x) => x.id === el.dataset.id);
    $("input", el).onchange = async (e) => { await api.patch("/items/" + t.id, { done: e.target.checked, status: "approved" }); reload(); };
    $(".no", el).onclick = async () => { await api.patch("/items/" + t.id, { status: "rejected" }); reload(); };
  });
}
```
Tasks always shows both panes (`has-detail` + the master is a short group list), so at narrow widths the group list sits above the list: add `@media (max-width: 959px) { #tasks { flex-direction: column; } #tasks .master { height: auto; } #tasks .master, #tasks .detail { display: block; } }` in views.css.

- [x] **Step 2: CSS** (append):

```css
.glist { padding: 12px 10px; display: flex; flex-direction: column; gap: 2px; }
.grow-row { display: flex; justify-content: space-between; padding: 9px 12px; border-radius: 8px; color: var(--dim); font-size: 13.5px; }
.grow-row.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.grow-row .count { font-family: var(--mono); font-size: 12px; opacity: .8; }
```

- [x] **Step 3: Verify.** Groups with counts on the left, list on the right; group selection is in the URL; checking a task moves it to Done; due-date edit reloads in place; "from" links open History detail; narrow width stacks.

- [x] **Step 4: Commit**

```bash
git add static/
git commit -m "feat(ui): Tasks as master/detail by due group

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Graph — full width, legend toolbar, resize

**Files:**
- Modify: `static/js/views/graph.js`, `static/css/views.css`

- [x] **Step 1: graph.js changes.**
  - `render(ctx)`: `ctx.setTitle("Brain map", legendHtml())` where `legendHtml()` returns three `.chip` toggles (`data-type="dump|concept|person"`, class `on` unless hidden) with a colored dot; view root is `<div class="wide"><div class="graph-wrap" id="graph-wrap"><canvas id="graph-canvas"></canvas><div id="graph-info" class="graph-info" style="display:none"></div></div></div>`.
  - Keep a module-level `const hidden = new Set()`; chip click toggles the type in `hidden`, re-renders the chip class and calls `mount()` again with `data.nodes.filter((n) => !hidden.has(n.type))` (edges filtered to surviving nodes).
  - In `mountForceGraph`: replace the fixed `H = 560` with `const H = () => wrap.clientHeight;` and use `H()` everywhere `H` was used; `resize()` sets both width and height from the wrap; the wrap is `flex: 1` so the canvas fills the window.
  - `showInfo` links become `#history/${d.id}`; clicking a dump node goes to `history/<id>`.

- [x] **Step 2: CSS** (append; also delete the old `.graph-legend` rules):

```css
.graph-wrap { flex: 1; min-height: 320px; position: relative; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--panel); overflow: hidden; }
#graph-canvas { display: block; cursor: grab; }
.graph-info { position: absolute; right: 14px; top: 14px; width: 260px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); font-size: 13px; }
.legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
```

- [x] **Step 3: Verify.** Canvas fills the content area and follows window resizes; toggling "Concepts" off removes concept nodes and their edges; dump click opens History detail; drag/zoom/pan unchanged; the info box appears top-right.

- [x] **Step 4: Commit**

```bash
git add static/
git commit -m "feat(ui): full-width graph with legend toggles in the top bar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Capture stage, Search/Reflect polish, cleanup, release 0.6.0

**Files:**
- Modify: `static/js/views/{capture,search,reflect}.js`, `static/css/views.css`, `static/index.html`
- Delete: `static/app.js`, `static/style.css`
- Modify: `CHANGELOG.md`, `README.md` (frontend layout section)

- [x] **Step 1: Capture stage.** In `capture.js` wrap the view in `<div class="stage capture"><div class="glow"></div>…</div>`; the prompt `h1` becomes `<h1 class="hero">What's on your mind?</h1>`; the editor gets `class="editor"`; the bottom row: mic, `Ctrl+Enter` hint, `grow`, Dump button. Move the remaining `style.css` Capture rules into `views.css` and add:

```css
.stage.capture { position: relative; padding-top: 72px; }
.stage.capture .glow { position: absolute; top: -140px; left: 50%; width: 700px; height: 420px; transform: translateX(-50%); pointer-events: none;
  background: radial-gradient(ellipse at center, var(--accent-soft), transparent 65%); }
.hero { font-size: 26px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 4px; }
.editor { width: 100%; min-height: 200px; resize: vertical; font-size: 15px; line-height: 1.55; padding: 16px; border-radius: var(--radius-lg); box-shadow: 0 12px 40px rgba(0,0,0,.25); }
```
Processing/Review keep the `.stage` column.

- [x] **Step 2: Search + Reflect.** Both use `.stage`; Search's input moves into the top-bar slot (`ctx.setTitle("Search", <input id="q" class="topbar-input" …>)`) with results in the stage as `.card.click` rows linking to `#history/<id>`; Reflect unchanged apart from `h1.page`.

- [x] **Step 3: Cleanup.** `git rm static/app.js static/style.css`; remove the `style.css` link from `index.html`; `grep -rn "style.css\|app.js" static/ src-tauri/ README.md` must return only the README layout text (update it: `static/js/*` modules, `static/css/*`). Run `npm run lint:js`, `pytest -q`.

- [x] **Step 4: Full visual pass in `tauri dev`** (bump `?v=` to force WebView2 to refetch): every view, every theme (light ones included), density compact, reduced motion, palette, settings sections, master/detail at 720px window width, update pill via `setUpdate`. Fix anything off before committing.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): capture stage, search/reflect polish, remove legacy app.js/style.css

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Release.** Add to `CHANGELOG.md` above 0.5.x:

```markdown
## 0.6.0 — <date>
- New look: a slim left rail, a focused Capture stage, and History/Tasks as list + detail side by side.
- Ctrl+K command palette: jump anywhere, switch themes, open recent dumps.
- Settings reorganised into sections; each has an "Advanced" switch so the basics stay simple.
- Themes are now JSON files: import your own, export the current one.
- Bundled Inter font, compact density and reduced-motion options.
```
Then `git commit -am "docs: 0.6.0 changelog"` and `.\release.ps1 0.6.0`; watch CI; install; confirm the update pill on 0.5.x → 0.6.0 and the What's New panel after relaunch.

---

## Self-review

- **Spec coverage:** rail + top bar (T4) ✓; Capture stage (T10) ✓; master/detail History (T7), Tasks (T8) ✓; Graph full width + legend toolbar (T9) ✓; Search/Reflect centered (T10) ✓; palette groups/shortcuts (T5) ✓; Settings sections + Advanced rule + Data reveal (T6) ✓; theme schema/API/import/export/first-paint cache (T1, T3) ✓; Inter bundled, density, reduced motion (T3) ✓; ES-module structure, app.js/style.css deleted (T2, T10) ✓; tests (T1 pytest, lint:js, Playwright checks per task) ✓; 0.6.0 release (T10) ✓.
- **Placeholders:** `<date>` in the changelog is the only run-time value. Section bodies in T6 are described field-by-field rather than pasted (they are re-arrangements of the existing Task 2 markup the implementer has on screen); every new mechanism (head/Advanced switch, storage keys, native reveal) is given in code.
- **Consistency:** `state.themes`/`state.activeTheme` (T2 state.js) used by T3/T5/T6; `setTitle(title, slotHtml)` signature identical in router.js, shell.js and every view; route names `history/<id>`, `tasks/<group>`, `settings/<section>` match spec, palette and views; CSS class names `.stage .wide .split .master .detail .has-detail .back .topbar-slot .topbar-input .chip .drow .tag .meta .sw .adv` defined in T4/T6/T7 before use; `renderProcessing(id, container)` signature agreed between T2 and T7.
