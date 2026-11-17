"""Tutorial guard (static, no browser). static/js/tour-steps.js lists every tutorial card and what it mirrors in the real app
(routes, DOM ids and classes, button labels, Brain map ribbon tabs and tools, Settings sections, built-in templates, shortcuts).
These tests fail the moment the real code stops matching, so a rename or removal cannot silently leave the tour teaching the
wrong thing. When one fails, walk the tour (docs/TUTORIAL-CHECKLIST.md), fix the card AND its mock, then update tour-steps.js.

Needs Node only to read the data files and the real tool registry (skipped without it); everything else is text checks."""
import base64
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "static" / "js"
GRAPH = JS / "graph"
CSS = ROOT / "static" / "css"
SCENE_FILES = ["tour-scenes.js", "tour-templates.js", "tour-graph.js"]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def _node(script: str, timeout: int = 90) -> dict:
    if shutil.which("node") is None:
        pytest.skip("node not installed")
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def steps():
    src = base64.b64encode((JS / "tour-steps.js").read_bytes()).decode()
    data = _node(f'const m = await import("data:text/javascript;base64,{src}"); console.log(JSON.stringify({{ steps: m.STEPS, screens: m.SCREENS }}));')
    return data


# The real Brain map tool registry, loaded under Node with a tiny DOM stub (same trick as tests/test_graph_ribbon.py).
HARNESS = """
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener: noop }) };
globalThis.document = { addEventListener: noop, createElement: () => ({ getContext: () => ({}), style: {}, classList: { add: noop } }), getElementById: () => null, querySelector: () => null, documentElement: { dataset: {} } };
const G = %(g)s;
await import(G + "plugins.js");
const tb = await import(G + "toolbar.js");
const rt = await import(G + "ribbon-tools.js");
rt.syncRegistryTools();
const str = (v) => { try { return typeof v === "function" ? v() : v; } catch (e) { return ""; } };
console.log(JSON.stringify({ tools: tb.TOOLS.map((t) => ({ id: t.id, tab: t.tab, label: str(t.label), kind: t.kind })), tabs: tb.TABS.map((t) => ({ id: t.id, label: t.label })) }));
"""


@pytest.fixture(scope="module")
def registry():
    return _node(HARNESS % {"g": json.dumps(GRAPH.as_uri() + "/")})


def _by_id(steps):
    return {s["id"]: s for s in steps["steps"]}


# ── the script itself ────────────────────────────────────────────────────────────────────────
def test_steps_are_well_formed_and_short(steps):
    ids = [s["id"] for s in steps["steps"]]
    assert len(ids) == len(set(ids)), "duplicate card ids"
    for s in steps["steps"]:
        for field in ("id", "screen", "title", "blurb", "tip", "mirrors"):
            assert s.get(field), f"{s.get('id')}: missing {field}"
        assert s["screen"] in steps["screens"], s["id"]
        assert len(s["title"]) <= 60 and len(s["blurb"]) <= 320 and len(s["tip"]) <= 150, f"{s['id']}: keep the cards short (one idea each)"
        assert s["mirrors"].get("route"), f"{s['id']}: say which route the card teaches"
        assert s["mirrors"].get("files"), f"{s['id']}: say which real files it mirrors"


def test_every_screen_has_cards_and_cards_of_a_screen_are_together(steps):
    order = [s["screen"] for s in steps["steps"]]
    assert order == sorted(order, key=steps["screens"].index), "cards must follow the rail order"
    for sc in steps["screens"]:
        assert sc in order, f"screen {sc} has no card"


def test_every_card_has_a_mock_scene():
    src = {f: _read(f"static/js/{f}") for f in SCENE_FILES}
    for s in _steps_static():
        pat = re.compile(rf'^  (?:"{re.escape(s)}"|{re.escape(s)}):\s', re.M)
        assert any(pat.search(t) for t in src.values()), f"no scene for card {s} in {SCENE_FILES}"


def _steps_static():
    return re.findall(r'^\s*\{ id: "([\w-]+)", screen:', _read("static/js/tour-steps.js"), re.M)


# ── rail, routes, files, ids, labels ─────────────────────────────────────────────────────────
def test_tour_rail_is_the_real_rail(steps):
    nav = re.findall(r'\{ id: "(\w+)", label: "[^"]+"', _read("static/js/shell.js").split("export const NAV")[1].split("];")[0])
    assert steps["screens"] == nav + ["settings"], "the tour's rail must be the app's rail plus Settings"
    icons = _read("static/js/ui.js").split("export const ICONS")[1]
    for sc in steps["screens"]:
        assert re.search(rf"^\s*{sc}:", icons, re.M), f"no rail icon for {sc}"


def test_routes_exist_in_the_router(steps):
    main = _read("static/js/main.js")
    registered = set(re.findall(r'register\("(\w+)"', main))
    sections = _settings_sections()
    for s in steps["steps"]:
        name, *rest = s["mirrors"]["route"].split("/")
        assert name in registered, f"{s['id']}: route #{name} is not registered in main.js"
        if name == "settings" and rest:
            assert rest[0] in sections, f"{s['id']}: Settings section {rest[0]} does not exist"


def _settings_sections():
    m = re.search(r"const SECTIONS = \[(.*?)\];", _read("static/js/views/settings.js"), re.S)
    return dict(re.findall(r'\["(\w+)", "([^"]+)"\]', m.group(1)))


def test_mirrored_ids_classes_and_labels_exist_in_the_real_code(steps):
    for s in steps["steps"]:
        m = s["mirrors"]
        text = ""
        for f in m["files"]:
            assert (ROOT / f).is_file(), f"{s['id']}: {f} no longer exists"
            text += _read(f).replace("&amp;", "&") + "\n"   # labels are written as HTML in the views
        for i in m.get("ids", []):
            assert re.search(rf'''(?:id="|id: "|#){re.escape(i)}\b''', text), f"{s['id']}: id #{i} is not in {m['files']}"
        for c in m.get("classes", []):
            assert re.search(rf"(?<![\w-]){re.escape(c)}(?![\w])", text) or c in _all_css(), f"{s['id']}: class .{c} is gone from the real code"
        for lbl in m.get("labels", []):
            assert lbl in text, f"{s['id']}: the real app no longer says “{lbl}” (files: {m['files']})"


def _all_css() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in CSS.glob("*.css"))


def test_capture_modes_are_the_real_modes(steps):
    real = re.findall(r'\{ id: "(\w+)", icon: ', _read("static/js/ui.js").split("export const MODES")[1].split("];")[0])
    assert real, "could not read MODES"
    assert _by_id(steps)["capture"]["mirrors"]["modes"] == real


def test_settings_card_lists_every_real_section(steps):
    real = _settings_sections()
    mock = _read("static/js/tour-scenes.js")
    assert set(_by_id(steps)["settings"]["mirrors"]["settings"]) == set(real), "the Settings card must mention every real section"
    for label in real.values():
        assert f'["{label}",' in mock, f"the Settings mock does not describe the “{label}” section"
    for s in steps["steps"]:
        for sec in s["mirrors"].get("settings", []):
            assert sec in real, f"{s['id']}: no Settings section {sec}"


def test_templates_card_uses_real_builtin_templates(steps):
    real = re.findall(r'^\s*\{ id: "(\w+)", label: "(\w+)"', _read("static/js/templates.js"), re.M)
    ids = {i for i, _ in real}
    assert ids, "could not read TEMPLATES"
    for s in steps["steps"]:
        for t in s["mirrors"].get("templates", []):
            assert t in ids, f"{s['id']}: built-in template {t} is gone"
    assert 'from "./templates.js"' in _read("static/js/tour-templates.js"), "the mock must use the real built-in texts"
    # the Capture row the mock copies: pinned buttons + the "Templates" menu button + Manage link
    ui = _read("static/js/templates-ui.js")
    for needle in ("tpl-pins", "tpl-more", "Templates ▾", "Manage templates…", "+ New template", "Restore deleted built-ins"):
        assert needle in ui, needle


# ── Brain map: ribbon tabs and tools ─────────────────────────────────────────────────────────
def test_ribbon_tabs_and_tools_the_tour_names_are_registered(steps, registry):
    tab_ids = [t["id"] for t in registry["tabs"]]
    tools = {t["id"]: t for t in registry["tools"]}
    for s in steps["steps"]:
        m = s["mirrors"]
        for tab in m.get("tabs", []):
            assert tab in tab_ids, f"{s['id']}: ribbon tab {tab} does not exist"
        for tid, label in m.get("tools", {}).items():
            assert tid in tools, f"{s['id']}: ribbon tool {tid} is not registered"
            assert tools[tid]["label"] == label, f"{s['id']}: tool {tid} is now called “{tools[tid]['label']}”, not “{label}”"
            if m.get("tabs") and s["id"] != "graph-ribbon":
                assert tools[tid]["tab"] in m["tabs"] or tools[tid]["id"] in ("undo", "redo", "select"), f"{s['id']}: {tid} lives on the {tools[tid]['tab']} tab"


def test_ribbon_card_names_every_tab_and_the_edit_cards_name_their_tools(steps, registry):
    by = _by_id(steps)
    blurb = by["graph-ribbon"]["blurb"]
    for t in registry["tabs"]:
        assert t["label"] in blurb, f"the ribbon card does not mention the {t['label']} tab"
    assert "?" in by["graph-ribbon"]["blurb"] + by["graph-ribbon"]["tip"]
    tools = {t["id"]: t["label"] for t in registry["tools"]}
    must = {"graph-link": [tools["link"], "Delete", "Ctrl+Z", "Edit"], "graph-merge": [tools["merge"], tools["undo"], "Ctrl+Z", "Edit"]}
    for sid, words in must.items():
        text = by[sid]["blurb"] + " " + by[sid]["tip"]
        for w in words:
            assert w in text, f"{sid}: the card should mention “{w}”"
    # the edit-tab tools the cards teach really are modes / buttons on the Edit tab
    for tid in ("select", "link", "merge", "undo", "redo"):
        assert next(t for t in registry["tools"] if t["id"] == tid)["tab"] == "edit"
    assert next(t for t in registry["tools"] if t["id"] in ("link", "merge"))["kind"] == "mode"


def test_graph_mock_draws_its_ribbon_from_the_real_registry():
    src = _read("static/js/tour-graph.js")
    assert 'from "./graph/toolbar.js"' in src and "toolsFor(" in src and "TABS" in src
    assert 'from "./graph/ribbon-model.js"' in src and "helpModel(" in src, "the ? panel must be the real help text"
    assert "registerTool(" not in src, "the mock must read the real registry, never register or hard-code tools"


# ── shortcuts the cards name ─────────────────────────────────────────────────────────────────
KEY_EVIDENCE = {
    "Ctrl+Enter": ("static/js/views/capture.js", r'e\.key === "Enter" && \(e\.ctrlKey'),
    "Ctrl+N": ("static/js/shell.js", r'toLowerCase\(\) === "n"'),
    "Ctrl+K": ("static/js/palette.js", r'toLowerCase\(\) === "k"'),
    "Ctrl+Shift+Space": ("src-tauri/src/quick.rs", r"Modifiers::CONTROL \| Modifiers::SHIFT\), Code::Space"),
    "Ctrl+Z": ("static/js/graph/undo-stack.js", r'k === "z"'),
    "Ctrl+Shift+Z": ("static/js/graph/undo-stack.js", r'e\.shiftKey \? "redo" : "undo"'),
}


def test_shortcuts_named_by_the_tour_exist(steps):
    for s in steps["steps"]:
        for key in s["mirrors"].get("keys", []):
            assert key in KEY_EVIDENCE, f"{s['id']}: add the real code that handles {key} to KEY_EVIDENCE in tests/test_tour.py"
            f, pat = KEY_EVIDENCE[key]
            assert re.search(pat, _read(f)), f"{s['id']}: {key} is no longer handled in {f}"
        text = s["blurb"] + " " + s["tip"]
        for key in re.findall(r"Ctrl\+(?:Shift\+)?[A-Za-z]+", text):
            assert key in s["mirrors"].get("keys", []), f"{s['id']}: the copy names {key}; list it under mirrors.keys so it is checked"
    shortcuts_mock = _read("static/js/tour-scenes.js").split('"capture-shortcuts"')[1].split("search: {")[0]
    for k in ("Enter", "Space"):
        assert f'"{k}"' in shortcuts_mock


# ── the tour stays a harmless replica, starts and stops cleanly, and is themed ───────────────
def test_tour_never_touches_the_api_or_the_users_data():
    for f in ["tour.js", *SCENE_FILES]:
        src = _read(f"static/js/{f}")
        assert not re.search(r"\bfetch\(|\bapi\.(get|post|put|patch|del)\b|from \"\./api\.js\"|localStorage|sessionStorage", src), f"{f} must stay a pure mock (no API, no storage)"


def test_tour_still_starts_from_first_run_and_from_settings_and_can_be_skipped():
    ob = _read("static/js/onboarding.js")
    assert 'import { runTour } from "./tour.js"' in ob and "runTour($(\"#onboarding\"), finish)" in ob
    assert "export function replayTutorial" in ob and "bdl-tutorial-seen" in ob
    assert re.search(r'function finish\(\) \{.{0,200}?\$\("#onboarding"\)\?\.remove\(\)', ob, re.S), "finish() must remove the overlay"
    main = _read("static/js/main.js")
    assert "if (needsOnboarding()) await runOnboarding();" in main
    st = _read("static/js/views/settings.js")
    assert 'id="about-tutorial"' in st and "Replay tutorial" in st and "replayTutorial()" in st
    tour = _read("static/js/tour.js")
    assert "export function runTour(el, finish" in tour and 'id="ob-skip"' in tour and 'id="ob-next"' in tour and 'id="ob-back"' in tour
    assert "Get started" in tour and "teardown" in tour, "listeners and timers must be cleaned up when a card changes or the tour ends"


def test_tour_css_is_loaded_and_uses_theme_tokens_only():
    html = _read("static/index.html")
    assert re.search(r'href="css/tour\.css\?v=[\d.]+"', html)
    css = re.sub(r"/\*.*?\*/", "", (CSS / "tour.css").read_text(encoding="utf-8"), flags=re.S)
    assert not [h for h in re.findall(r"#[0-9a-fA-F]{3,8}\b", css) if h.lower() != "#fff"], "hard-coded colour in tour.css; use var(--...)"
    assert "@media (max-width: 720px)" in css, "the tour must have a narrow-window layout"


# ── the protocol is permanent ────────────────────────────────────────────────────────────────
def test_protocol_and_checklist_exist_and_list_every_card(steps):
    claude = _read("CLAUDE.md")
    assert "Tutorial protocol" in claude and "docs/TUTORIAL-CHECKLIST.md" in claude
    doc = _read("docs/TUTORIAL-CHECKLIST.md")
    for s in steps["steps"]:
        assert f"`{s['id']}`" in doc, f"docs/TUTORIAL-CHECKLIST.md must list card {s['id']}"
    assert "tour_walk.mjs" in doc and "test_tour.py" in doc
    assert "TUTORIAL-CHECKLIST" in _read("release.ps1"), "the release flow must point at the tutorial protocol"
