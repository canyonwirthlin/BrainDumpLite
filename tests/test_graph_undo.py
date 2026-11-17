"""Brain map Merge tool + undo: the backend (undoable concept/person merges, dump merge round trip) and the
pure undo-stack logic run under Node, plus structural guards for the wiring."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, graph
from app.main import create_app

ROOT = Path(__file__).resolve().parent.parent
GRAPH_JS = ROOT / "static" / "js" / "graph"


def _dump(did, title, concepts=(), people=(), day="2026-09-10", private=0, deleted=None, status="ready"):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, concepts, people, is_private, deleted_at) "
               "VALUES (?,?,?,?,?,?,?,?,?,?)",
               (did, f"{day}T10:00:00+00:00", "freeform", "text of " + title, title, status, json.dumps(list(concepts)),
                json.dumps(list(people)), private, deleted))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (did, "text of " + title))


def _wipe():
    with db.lock():
        c = db.conn()
        for t in ("items", "links", "dump_merges"):
            c.execute(f"DELETE FROM {t}")
        c.execute("DELETE FROM dumps_fts")
        c.execute("DELETE FROM items_fts")
        c.execute("DELETE FROM dumps WHERE id LIKE 'gu-%'")
        c.execute("DELETE FROM settings WHERE key IN ('name_aliases','graph_undo_cache')")
        c.commit()


@pytest.fixture
def client():
    c = TestClient(create_app())
    _wipe()
    yield c
    _wipe()


def _snap():
    """Everything a merge can touch, as a comparable value."""
    rows = {r["id"]: (r["concepts"], r["people"]) for r in db.query("SELECT id, concepts, people FROM dumps WHERE id LIKE 'gu-%'")}
    return rows, db.get_setting("name_aliases", None)


def _seed():
    _dump("gu-1", "Run notes", concepts=["Sleep", "Running"], people=["Ana"])
    _dump("gu-2", "Bed time", concepts=["sleeping habits", "Sleep"], people=["Anna"], day="2026-09-11")
    _dump("gu-3", "Plan", concepts=["Sleeping Habits", "Launch"], people=["Ana", "Bo"], day="2026-09-12")
    _dump("gu-4", "Other", concepts=["Cooking"], day="2026-09-13")
    _dump("gu-tr", "Trashed", concepts=["sleeping habits"], day="2026-09-14", deleted="2026-09-15T00:00:00+00:00")
    _dump("gu-pv", "Private", concepts=["sleeping habits", "SecretTopic"], day="2026-09-14", private=1)


def merge(client, kind="concept", sources=("sleeping habits",), target="Sleep"):
    return client.post("/api/merge/undoable", json={"kind": kind, "sources": list(sources), "target": target})


def test_merge_then_undo_restores_everything_byte_identical(client):
    _seed()
    before = _snap()
    r = merge(client)
    assert r.status_code == 200
    body = r.json()
    assert body["undo_id"] and body["name"] == "Sleep" and body["merged_dumps"] >= 2
    after = _snap()
    assert after != before                                   # the merge really changed things
    assert "sleeping habits" in after[1]["concept"]          # alias recorded
    u = client.post(f"/api/merge/undo/{body['undo_id']}")
    assert u.status_code == 200 and u.json()["ok"]
    assert _snap() == before                                 # dumps JSON and aliases identical (incl. trashed + private)
    assert db.get_setting("name_aliases", None) is None      # the setting is gone again, not left as {} / {"concept": {}}


def test_alias_setting_that_already_existed_is_restored_exactly(client):
    _seed()
    db.set_setting("name_aliases", {"concept": {"old thing": "Launch"}, "person": {"bob": "Bo"}})
    before = _snap()
    body = merge(client).json()
    assert db.get_setting("name_aliases")["concept"]["old thing"] == "Launch"
    client.post(f"/api/merge/undo/{body['undo_id']}")
    assert _snap() == before


def test_people_merge_round_trip(client):
    _seed()
    before = _snap()
    body = merge(client, kind="person", sources=("Anna",), target="Ana").json()
    assert body["undo_id"]
    assert json.loads(db.query_one("SELECT people FROM dumps WHERE id='gu-2'")["people"]) == ["Ana"]
    assert client.post(f"/api/merge/undo/{body['undo_id']}").status_code == 200
    assert _snap() == before


def test_double_undo_is_a_409_and_unknown_is_404(client):
    _seed()
    uid = merge(client).json()["undo_id"]
    assert client.post(f"/api/merge/undo/{uid}").status_code == 200
    again = client.post(f"/api/merge/undo/{uid}")
    assert again.status_code == 409 and "already undone" in again.json()["detail"]
    assert client.post("/api/merge/undo/nope").status_code == 404


def test_redo_is_just_merging_again_and_gets_a_new_undo_id(client):
    _seed()
    before = _snap()
    first = merge(client).json()
    client.post(f"/api/merge/undo/{first['undo_id']}")
    second = merge(client).json()
    assert second["undo_id"] != first["undo_id"]
    merged = _snap()
    assert merged != before
    client.post(f"/api/merge/undo/{second['undo_id']}")
    assert _snap() == before
    merge(client)
    assert _snap()[0] == merged[0]                           # redo lands on the same dump rewrite


def test_undo_refuses_when_a_touched_dump_changed_since(client):
    _seed()
    body = merge(client).json()
    db.execute("UPDATE dumps SET concepts=? WHERE id='gu-2'", (json.dumps(["Sleep", "Edited by hand"]),))
    u = client.post(f"/api/merge/undo/{body['undo_id']}")
    assert u.status_code == 409 and "changed" in u.json()["detail"]
    # nothing was half restored
    assert json.loads(db.query_one("SELECT concepts FROM dumps WHERE id='gu-3'")["concepts"]) == ["Sleep", "Launch"]
    # and the entry is still usable once the offending dump is back to what the merge wrote
    db.execute("UPDATE dumps SET concepts=? WHERE id='gu-2'", (json.dumps(["Sleep"]),))
    assert client.post(f"/api/merge/undo/{body['undo_id']}").status_code == 200


def test_chained_merges_undo_in_reverse_order_only(client):
    _seed()
    before = _snap()
    a = merge(client).json()
    b = merge(client, sources=("Launch",), target="Sleep").json()
    assert client.post(f"/api/merge/undo/{a['undo_id']}").status_code == 409     # the newer merge touched the same dumps
    assert client.post(f"/api/merge/undo/{b['undo_id']}").status_code == 200
    assert client.post(f"/api/merge/undo/{a['undo_id']}").status_code == 200
    assert _snap() == before


def test_a_dump_deleted_for_good_since_is_skipped(client):
    _seed()
    body = merge(client).json()
    db.execute("DELETE FROM dumps_fts WHERE id='gu-3'")
    db.execute("DELETE FROM dumps WHERE id='gu-3'")
    u = client.post(f"/api/merge/undo/{body['undo_id']}")
    assert u.status_code == 200
    assert json.loads(db.query_one("SELECT concepts FROM dumps WHERE id='gu-2'")["concepts"]) == ["sleeping habits", "Sleep"]


def test_trashed_and_private_dumps_are_restored_but_never_reported(client):
    _seed()
    before = _snap()
    r = merge(client)
    blob = r.text
    assert "gu-tr" not in blob and "gu-pv" not in blob and "SecretTopic" not in blob
    # the private/trashed dumps were rewritten by the merge (same as the plain /api/merge) and are put back by undo
    assert json.loads(db.query_one("SELECT concepts FROM dumps WHERE id='gu-pv'")["concepts"]) == ["Sleep", "SecretTopic"]
    u = client.post(f"/api/merge/undo/{r.json()['undo_id']}")
    assert "gu-tr" not in u.text and "gu-pv" not in u.text and "SecretTopic" not in u.text
    assert _snap() == before
    # the snapshot is never part of a data export (key name contains "cache")
    from app import dataio
    assert "graph_undo_cache" not in dataio.export_data().get("settings", {})


def test_nothing_changed_means_no_undo_entry(client):
    _seed()
    r = merge(client, sources=("no such concept",), target="Other new name")
    assert r.status_code == 200 and r.json()["undo_id"] is None


def test_validation_errors_match_the_plain_merge(client):
    _seed()
    assert client.post("/api/merge/undoable", json={"kind": "dump", "sources": ["a"], "target": "b"}).status_code == 400
    assert client.post("/api/merge/undoable", json={"kind": "concept", "sources": [], "target": "b"}).status_code == 400
    assert client.post("/api/merge/undoable", json={"kind": "concept", "sources": ["Sleep"], "target": ""}).status_code == 400
    assert db.get_setting("graph_undo_cache", []) == []


def test_cache_is_capped_and_survives_a_restart_of_the_app_object(client):
    _seed()
    ids = []
    prev = "Running"
    for i in range(35):                                       # each merge renames the previous result, so each one changes a dump
        ids.append(merge(client, sources=(prev,), target=f"Run{i}").json()["undo_id"])
        prev = f"Run{i}"
    cache = db.get_setting("graph_undo_cache")
    assert len(cache) == 30 and cache[0]["id"] == ids[5]
    client2 = TestClient(create_app())                       # a fresh app object reads the same vault
    assert client2.post(f"/api/merge/undo/{ids[0]}").status_code == 404          # pushed out of the cache
    assert client2.post(f"/api/merge/undo/{ids[-1]}").status_code == 200         # the newest one still works after a "restart"


def test_the_map_sees_the_merge_and_its_undo(client):
    _seed()
    names = lambda: {n["label"].lower() for n in client.get("/api/graph").json()["nodes"] if n["type"] == "concept"}
    _dump("gu-5", "Odd one", concepts=["Zebra stripes"], day="2026-09-20")
    base = names()
    assert "zebra stripes" in base and "cooking" in base
    uid = merge(client, sources=("Zebra stripes",), target="Cooking").json()["undo_id"]
    assert "zebra stripes" not in names() and "cooking" in names()
    client.post(f"/api/merge/undo/{uid}")
    assert names() == base and "secrettopic" not in names()


def test_dump_to_dump_merge_round_trip(client):
    _dump("gu-a", "Older note", concepts=["Sleep"], day="2026-09-01")
    _dump("gu-b", "Newer note", concepts=["Cooking"], day="2026-09-02")
    ids = lambda: {n["id"] for n in client.get("/api/graph").json()["nodes"] if n["type"] == "dump" and n["id"].startswith("gu-")}
    assert ids() == {"gu-a", "gu-b"}
    r = client.post("/api/dumps/merge", json={"ids": ["gu-b", "gu-a"]})
    assert r.status_code == 200 and r.json()["id"] == "gu-a"          # the older dump survives
    assert ids() == {"gu-a"}
    u = client.post(f"/api/merges/{r.json()['merge_id']}/undo")
    assert u.status_code == 200 and ids() == {"gu-a", "gu-b"}
    assert json.loads(db.query_one("SELECT concepts FROM dumps WHERE id='gu-a'")["concepts"]) == ["Sleep"]
    assert client.post(f"/api/merges/{r.json()['merge_id']}/undo").status_code == 400      # already undone: clear refusal
    # trashed / private / unfinished dumps cannot be merged at all
    _dump("gu-p", "Private one", private=1, day="2026-09-03")
    _dump("gu-t", "Trashed one", deleted="2026-09-04T00:00:00+00:00", day="2026-09-03")
    assert client.post("/api/dumps/merge", json={"ids": ["gu-a", "gu-p"]}).status_code == 400
    assert client.post("/api/dumps/merge", json={"ids": ["gu-a", "gu-t"]}).status_code == 404


# ── the pure undo stack, run for real under Node ────────────────────────────────────────────────

@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_undo_stack_logic_under_node():
    script = """
import { createUndoStack } from %s;
const out = {}; const log = [];
const errs = [];
const s = createUndoStack({ max: 3, onError: (e, entry, which) => errs.push([entry.label, which, String(e.message)]) });
let changes = 0; s.onChange(() => changes++);
const mk = (n) => ({ label: n, undo: async () => { log.push('u' + n); }, redo: async () => { log.push('r' + n); } });
s.push(mk('A')); s.push(mk('B'));
out.labels1 = s.peekLabels(); out.can1 = [s.canUndo(), s.canRedo()];
await s.undo(); out.labels2 = s.peekLabels(); out.can2 = [s.canUndo(), s.canRedo()];
await s.redo(); out.labels3 = s.peekLabels();
await s.undo(); s.push(mk('C'));                                  // a new push clears redo
out.labels4 = s.peekLabels(); out.canRedoAfterPush = s.canRedo();
s.push(mk('D')); s.push(mk('E'));                                  // cap = 3: A and B fell off
out.size = s.size(); out.oldest = (await (async () => { while (s.canUndo()) await s.undo(); return log.slice(-3); })());
// queued presses are serialised, not dropped
const q = createUndoStack({ max: 10 }); const order = [];
const slow = (n) => ({ label: n, undo: () => new Promise((r) => setTimeout(() => { order.push(n); r(); }, 20)), redo: async () => {} });
q.push(slow('x')); q.push(slow('y')); q.push(slow('z'));
await Promise.all([q.undo(), q.undo(), q.undo()]); out.order = order;
out.emptyUndo = await q.undo();
// errors: a retryable error keeps the entry; a permanent one drops it
const e = createUndoStack({ max: 5, onError: (er, entry, which) => errs.push([entry.label, which, String(er.message)]) });
let fail = true;
e.push({ label: 'flaky', undo: async () => { if (fail) throw new Error('boom'); }, redo: async () => {} });
out.r1 = await e.undo(); out.stillThere = e.canUndo(); fail = false; out.r2 = await e.undo(); out.gone = e.canUndo();
e.push({ label: 'stale', undo: async () => { const x = new Error('gone for good'); x.permanent = true; throw x; }, redo: async () => {} });
out.r3 = await e.undo(); out.droppedPermanent = !e.canUndo() && !e.canRedo();
e.push(mk('P')); e.clear(); out.cleared = [e.canUndo(), e.canRedo(), e.peekLabels()];
try { s.push({ label: 'bad' }); out.badPush = 'accepted'; } catch (er) { out.badPush = 'rejected'; }
out.errs = errs; out.changes = changes > 5;
console.log(JSON.stringify(out));
""" % json.dumps((GRAPH_JS / "undo-stack.js").as_uri())
    p = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    o = json.loads(p.stdout.strip().splitlines()[-1])
    assert o["labels1"] == {"undo": "B", "redo": None} and o["can1"] == [True, False]
    assert o["labels2"] == {"undo": "A", "redo": "B"} and o["can2"] == [True, True]
    assert o["labels3"] == {"undo": "B", "redo": None}
    assert o["labels4"] == {"undo": "C", "redo": None} and o["canRedoAfterPush"] is False
    assert o["size"] == 3 and o["oldest"] == ["uE", "uD", "uC"]
    assert o["order"] == ["z", "y", "x"] and o["emptyUndo"] is False
    assert o["r1"] is False and o["stillThere"] and o["r2"] is True and o["gone"] is False
    assert o["r3"] is False and o["droppedPermanent"]
    assert o["cleared"] == [False, False, {"undo": None, "redo": None}]
    assert o["badPush"] == "rejected" and o["changes"]
    assert ["flaky", "undo", "boom"] in o["errs"]


# ── wiring guards ───────────────────────────────────────────────────────────────────────────────

def test_plugin_manifest_and_stylesheet_lines_are_enabled():
    manifest = (GRAPH_JS / "plugins.js").read_text(encoding="utf-8")
    assert re.search(r'^import "\./edit-tools\.js";', manifest, re.M)
    css = (ROOT / "static" / "css" / "graph.css").read_text(encoding="utf-8")
    assert re.search(r'^@import url\("graph-edit\.css"\);', css, re.M)
    assert (ROOT / "static" / "css" / "graph-edit.css").is_file()


def test_tools_are_registered_on_the_edit_tab():
    src = (GRAPH_JS / "edit-tools.js").read_text(encoding="utf-8") + (GRAPH_JS / "drag-merge.js").read_text(encoding="utf-8")
    for tid, order in (("merge", 30), ("undo", 40), ("redo", 41)):
        m = re.search(r'registerTool\(\{[^}]*?id: "%s"[^}]*?\}' % tid, src, re.S) or re.search(r'id: "%s".{0,400}' % tid, src, re.S)
        assert m, tid
        assert f"order: {order}" in src
    assert 'tab: "edit"' in src and "installUndoKeys()" in src and "clearUndo()" in src and "onUndoChange" in src
