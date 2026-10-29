"""Structural guards for the modular Brain map frontend (static/js/graph/, static/css/graph*.css)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


def test_graph_css_imports_exist_and_views_css_has_no_graph_rules():
    graph_css = (STATIC / "css" / "graph.css").read_text(encoding="utf-8")
    imports = re.findall(r'@import url\("([^"]+)"\);', graph_css)
    assert imports == ["graph-panel.css", "graph-layouts.css", "graph-cards.css", "graph-overlays.css", "graph-tools.css"]
    for name in imports:
        assert (STATIC / "css" / name).is_file(), name
    # graph.css is nothing but comments + @imports
    body = re.sub(r"/\*.*?\*/", "", graph_css, flags=re.S)
    assert re.sub(r'@import url\("[^"]+"\);', "", body).strip() == ""
    views = (STATIC / "css" / "views.css").read_text(encoding="utf-8")
    assert not re.search(r"graph", re.sub(r"/\*.*?\*/", "", views, flags=re.S), re.I)
    assert ".graph-bar" in (STATIC / "css" / "graph-panel.css").read_text(encoding="utf-8")


def test_index_links_graph_css_with_release_cache_buster():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    links = [re.sub(r"\?v=[\d.]+$", "", h) for h in re.findall(r'href="(css/[^"]+\?v=[\d.]+)"', html)]
    assert "css/graph.css" in links and links.index("css/graph.css") == links.index("css/views.css") + 1
    # release.ps1 rewrites every ?v=<digits and dots>: they must all carry the same version
    assert len(set(re.findall(r"\?v=([\d.]+)", html))) == 1


def test_plugin_manifest_imports_resolve_and_modules_exist():
    gdir = STATIC / "js" / "graph"
    for name in ("prefs", "data", "engine", "physics", "layouts", "overlays", "infobox", "timelapse", "path",
                 "find", "panel", "hooks", "plugins"):
        assert (gdir / f"{name}.js").is_file(), name
    for imp in re.findall(r'^import "\./([^"]+)";', (gdir / "plugins.js").read_text(encoding="utf-8"), re.M):
        assert (gdir / imp).is_file(), f"plugins.js imports missing {imp}"
    entry = (STATIC / "js" / "views" / "graph.js").read_text(encoding="utf-8")
    assert "export async function render(ctx)" in entry and "renderPanel(ctx, state)" in entry
    assert len(entry.splitlines()) < 120   # the entry stays an orchestrator, not a second engine


def test_saved_pref_keys_unchanged():
    prefs = (STATIC / "js" / "graph" / "prefs.js").read_text(encoding="utf-8")
    for key in ("bdl-graph-spacing", "bdl-graph-layout", "bdl-graph-hover-titles", "bdl-graph-min", "bdl-graph-range",
                "bdl-graph-types", "bdl-graph-pins", "bdl-graph-view-", "bdl-graph-overlays"):
        assert f'"{key}"' in prefs, key
