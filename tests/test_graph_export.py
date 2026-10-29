"""Brain map export: the save endpoint, and the pure JS builders (Obsidian canvas) run under Node."""
import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ROOT = Path(__file__).resolve().parent.parent
GRAPH_JS = ROOT / "static" / "js" / "graph"
NODE = shutil.which("node")


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app())


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()



def _node(script: str):
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, cwd=str(ROOT))
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_canvas_builder_matches_json_canvas_spec():
    script = f"""
import {{ buildCanvas }} from "{(GRAPH_JS / 'export-canvas.js').as_uri()}";
const nodes = [
  {{ id: "d1abcdef12", label: "Sleep *better*", type: "dump", created_at: "2026-03-04T10:00:00", x: 0, y: 0 }},
  {{ id: "d2", label: "Run", type: "dump", created_at: "2026-03-05T10:00:00", x: 10, y: 5 }},
  {{ id: "concept:sleep", label: "Sleep", type: "concept", x: 5, y: 40 }},
  {{ id: "person:sam", label: "Sam", type: "person", x: 6, y: 41 }},
  {{ id: "item:1", label: "Call the dentist", type: "task", x: 7, y: 42 }},
];
const edges = [
  {{ source: "d1abcdef12", target: "concept:sleep", type: "mention" }},
  {{ source: "d1abcdef12", target: "d2", type: "similar", score: 0.8 }},
  {{ source: "d2", target: "person:sam", type: "mention" }},
  {{ source: "item:1", target: "d2", type: "in" }},
  {{ source: "d2", target: "ghost", type: "mention" }},
];
const c = buildCanvas({{ nodes, edges, colors: {{ dump: "#8b7cf6" }}, typeLabels: {{ task: "Task" }}, wikilinks: true }});
console.log(JSON.stringify(c));
"""
    c = _node(script)
    assert len(c["nodes"]) == 5 and len(c["edges"]) == 4   # the edge to an unknown node is dropped
    ids = {n["id"] for n in c["nodes"]}
    assert len(ids) == 5
    for n in c["nodes"]:
        assert n["type"] == "text" and isinstance(n["x"], int) and isinstance(n["y"], int)
        assert n["width"] > 0 and n["height"] > 0 and n["text"]
    dump = c["nodes"][0]
    assert dump["color"] == "#8b7cf6" and "2026-03-04" in dump["text"]
    assert dump["text"].startswith("**Sleep \\*better\\***")
    assert "[[Sleep better d1abcdef]]" in dump["text"]              # "*" is dropped from file names; file name the Obsidian mirror writes: "<title> <id[:8]>.md"
    assert "Task" in c["nodes"][4]["text"]
    for e in c["edges"]:
        assert e["fromNode"] in ids and e["toNode"] in ids and e["toEnd"] == "none"
        assert e["fromSide"] in ("top", "right", "bottom", "left") and e["toSide"] in ("top", "right", "bottom", "left")
    assert sorted(e.get("label", "") for e in c["edges"]).count("similar") == 1
    # no two cards overlap after layout
    r = [(n["x"], n["y"], n["width"], n["height"]) for n in c["nodes"]]
    for i, a in enumerate(r):
        for b in r[i + 1:]:
            assert a[0] + a[2] <= b[0] or b[0] + b[2] <= a[0] or a[1] + a[3] <= b[1] or b[1] + b[3] <= a[1]


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_canvas_builder_handles_many_and_degenerate_inputs():
    script = f"""
import {{ buildCanvas }} from "{(GRAPH_JS / 'export-canvas.js').as_uri()}";
const empty = buildCanvas({{ nodes: [], edges: [] }});
const one = buildCanvas({{ nodes: [{{ id: "a", label: "Only", type: "concept", x: 3, y: 3 }}], edges: [] }});
const same = buildCanvas({{ nodes: [0,1,2].map(i => ({{ id: "n" + i, label: "N" + i, type: "concept", x: 5, y: 5 }})), edges: [] }});
const nodes = Array.from({{ length: 2500 }}, (_, i) => ({{ id: "n" + i, label: "Node " + i, type: i % 3 ? "concept" : "dump", created_at: "2026-01-01", x: (i % 50) * 9, y: Math.floor(i / 50) * 9 }}));
const edges = nodes.slice(1).map((n, i) => ({{ source: n.id, target: "n" + i, type: "mention" }}));
const t = Date.now(); const big = buildCanvas({{ nodes, edges }});
console.log(JSON.stringify({{ empty: [empty.nodes.length, empty.edges.length], one: one.nodes.length, same: same.nodes.map(n => [n.x, n.y]), big: [big.nodes.length, big.edges.length], ms: Date.now() - t }}));
"""
    out = _node(script)
    assert out["empty"] == [0, 0] and out["one"] == 1
    assert len({tuple(p) for p in out["same"]}) == 3          # stacked nodes are pulled apart
    assert out["big"] == [2500, 2499]
    assert out["ms"] < 8000


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_note_wikilink_mirrors_python_file_naming():
    from app import export_md
    script = f"""
import {{ noteWikilink, safeNoteTitle, slugify }} from "{(GRAPH_JS / 'export-common.js').as_uri()}";
const titles = ["Plan the week", 'A: "quoted" <title>?', "Ends with dots...", "   ", "", "x".repeat(80), "Has [brackets]"];
console.log(JSON.stringify({{ safe: titles.map(safeNoteTitle), link: noteWikilink("Plan the week", "abcdef1234567"), bad: noteWikilink("Has [brackets]", "abcdef12"), slug: slugify("Sleep & mood!") }}));
"""
    out = _node(script)
    titles = ["Plan the week", 'A: "quoted" <title>?', "Ends with dots...", "   ", "", "x" * 80, "Has [brackets]"]
    assert out["safe"] == [export_md._safe_title(t) for t in titles]
    assert out["link"] == "[[Plan the week abcdef12]]" and out["bad"] is None and out["slug"] == "sleep-mood"


def test_export_modules_registered():
    plugins = (GRAPH_JS / "plugins.js").read_text(encoding="utf-8")
    assert 'import "./export.js";' in plugins
    for name in ("export", "export-common", "export-save", "export-svg", "export-canvas", "timelapse", "timelapse-bar", "timelapse-record"):
        assert (GRAPH_JS / f"{name}.js").is_file(), name
