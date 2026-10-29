"""Structural guards for the Brain map control panel and the edge-controls filter (static/js/graph/)."""
import re
from pathlib import Path

GRAPH = Path(__file__).resolve().parent.parent / "static" / "js" / "graph"


def _read(name: str) -> str:
    return (GRAPH / name).read_text(encoding="utf-8")


def test_panel_keeps_ids_other_modules_rely_on():
    panel = _read("panel.js")
    for needle in ('id="graph-find"', 'id="graph-find-list"', 'id="graph-wrap"', 'id="graph-tl-btn"',
                   'id="graph-slot-timelapse"', 'id="graph-slot-export"', "bdl-graph-panel-rendered"):
        assert needle in panel, needle
    assert "paintLegend" in panel and "setCount" in panel


def test_panel_is_generated_from_the_registries():
    panel = _read("panel.js")
    assert "LAYOUTS.map" in panel and "overlays.list()" in panel
    # no layout / overlay ids are hardcoded in the panel
    assert not re.search(r"data-layout=\"(organic|galaxy)\"", panel)


def test_edges_filter_registered_with_its_own_prefs():
    edges = _read("filter-edges.js")
    assert "registerFilter" in edges and 'after: "mentions"' in edges
    for key in ("bdl-graph-edge-mention", "bdl-graph-edge-similar", "bdl-graph-edge-min-similar"):
        assert f'"{key}"' in edges, key
    assert re.search(r'^import "\./filter-edges\.js";', _read("plugins.js"), re.M)
