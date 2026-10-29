"""Brain map layouts (ego rings, topic timeline, cluster islands, concept map, people x concepts grid), the cluster
outlines overlay and community detection: structural guards plus a real run of community.js under Node."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "static" / "js" / "graph"
LAYOUTS = {"ego": "Ego rings", "lanes": "Topic timeline", "islands": "Cluster islands",
           "concepts": "Concept map", "matrix": "People × concepts grid"}


def test_layout_modules_registered_in_plugin_manifest():
    manifest = (GRAPH / "plugins.js").read_text(encoding="utf-8")
    imports = re.findall(r'^import "\./([^"]+)";', manifest, re.M)
    for lid in LAYOUTS:
        assert f"layout-{lid}.js" in imports, lid
    assert "overlay-hulls.js" in imports
    for name in imports:
        assert (GRAPH / name).is_file(), name


@pytest.mark.parametrize("lid,label", LAYOUTS.items())
def test_each_layout_has_a_card_worth_of_metadata(lid, label):
    src = (GRAPH / f"layout-{lid}.js").read_text(encoding="utf-8")
    assert f'id: "{lid}"' in src and f'label: "{label}"' in src
    icon = re.search(r'icon: "([^"]+)"', src)
    desc = re.search(r'desc: "([^"]+)"', src)
    assert icon and desc
    assert 60 < len(desc.group(1)) < 420          # one or two sentences, user-facing
    assert "hint:" in src and "note:" in src      # an in-canvas tip and a too-little-data message


def test_hulls_overlay_and_css_exist():
    src = (GRAPH / "overlay-hulls.js").read_text(encoding="utf-8")
    assert 'id: "hulls"' in src and 'label: "Cluster outlines"' in src and "drawUnder" in src
    css = (ROOT / "static" / "css" / "graph-layouts.css").read_text(encoding="utf-8")
    assert ".graph-hint" in css and ".graph-note" in css


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_community_detection_is_deterministic_and_finds_the_groups():
    script = """
import { communities } from %s;
const nodes = [], edges = [];
const clique = (tag) => {
  const hub = { id: 'concept:' + tag, label: tag, type: 'concept' }; nodes.push(hub);
  for (let i = 0; i < 6; i++) { const d = { id: tag + i, label: tag + ' note ' + i, type: 'dump' }; nodes.push(d); edges.push({ source: d.id, target: hub.id, type: 'mention' }); }
  nodes.push({ id: 'task-' + tag, label: 'a task', type: 'task', dump: tag + '0' });
};
clique('alpha'); clique('beta');
edges.push({ source: 'alpha0', target: 'beta0', type: 'similar', score: 0.5 });
nodes.push({ id: 'lonely', label: 'lonely', type: 'dump' });
const a = communities(nodes, edges), b = communities(nodes.slice().reverse(), edges.slice().reverse());
const norm = (r) => r.list.map((c) => [c.id, c.size, c.topLabel, [...c.nodeIds].sort().join(',')]);
console.log(JSON.stringify({ a: norm(a), same: JSON.stringify(norm(a)) === JSON.stringify(norm(b)), taskIn: a.communityOf.get('task-alpha') === a.communityOf.get('alpha0') }));
""" % json.dumps((GRAPH / "community.js").as_uri())
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["same"], "input order must not change the communities"
    assert res["taskIn"], "items follow their dump"
    sizes = [c[1] for c in res["a"]]
    assert sizes[:2] == [8, 8] and sizes[2:] == [1]   # two groups of hub + 6 dumps + 1 task, plus the lonely dump
    assert {c[2] for c in res["a"][:2]} == {"alpha", "beta"}
    assert [c[0] for c in res["a"]] == ["c0", "c1", "c2"]
