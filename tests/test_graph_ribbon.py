"""Brain map ribbon: static contracts (files, ids, CSS) plus a real load of the tool registry under Node with a tiny DOM
stub, so every registered tool is checked for a tip, help, a valid tab and the pieces its kind needs."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "static" / "js" / "graph"
CSS = ROOT / "static" / "css"
TABS = ["view", "layout", "overlays", "filter", "edit", "tools"]
KINDS = {"button", "toggle", "mode", "custom"}
# every control the old slim bar + side panel had, now a registered tool (ids)
MIGRATED = ["find", "fit", "focus", "hover-titles", "spacing", "types", "range", "min-mentions", "edge-mention",
            "edge-similar", "edge-threshold", "reset-filters", "path", "timelapse", "export", "keys", "select"]


def _read(name: str) -> str:
    return (GRAPH / name).read_text(encoding="utf-8")


# ── static contracts ───────────────────────────────────────────────────────────────────────────
def test_ribbon_files_exist_and_are_wired_in():
    for name in ("ribbon.js", "ribbon-model.js", "ribbon-tools.js", "ribbon-filters.js"):
        assert (GRAPH / name).is_file(), name
    assert re.search(r'^import "\./ribbon\.js";', _read("plugins.js"), re.M)
    assert re.search(r'^@import url\("graph-toolbar\.css"\);', (CSS / "graph.css").read_text(encoding="utf-8"), re.M)
    assert (CSS / "graph-toolbar.css").is_file()


def test_ribbon_header_documents_how_to_register_a_tool():
    head = _read("ribbon.js").split("\nimport ")[0]
    for needle in ("registerTool", "kind", "tip", "help", "mount", "notifyToolbar", "bdl-graph-panel-rendered", "localStorage"):
        assert needle in head, needle


def test_ribbon_reads_the_registry_and_remembers_the_tab():
    src = _read("ribbon.js")
    assert "toolsFor(" in src and "TABS" in src and "onToolbarChange(" in src
    assert '"bdl-graph-ribbon-tab"' in src
    assert re.search(r"try \{ return localStorage\.getItem", src) and re.search(r"try \{ localStorage\.setItem", src)
    assert 'role="tablist"' in src and 'role="tab"' in src and 'role="tooltip"' in src and 'role="dialog"' in src
    assert 'aria-label' in src and "focusin" in src                       # tooltips also on keyboard focus
    assert "Escape" in src and "pointerdown" in src                       # "?" panel closes on Esc and click-away
    assert "title=" not in src                                            # styled tooltips, not the native title attribute


def test_panel_keeps_the_ids_and_events_other_modules_rely_on():
    panel, tools = _read("panel.js"), _read("ribbon-tools.js")
    assert 'id="graph-wrap"' in panel and "paintLegend" in panel and "setCount" in panel and "resetFilters" in panel
    for needle in ('id="graph-find"', 'id="graph-find-list"', 'id="graph-slot-export"', 'id="graph-slot-keys"', 'domId: "graph-tl-btn"'):
        assert needle in tools, needle
    assert "bdl-graph-panel-rendered" in _read("ribbon.js") and 'id="graph-count"' in _read("ribbon.js")
    # slot modules still listen for the render event and look for their mount points
    assert 'getElementById("graph-slot-export")' in _read("export.js") and "bdl-graph-panel-rendered" in _read("export.js")
    assert "#graph-slot-keys" in _read("keyboard.js")


def test_old_panel_is_gone():
    panel = _read("panel.js")
    for dead in ("graph-panel-toggle", "gp-sec", "gp-layout-bar", "bdl-graph-panel-open", "bdl-graph-panel-collapsed", "switchRow"):
        assert dead not in panel, dead
    css = (CSS / "graph-panel.css").read_text(encoding="utf-8")
    for dead in (".gp-side", ".gp-sec", ".gp-row", ".gp-track", ".gp-layout", ".gp-chip", ".gp-slider"):
        assert dead not in css, dead
    assert len(panel.splitlines()) < 90   # the shell stays small; the ribbon lives in ribbon*.js


def test_ribbon_registers_from_the_registries_not_hardcoded_ids():
    tools = _read("ribbon-tools.js")
    assert "LAYOUTS.forEach" in tools and "OVERLAYS.forEach" in tools
    assert not re.search(r'"layout:(organic|galaxy|ego)"', tools)


def test_ribbon_css_uses_theme_tokens_only():
    css = re.sub(r"/\*.*?\*/", "", (CSS / "graph-toolbar.css").read_text(encoding="utf-8"), flags=re.S)
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b", css), "hardcoded colour in graph-toolbar.css"
    assert "var(--accent)" in css and "var(--panel)" in css and "var(--line)" in css
    # compact: the tool row is fixed at 52px (+ padding) under a 30px tab strip
    assert "height: 30px" in css and "height: 52px" in css


# ── the real registry, loaded under Node ───────────────────────────────────────────────────────
HARNESS = """
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener: noop }) };
globalThis.document = { addEventListener: noop, createElement: () => ({ getContext: () => ({}), style: {}, classList: { add: noop } }), getElementById: () => null, querySelector: () => null, documentElement: { dataset: {} } };
const G = %(g)s;
await import(G + "plugins.js");
const tb = await import(G + "toolbar.js");
const lay = await import(G + "layouts.js");
const ovl = await import(G + "overlays.js");
const rt = await import(G + "ribbon-tools.js");
const model = await import(G + "ribbon-model.js");
rt.syncRegistryTools(); rt.syncRegistryTools();   // idempotent: must not throw on duplicate ids
const str = (v) => { try { return typeof v === "function" ? v() : v; } catch (e) { return "THROWS " + e.message; } };
const tools = tb.TOOLS.map((t) => ({ tab: t.tab, id: t.id, kind: t.kind, order: t.order, group: t.group ?? null, tip: str(t.tip), help: t.help,
  label: str(t.label), hasIcon: !!str(t.icon), hasMount: typeof t.mount === "function", hasRun: typeof t.run === "function" }));
// a throwaway feature registering into the Edit tab shows up there with no change to the ribbon
const before = model.tabSignature(tb.toolsFor("edit"));
tb.registerTool({ tab: "edit", id: "zz-dummy", label: "Dummy", icon: "x", kind: "mode", order: 50, tip: "A dummy.", help: "A dummy tool." });
const after = tb.toolsFor("edit").map((t) => t.id);
console.log(JSON.stringify({ tools, tabs: tb.TABS, tabIds: tb.TAB_IDS, layouts: lay.LAYOUTS.map((l) => l.id), overlays: ovl.OVERLAYS.map((o) => o.id),
  signatureChanged: before !== model.tabSignature(tb.toolsFor("edit")), editOrder: after }));
"""


@pytest.fixture(scope="module")
def registry():
    if shutil.which("node") is None:
        pytest.skip("node not installed")
    script = HARNESS % {"g": json.dumps((GRAPH.as_uri() + "/"))}
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=90)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_every_tool_has_a_tip_a_help_and_a_valid_tab(registry):
    tools = registry["tools"]
    ids = [t["id"] for t in tools if t["id"] != "zz-dummy"]
    assert len(ids) == len(set(ids)), "duplicate tool ids"
    for t in tools:
        assert t["tab"] in TABS, t
        assert t["kind"] in KINDS, t
        assert isinstance(t["tip"], str) and t["tip"].strip() and not t["tip"].startswith("THROWS"), t
        assert not re.search(r"[.!?]\s+[A-Z]", t["tip"]), f"tip must be ONE sentence: {t['id']}: {t['tip']}"
        assert isinstance(t["help"], str) and 20 <= len(t["help"]) <= 600, f"help text for {t['id']}"
        assert t["label"], f"every tool is named in the '?' panel: {t['id']}"


def test_each_kind_has_what_it_needs(registry):
    for t in registry["tools"]:
        if t["kind"] == "custom":
            assert t["hasMount"], t["id"]
        elif t["kind"] in ("button", "toggle"):
            assert t["hasRun"] and t["hasIcon"], t["id"]
        else:   # mode: the ribbon calls setMode(id), no run()
            assert t["hasIcon"], t["id"]


def test_tabs_are_the_contract_tabs_and_each_has_help_and_tools(registry):
    assert registry["tabIds"] == TABS and [t["id"] for t in registry["tabs"]] == TABS
    for tab in registry["tabs"]:
        assert tab["label"] and len(tab["help"]) > 20, tab
        assert any(t["tab"] == tab["id"] for t in registry["tools"]), f"empty tab {tab['id']}"


def test_every_old_control_is_now_a_tool(registry):
    ids = {t["id"] for t in registry["tools"]}
    for want in MIGRATED:
        assert want in ids, want
    for lid in registry["layouts"]:
        assert f"layout:{lid}" in ids, lid
    assert len(registry["layouts"]) >= 7
    for oid in registry["overlays"]:
        assert f"overlay:{oid}" in ids, oid
    by = {t["id"]: t for t in registry["tools"]}
    assert (by["select"]["tab"], by["select"]["kind"], by["select"]["order"]) == ("edit", "mode", 0)
    assert by["select"]["tip"] == "Select and move notes."
    assert by["timelapse"]["tab"] == "tools" and by["export"]["tab"] == "tools" and by["keys"]["tab"] == "tools"
    assert by["types"]["tab"] == "filter" and by["spacing"]["tab"] == "view" and by["find"]["tab"] == "view"


def test_a_feature_can_add_a_tool_to_the_edit_tab_without_touching_the_ribbon(registry):
    assert registry["signatureChanged"]
    assert registry["editOrder"][0] == "select" and "zz-dummy" in registry["editOrder"]
