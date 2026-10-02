"""Dump card: pin, split, merge + undo, 30-day trash (and its exclusion everywhere), duplicate hint."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, graph, search, stats
from app.main import create_app

IDS = ("dc-a", "dc-b", "dc-c")


@pytest.fixture
def client():
    c = TestClient(create_app())
    _clean()
    yield c
    _clean()


def _clean():
    for t, col in (("items_fts", "dump_id"), ("dumps_fts", "id"), ("items", "dump_id")):
        db.execute(f"DELETE FROM {t} WHERE {col} LIKE 'dc-%' OR {col} LIKE 'dcn-%'")
    db.execute("DELETE FROM dump_merges")
    db.execute("DELETE FROM dumps WHERE id LIKE 'dc-%'")
    for r in db.query("SELECT id FROM dumps WHERE title LIKE '%(part 2)%'"):
        db.execute("DELETE FROM items WHERE dump_id=?", (r["id"],))
        db.execute("DELETE FROM dumps_fts WHERE id=?", (r["id"],))
        db.execute("DELETE FROM dumps WHERE id=?", (r["id"],))


def mk(did, title, raw, day="2026-09-18", people=None, concepts=None):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?)",
               (did, f"{day}T10:00:00+00:00", "freeform", raw, None, title, "• pt", json.dumps(concepts or []), json.dumps(people or [])))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (did, f"{title}\n{raw}"))


def mk_item(iid, did, content, kind="task"):
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?, 'approved', 0, '2026-09-18T10:01:00')",
               (iid, did, kind, content))
    db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)", (iid, did, content))


def ids_listed(client):
    return [d["id"] for d in client.get("/api/dumps").json()]


def test_soft_delete_restore_and_exclusion(client):
    mk("dc-a", "Zebrafish plan", "zebrafish tank cleaning schedule", people=["Zed"], concepts=["aquarium"])
    mk_item("dcn-1", "dc-a", "buy zebrafish food")
    assert "dc-a" in ids_listed(client)
    assert "dc-a" in json.dumps(search.search("zebrafish"), default=list)
    assert client.delete("/api/dumps/dc-a").json()["ok"]
    assert "dc-a" not in ids_listed(client)
    assert client.get("/api/dumps/dc-a").status_code == 404
    assert db.query_one("SELECT deleted_at FROM dumps WHERE id='dc-a'")["deleted_at"]
    assert not any(t["id"] == "dcn-1" for t in client.get("/api/tasks").json())
    assert not db.query("SELECT 1 FROM dumps_fts WHERE dumps_fts MATCH 'zebrafish'")
    assert "dc-a" not in json.dumps(search.search("zebrafish"), default=list)
    assert "dc-a" not in json.dumps(graph.today("2026-09-18"))
    tr = client.get("/api/trash").json()
    assert [t["id"] for t in tr] == ["dc-a"] and tr[0]["days_left"] == 30
    assert client.post("/api/trash/dc-a/restore").json()["ok"]
    assert "dc-a" in ids_listed(client)
    assert db.query("SELECT 1 FROM dumps_fts WHERE dumps_fts MATCH 'zebrafish'")


def test_delete_forever_empty_and_autopurge(client):
    mk("dc-a", "A", "alpha text words here"); mk("dc-b", "B", "bravo text words here"); mk("dc-c", "C", "charlie text words here")
    for i in IDS:
        client.delete(f"/api/dumps/{i}")
    assert client.delete("/api/trash/dc-a").json()["ok"]
    assert not db.query_one("SELECT 1 FROM dumps WHERE id='dc-a'")
    # age dc-b past 30 days -> purged by listing
    old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    db.execute("UPDATE dumps SET deleted_at=? WHERE id='dc-b'", (old,))
    from app import routes_dumps
    assert routes_dumps.purge_expired() == 1
    assert not db.query_one("SELECT 1 FROM dumps WHERE id='dc-b'")
    assert client.get("/api/trash").json()[0]["id"] == "dc-c"
    assert client.delete("/api/trash").json()["deleted"] == 1
    assert client.post("/api/trash/dc-c/restore").status_code == 404


def test_pin_dump_and_task(client):
    mk("dc-a", "Old", "old text", day="2026-09-01"); mk("dc-b", "New", "new text", day="2026-09-10")
    mk_item("dcn-1", "dc-a", "first task"); mk_item("dcn-2", "dc-a", "second task")
    mine = [i for i in ids_listed(client) if i in ("dc-a", "dc-b")]
    assert mine == ["dc-b", "dc-a"]
    client.post("/api/dumps/dc-a/pin", json={"pinned": True})
    assert [i for i in ids_listed(client) if i in ("dc-a", "dc-b")] == ["dc-a", "dc-b"]
    assert client.get("/api/dumps/dc-a").json()["pinned"] is True
    client.post("/api/items/dcn-2/pin", json={"pinned": True})
    order = [t["id"] for t in client.get("/api/tasks").json() if t["id"] in ("dcn-1", "dcn-2")]
    assert order[0] == "dcn-2"
    assert client.post("/api/items/nope/pin", json={}).status_code == 404


def test_split_moves_items_with_their_text(client):
    mk("dc-a", "Day", "Call the dentist about the crown. Then later we will plant tomatoes in the garden.", people=["Sam"])
    mk_item("dcn-1", "dc-a", "Call the dentist")
    mk_item("dcn-2", "dc-a", "Plant tomatoes in the garden")
    at = len("Call the dentist about the crown.")
    r = client.post("/api/dumps/dc-a/split", json={"at": at}).json()
    assert r["first"] == "dc-a" and r["moved_items"] == ["dcn-2"]
    a, b = client.get("/api/dumps/dc-a").json(), client.get(f"/api/dumps/{r['second']}").json()
    assert a["raw_text"].endswith("crown.") and b["raw_text"].startswith("Then later")
    assert [i["id"] for i in a["items"]] == ["dcn-1"] and [i["id"] for i in b["items"]] == ["dcn-2"]
    assert db.query_one("SELECT dump_id FROM items_fts WHERE items_fts MATCH 'tomatoes'")["dump_id"] == r["second"]
    assert client.post("/api/dumps/dc-a/split", json={"at": 0}).status_code == 400


def test_merge_and_undo(client):
    mk("dc-a", "First", "alpha words here", day="2026-09-01", concepts=["x"])
    mk("dc-b", "Second", "bravo words here", day="2026-09-02", concepts=["y"], people=["Pat"])
    mk_item("dcn-1", "dc-a", "task a"); mk_item("dcn-2", "dc-b", "task b")
    r = client.post("/api/dumps/merge", json={"ids": ["dc-b", "dc-a"]}).json()
    assert r["id"] == "dc-a" and r["merged"] == ["dc-b"]
    d = client.get("/api/dumps/dc-a").json()
    assert "alpha" in d["raw_text"] and "bravo" in d["raw_text"]
    assert {i["id"] for i in d["items"]} == {"dcn-1", "dcn-2"}
    assert d["concepts"] == ["x", "y"] and d["people"] == ["Pat"]
    assert "dc-b" not in ids_listed(client)
    assert all(t["id"] != "dc-b" for t in client.get("/api/trash").json())   # merged originals stay out of Trash
    u = client.post(f"/api/merges/{r['merge_id']}/undo").json()
    assert u["restored"] == ["dc-b"]
    assert "dc-b" in ids_listed(client)
    a, b = client.get("/api/dumps/dc-a").json(), client.get("/api/dumps/dc-b").json()
    assert a["raw_text"] == "alpha words here" and a["concepts"] == ["x"]
    assert [i["id"] for i in a["items"]] == ["dcn-1"] and [i["id"] for i in b["items"]] == ["dcn-2"]
    assert client.post(f"/api/merges/{r['merge_id']}/undo").status_code == 400
    assert client.post("/api/dumps/merge", json={"ids": ["dc-a"]}).status_code == 400


def test_duplicate_hint(client):
    text = "I need to reorganize the garage this weekend and sort the tools into labelled boxes"
    mk("dc-a", "Garage", text, day="2026-09-01")
    mk("dc-b", "Garage again", text + " please", day="2026-09-02")
    mk("dc-c", "Other", "completely different topic about cooking pasta with fresh basil tonight", day="2026-09-03")
    meta = client.get("/api/dumps-meta").json()
    assert meta["duplicates"]["dc-b"]["of"] == "dc-a"
    assert "dc-a" not in meta["duplicates"] and "dc-c" not in meta["duplicates"]
    client.delete("/api/dumps/dc-a")
    assert "dc-b" not in client.get("/api/dumps-meta").json()["duplicates"]


def test_trashed_excluded_from_stats_graph_export(client):
    mk("dc-a", "Gone", "gone text words many more words", people=["Ghost"], concepts=["spectre"])
    mk_item("dcn-1", "dc-a", "haunt the house")
    client.delete("/api/dumps/dc-a")
    assert "dc-a" not in json.dumps(graph.build(items=True))
    assert "Ghost" not in [p["name"] for p in graph.people()]
    assert "spectre" not in [c["name"] for c in graph.concepts()]
    assert not any(i["id"] == "dcn-1" for i in graph.items_of_kind("task"))
    from app import export_md
    assert "dc-a" not in export_md.all_ready_ids()
    assert "Ghost" not in json.dumps(search.search("ghost"), default=list)
