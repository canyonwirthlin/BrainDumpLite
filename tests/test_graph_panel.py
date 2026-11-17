"""Structural guards for the Brain map page shell (panel.js) and the edge-controls filter (static/js/graph/)."""
import re
from pathlib import Path

GRAPH = Path(__file__).resolve().parent.parent / "static" / "js" / "graph"


def _read(name: str) -> str:
    return (GRAPH / name).read_text(encoding="utf-8")


def test_panel_is_a_thin_shell_around_the_ribbon():
    """panel.js only builds the page chrome; the controls are tools in the registry (see tests/test_graph_ribbon.py)."""
    panel = _read("panel.js")
    for needle in ('id="graph-wrap"', 'id="graph-ribbon-host"', "mountRibbon", "bindToolContext", "paintLegend", "setCount", "resetFilters", "gp-legend"):
        assert needle in panel, needle
    ribbon = _read("ribbon.js")
    for needle in ('id="graph-count"', "bdl-graph-panel-rendered"):
        assert needle in ribbon, needle
    tools = _read("ribbon-tools.js")
    for needle in ('id="graph-find"', 'id="graph-find-list"', 'domId: "graph-tl-btn"', 'id="graph-slot-export"', 'id="graph-slot-keys"'):
        assert needle in tools, needle


def test_controls_are_generated_from_the_registries():
    tools = _read("ribbon-tools.js")
    assert "LAYOUTS.forEach" in tools and "OVERLAYS.forEach" in tools
    # no layout / overlay ids are hardcoded
    assert not re.search(r'"layout:(organic|galaxy)"', tools)


def test_edges_filter_registered_with_its_own_prefs():
    edges = _read("filter-edges.js")
    assert "registerFilter" in edges and 'after: "mentions"' in edges
    for key in ("bdl-graph-edge-mention", "bdl-graph-edge-similar", "bdl-graph-edge-min-similar"):
        assert f'"{key}"' in edges, key
    assert re.search(r'^import "\./filter-edges\.js";', _read("plugins.js"), re.M)
