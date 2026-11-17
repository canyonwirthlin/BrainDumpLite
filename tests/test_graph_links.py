"""Brain map Link mode: POST/DELETE /api/graph/blueprint/link and GET /api/graph/blueprint/links."""
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import db, graph_insights as gi, routes_graph_links as rgl
from app.main import create_app

GRAPH = Path(__file__).resolve().parent.parent / "static" / "js" / "graph"
IDS = ("bl1", "bl2", "bl3", "bl-trash", "bl-priv")


def _dump(did, title, concepts=(), people=(), status="ready", trashed=False, private=False):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, concepts, people) VALUES (?,?,?,?,?,?,?,?)",
               (did, "2026-05-01T10:00:00+00:00", "freeform", "raw " + title, title, status, json.dumps(list(concepts)), json.dumps(list(people))))
    if trashed:
        db.execute("UPDATE dumps SET deleted_at=? WHERE id=?", (db.now_iso(), did))
    if private:
        db.execute("UPDATE dumps SET is_private=1 WHERE id=?", (did,))


def _names(did, col="concepts"):
    return json.loads(db.query_one(f"SELECT {col} FROM dumps WHERE id=?", (did,))[col])


def _wipe():
    for d in IDS:
        db.execute("DELETE FROM dumps WHERE id=?", (d,))
    db.execute("DELETE FROM links WHERE dump_id LIKE 'bl%' OR related_id LIKE 'bl%'")
    db.execute("DELETE FROM settings WHERE key IN (?,?)", (rgl.WIRES_KEY, gi.MANUAL_KEY))


@pytest.fixture
def client():
    c = TestClient(create_app())
    _wipe()
    _dump("bl1", "Internship hunt", concepts=["Internship", "Resume"], people=["Sam"])
    _dump("bl2", "More applications", concepts=["internships", "Interview prep"], people=["Sam", "Ana"])
    _dump("bl3", "Cooking", concepts=["Cooking"])
    _dump("bl-trash", "Trashed one", concepts=["TrashOnly"], people=["Ghost"], trashed=True)
    _dump("bl-priv", "Private one", concepts=["PrivOnly"], people=["Hidden"], private=True)
    yield c
    _wipe()


def link(c, a, b, **kw):
    return c.post("/api/graph/blueprint/link", json={"a": a, "b": b, **kw})


def unlink(c, a, b):
    return c.delete(f"/api/graph/blueprint/link?a={quote(a, safe='')}&b={quote(b, safe='')}")


def pair_set(j):
    return {(l["a"], l["b"], l["kind"]) for l in j["links"]}


# ── dump <-> dump ────────────────────────────────────────────────────────────────────────────

def test_dump_dump_link_unlink_is_idempotent(client):
    r = link(client, "bl1", "bl3")
    assert r.status_code == 200 and r.json()["created"] is True and r.json()["kind"] == "dump-dump"
    assert db.query_one("SELECT score FROM links WHERE dump_id='bl1' AND related_id='bl3'")["score"] == 1.0
    again = link(client, "bl3", "bl1").json()          # either direction: still the same link
    assert again["created"] is False
    assert db.query("SELECT 1 FROM links WHERE dump_id LIKE 'bl%'").__len__() == 1
    assert ("bl1", "bl3", "dump-dump") in pair_set(client.get("/api/graph/blueprint/links").json())
    r = unlink(client, "bl3", "bl1").json()
    assert r["removed"] is True and not db.query("SELECT 1 FROM links WHERE dump_id LIKE 'bl%'")
    assert unlink(client, "bl1", "bl3").json()["removed"] is False


def test_dump_dump_link_shows_on_the_map_as_an_edge(client):
    link(client, "bl1", "bl3")
    edges = client.get("/api/graph").json()["edges"]
    assert any({e["source"], e["target"]} == {"bl1", "bl3"} and e["type"] == "similar" and e["score"] == 1.0 for e in edges)


def test_automatic_similar_rows_are_not_listed_as_wires(client):
    db.execute("INSERT INTO links VALUES ('bl1','bl2',0.8)")
    assert client.get("/api/graph/blueprint/links").json()["links"] == []


# ── dump <-> concept / person ────────────────────────────────────────────────────────────────

def test_dump_concept_adds_and_removes_the_name(client):
    r = link(client, "bl3", "concept:resume").json()
    assert r["created"] is True and r["kind"] == "dump-concept" and r["names"] == ["Resume"]
    assert _names("bl3") == ["Cooking", "Resume"]
    assert ("bl3", "concept:resume", "dump-concept") in pair_set(r)
    assert link(client, "bl3", "concept:resume").json()["created"] is False and _names("bl3") == ["Cooking", "Resume"]
    r = unlink(client, "bl3", "concept:resume").json()
    assert r["removed"] is True and r["names"] == ["Resume"] and _names("bl3") == ["Cooking"]
    assert not any(l["kind"] == "dump-concept" for l in r["links"])
    assert unlink(client, "bl3", "concept:resume").json()["removed"] is False


def test_node_order_does_not_matter(client):
    assert link(client, "person:ana", "bl3").json()["kind"] == "dump-person"
    assert _names("bl3", "people") == ["Ana"]


def test_spelling_variant_counts_as_already_linked_and_unlink_removes_every_variant(client):
    assert link(client, "bl1", "concept:internship").json()["created"] is False     # bl1 already says "Internship"
    link(client, "bl3", "concept:internship")
    assert any(n.lower().startswith("internship") for n in _names("bl3"))
    r = unlink(client, "bl1", "concept:internship").json()
    assert r["removed"] is True and _names("bl1") == ["Resume"]


def test_undo_restores_the_exact_spelling(client):
    r = unlink(client, "bl2", "concept:internship").json()
    assert r["names"] == ["internships"] and _names("bl2") == ["Interview prep"]
    back = link(client, "bl2", "concept:internship", names=r["names"]).json()
    assert back["created"] is True and _names("bl2") == ["Interview prep", "internships"]


def test_dump_person(client):
    assert link(client, "bl3", "person:sam").json()["created"] is True
    assert _names("bl3", "people") == ["Sam"]
    assert link(client, "bl1", "person:sam").json()["created"] is False
    assert unlink(client, "bl3", "person:sam").json()["removed"] is True and _names("bl3", "people") == []


def test_concept_cap_is_reported_not_silently_dropped(client):
    db.execute("UPDATE dumps SET concepts=? WHERE id='bl3'", (json.dumps([f"topic {i}" for i in range(12)]),))
    r = link(client, "bl3", "concept:resume")
    assert r.status_code == 400 and "Remove one first" in r.json()["detail"]
    assert len(_names("bl3")) == 12


def test_a_wire_whose_name_was_edited_away_is_no_longer_listed(client):
    link(client, "bl3", "concept:resume")
    db.execute("UPDATE dumps SET concepts='[]' WHERE id='bl3'")
    assert not any(l["kind"] == "dump-concept" for l in client.get("/api/graph/blueprint/links").json()["links"])


# ── concept/person pairs (kept in settings, as the Suggested links overlay does) ───────────────

def test_concept_pair_link_and_unlink(client):
    r = link(client, "concept:cooking", "concept:resume").json()
    assert r["created"] is True and r["kind"] == "pair"
    assert len(gi.manual_links()) == 1
    assert link(client, "concept:resume", "concept:cooking").json()["created"] is False
    assert len(gi.manual_links()) == 1
    assert link(client, "person:ana", "concept:cooking").json()["kind"] == "pair"
    assert unlink(client, "concept:resume", "concept:cooking").json()["removed"] is True
    assert len(gi.manual_links()) == 1
    assert unlink(client, "concept:resume", "concept:cooking").json()["removed"] is False
    # no dump was touched
    assert _names("bl3") == ["Cooking"] and _names("bl1") == ["Internship", "Resume"]


# ── what cannot be linked, and what does not exist ───────────────────────────────────────────

def test_items_and_self_links_are_refused(client):
    assert link(client, "item:abc", "bl1").status_code == 400
    assert link(client, "bl1", "item:abc").status_code == 400
    assert "belong to the note" in link(client, "bl1", "item:abc").json()["detail"]
    assert link(client, "bl1", "bl1").status_code == 400
    assert link(client, "concept:cooking", "concept:cooking").status_code == 400


def test_unknown_nodes_404(client):
    assert link(client, "nope", "bl1").status_code == 404
    assert link(client, "bl1", "nope").status_code == 404
    assert link(client, "bl1", "concept:does-not-exist").status_code == 404
    assert link(client, "concept:cooking", "concept:does-not-exist").status_code == 404
    assert unlink(client, "nope", "bl1").status_code == 404
    assert unlink(client, "bl1", "person:nobody").status_code == 404


def test_trashed_and_private_dumps_cannot_take_part(client):
    for hidden in ("bl-trash", "bl-priv"):
        assert link(client, hidden, "bl1").status_code == 404
        assert link(client, "bl1", hidden).status_code == 404
        assert link(client, hidden, "concept:resume").status_code == 404
        assert unlink(client, hidden, "bl1").status_code == 404
    assert not db.query("SELECT 1 FROM links WHERE dump_id LIKE 'bl%'")
    # concepts and people that only trashed / private dumps mention do not exist on the map
    assert link(client, "bl1", "concept:trashonly").status_code == 404
    assert link(client, "bl1", "concept:privonly").status_code == 404
    assert link(client, "bl1", "person:ghost").status_code == 404
    assert link(client, "bl1", "person:hidden").status_code == 404
    assert _names("bl-trash") == ["TrashOnly"] and _names("bl-priv") == ["PrivOnly"]


def test_links_to_a_dump_trashed_later_are_not_listed(client):
    link(client, "bl1", "bl3")
    db.execute("UPDATE dumps SET deleted_at=? WHERE id='bl3'", (db.now_iso(),))
    assert client.get("/api/graph/blueprint/links").json()["links"] == []
    db.execute("UPDATE dumps SET deleted_at=NULL WHERE id='bl3'")
    db.execute("UPDATE dumps SET is_private=1 WHERE id='bl3'")
    assert client.get("/api/graph/blueprint/links").json()["links"] == []


def test_a_dump_that_is_still_processing_is_not_linkable(client):
    db.execute("UPDATE dumps SET deleted_at=NULL, status='queued' WHERE id='bl-trash'")
    assert link(client, "bl-trash", "bl1").status_code == 404


# ── the pure maths, run under node ───────────────────────────────────────────────────────────

@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_blueprint_calc_under_node():
    script = """
import * as c from %s;
const n = (id, type, x, y, r = 6) => ({ id, type, x, y, r, label: id });
const A = n('a', 'dump', 0, 0), B = n('b', 'dump', 100, 0), C = n('concept:c', 'concept', 0, 100), P = n('person:p', 'person', 100, 100), T = n('t', 'task', 50, 50, 3), C2 = n('concept:d', 'concept', 200, 0);
const none = () => null;
const out = {};
out.same = c.validateLink(A, A, none);
out.dd = c.validateLink(A, B, none);
out.dc = c.validateLink(A, C, none);
out.cd = c.validateLink(C, A, none);
out.dp = c.validateLink(A, P, none);
out.cc = c.validateLink(C, C2, none);
out.cp = c.validateLink(C, P, none);
out.item = c.validateLink(A, T, none);
out.dup = c.validateLink(A, C, () => 'mention');
out.ends = c.wireEnds(A, B, 1);
out.endsBack = c.wireEnds(B, A, 1);
const cu = c.wireCurve(A, B, 1);
const rd = (p) => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 });
out.mid = rd(c.bezierPoint(cu, 0.5));
out.d0 = rd(c.bezierPoint(cu, 0)); out.d1 = rd(c.bezierPoint(cu, 1));
out.hit = c.distToCurve(cu, 50, 3).dist < 4;
out.miss = c.distToCurve(cu, 50, 40).dist > 30;
out.nodeHit = c.nodeAt([A, B], 101, 1, 1, () => true) && c.nodeAt([A, B], 101, 1, 1, () => true).id;
out.nodeMiss = c.nodeAt([A, B], 50, 50, 1, () => true);
out.nodeHidden = c.nodeAt([A, B], 101, 1, 1, (n) => n.id !== 'b');
out.manual = [c.isManualEdge({ type: 'similar', score: 1 }), c.isManualEdge({ type: 'similar', score: 0.8 }), c.isManualEdge({ type: 'manual' }), c.isManualEdge({ type: 'mention' })];
out.label = [c.linkLabel(A, B), c.linkLabel(A, B, " and ")];
out.key = [c.pairKey('b', 'a'), c.pairKey('a', 'b')];
out.portHit = [c.portAt(A, 7, 0, 1), c.portAt(A, -7, 0, 1), c.portAt(A, 0, 0, 1), c.portAt(A, 40, 0, 1)];
console.log(JSON.stringify(out));
""" % json.dumps((GRAPH / "blueprint-calc.js").as_uri())
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])
    assert r["same"]["ok"] is False and "different" in r["same"]["reason"]
    assert r["dd"]["ok"] and r["dd"]["kind"] == "dump-dump" and not r["dd"]["duplicate"]
    assert r["dc"]["ok"] and r["dc"]["kind"] == "dump-concept" and r["cd"]["kind"] == "dump-concept"
    assert r["dp"]["kind"] == "dump-person"
    assert r["cc"]["ok"] and r["cc"]["kind"] == "pair" and r["cp"]["kind"] == "pair"
    assert r["item"]["ok"] is False and "belong to the note" in r["item"]["reason"]
    assert r["dup"]["ok"] and r["dup"]["duplicate"]
    # a wire leaves the right-hand side of the left node and enters the left-hand side of the right node
    assert r["ends"]["a"] == {"x": 6, "y": 0} and r["ends"]["b"] == {"x": 94, "y": 0}
    assert r["endsBack"]["a"]["x"] == 94 and r["endsBack"]["b"]["x"] == 6
    assert r["mid"] == {"x": 50, "y": 0} and r["d0"] == {"x": 6, "y": 0} and r["d1"] == {"x": 94, "y": 0}
    assert r["hit"] and r["miss"]
    assert r["nodeHit"] == "b" and r["nodeMiss"] is None and r["nodeHidden"] is None
    assert r["manual"] == [True, False, True, False]
    assert r["label"] == ["“a” to “b”", "“a” and “b”"]
    assert r["key"][0] == r["key"][1]
    assert r["portHit"] == ["e", "w", None, None]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_suggested_links_overlay_follows_link_mode_edits():
    """Link mode removing a concept pair must also take its solid line off the Suggested links overlay (which keeps its
    own copy of the accepted links), and a pair made in Link mode must stop being suggested."""
    script = """
const noop = () => {};
globalThis.window = globalThis; globalThis.addEventListener = noop; globalThis.removeEventListener = noop;
let click = null;
globalThis.document = { addEventListener: (t, fn) => { if (t === "click") click = fn; }, querySelector: () => null, getElementById: () => null, documentElement: {},
  createElement: () => ({ classList: { add: noop, remove: noop }, remove: noop }), body: { appendChild: noop } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.localStorage = { getItem: () => null, setItem: noop };
const L = (a, b) => ({ a, b, a_label: a, b_label: b, kind: "pair" });
let pairs = [L("concept:x", "concept:y")];
const sug = (a, b) => ({ a, b, a_label: a, b_label: b, score: 0.5, reason: "" });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), m = opts.method || "GET";
  let body = {};
  if (u.includes("/graph/insights/suggested-links")) body = { links: [sug("concept:x", "concept:z"), sug("concept:y", "concept:z")] };
  else if (u.includes("/graph/insights/links") && m === "POST") { pairs = [L("concept:x", "concept:y")]; body = { links: pairs }; }
  else if (u.includes("/graph/insights/links") || u.includes("/graph/blueprint/links")) body = { links: pairs };
  else if (u.includes("/graph/blueprint/link") && m === "DELETE") { pairs = []; body = { removed: true, kind: "pair", names: [], links: pairs }; }
  else if (u.includes("/graph/blueprint/link") && m === "POST") { pairs = [L("concept:x", "concept:z")]; body = { created: true, kind: "pair", names: [], links: pairs }; }
  return { ok: true, json: async () => body };
};
const { runGraphReady } = await import(%(hooks)s);
const store = await import(%(store)s);
await import(%(overlay)s);
const { OVERLAYS } = await import(%(overlays)s);
const ov = OVERLAYS.find((o) => o.id === "links");
const node = (id) => ({ id, x: 0, y: 0, r: 5 });
let live;
const api = { on: () => noop, requestDraw: noop, colors: { text: "#fff", bg: "#000", edge: "#999" }, view: { scale: 1 }, hoverId: null, selectedId: null,
  prefs: { get: () => false }, isVisible: () => true, byId: { "concept:x": node("concept:x"), "concept:y": node("concept:y"), "concept:z": node("concept:z") },
  overlays: { state: () => live, isActive: () => true } };
runGraphReady(api, { data: null, mount: noop });
await new Promise((r) => setTimeout(r, 20));
const lines = () => { let n = 0; const c = { save: noop, restore: noop, beginPath: noop, stroke: noop, fill: noop, arc: noop, fillText: noop, setLineDash: noop, lineTo: noop, moveTo: () => { n++; } }; ov.drawUnder(c, api, live); return n; };
live = await ov.load(api);
const out = { before: lines() };                 // x-y solid + two ghosts
await store.fetchLinks();
await store.removeLink("concept:x", "concept:y");
out.afterRemove = lines();                       // the two ghosts only
await store.createLink("concept:x", "concept:z");
out.afterCreate = lines();                       // x-z solid + the y-z ghost (x-z is no longer suggested)
// the other direction: "Link these" in the overlay must reach Link mode's own list (its filter drops edges it does not know)
await store.removeLink("concept:x", "concept:z");
pairs = [];
await store.fetchLinks();
const before = store.getLinks().length;
click({ target: { closest: () => ({ dataset: { ov: "ov-link", a: "concept:x", b: "concept:y" } }) }, preventDefault: noop });
await new Promise((r) => setTimeout(r, 30));
out.blueprintKnows = [before, store.getLinks().length];
console.log(JSON.stringify(out));
""" % {k: json.dumps((GRAPH / v).as_uri()) for k, v in {"hooks": "hooks.js", "store": "blueprint-store.js", "overlay": "overlay-links.js", "overlays": "overlays.js"}.items()}
    out = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])
    assert r["before"] == 3, "one solid accepted line and two suggestion ghosts"
    assert r["afterRemove"] == 2, "the pair Link mode removed must not stay on the Suggested links overlay"
    assert r["afterCreate"] == 2, "a pair made in Link mode shows as the solid line and is no longer suggested"
    assert r["blueprintKnows"] == [0, 1], "a link accepted from the overlay must show up in Link mode's list"
