from fastapi.testclient import TestClient

from app import db
from app.main import create_app


def test_search_matches_items_and_backfills_fts():
    client = TestClient(create_app())
    did = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status) VALUES (?,?,?,?,?,'ready')",
               (did, db.now_iso(), "freeform", "some unrelated body text", "Body has no keyword"))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?, ?)", (did, "Body has no keyword some unrelated body text"))
    iid = db.new_id()
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?,'suggested',0,?)",
               (iid, did, "task", "call the dentist tomorrow", db.now_iso()))
    # No items_fts row yet → the backfill on init must index it.
    db.backfill_items_fts()
    r = client.get("/api/search?q=dentist").json()
    hit = next((x for x in r if x["id"] == did), None)
    assert hit and hit["via"] in ("items", "both", "keyword")
    assert hit["matched_items"][0]["content"] == "call the dentist tomorrow"
    assert hit["matched_items"][0]["kind"] == "task"
    db.execute("DELETE FROM dumps WHERE id=?", (did,))
    db.execute("DELETE FROM dumps_fts WHERE id=?", (did,))
    db.execute("DELETE FROM items_fts WHERE dump_id=?", (did,))
