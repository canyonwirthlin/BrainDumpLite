"""Hand-editing a finished dump (title, items, concepts/people, links) and saving
exports to a path chosen in the native Save dialog."""
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app


@pytest.fixture
def client():
    return TestClient(create_app())


@pytest.fixture
def two_dumps():
    create_app()
    for did, title in (("ed-1", "Original title"), ("ed-2", "Other dump")):
        db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people) "
                   "VALUES (?,?,?,?,?,?,?,'ready',?,?)",
                   (did, "2026-09-18T15:30:00+00:00", "freeform", "raw", "clean words", title, "• a point",
                    json.dumps(["dentist"]), json.dumps(["Sam"])))
    db.execute("INSERT INTO items (id, dump_id, kind, content, detail, status, done, created_at) "
               "VALUES ('edi-1', 'ed-1', 'task', 'Book dentist', 'find number', 'suggested', 0, '2026-09-18T15:31:00')")
    yield
    db.execute("DELETE FROM items_fts WHERE dump_id IN ('ed-1','ed-2')")
    db.execute("DELETE FROM dumps_fts WHERE id IN ('ed-1','ed-2')")
    db.execute("DELETE FROM dumps WHERE id IN ('ed-1','ed-2')")


def test_patch_dump_title_concepts_people(client, two_dumps):
    r = client.patch("/api/dumps/ed-1", json={"title": "  New   title ", "concepts": ["Work", "work", " ", "[[Health]]"], "people": ["@Sam", "Alex"]})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New title"
    assert body["concepts"] == ["Work", "Health"]      # deduped case-insensitively, wikilink brackets stripped
    assert body["people"] == ["Sam", "Alex"]           # leading @ stripped
    # search index follows the title
    assert db.query_one("SELECT id FROM dumps_fts WHERE dumps_fts MATCH 'title'")["id"] == "ed-1"


def test_patch_dump_rejects_empty_title_and_unknown(client, two_dumps):
    assert client.patch("/api/dumps/ed-1", json={"title": "   "}).status_code == 400
    assert client.patch("/api/dumps/nope", json={"title": "x"}).status_code == 404


def test_patch_item_content_and_detail(client, two_dumps):
    r = client.patch("/api/items/edi-1", json={"content": " Call the dentist ", "detail": "number is on the fridge"})
    assert r.status_code == 200
    assert r.json()["content"] == "Call the dentist" and r.json()["detail"] == "number is on the fridge"
    assert db.query_one("SELECT dump_id FROM items_fts WHERE items_fts MATCH 'fridge'")["dump_id"] == "ed-1"
    # null clears the detail, absent key leaves it alone
    assert client.patch("/api/items/edi-1", json={"status": "approved"}).json()["detail"] == "number is on the fridge"
    assert client.patch("/api/items/edi-1", json={"detail": None}).json()["detail"] is None
    assert client.patch("/api/items/edi-1", json={"content": "  "}).status_code == 400


def test_add_and_remove_link(client, two_dumps):
    assert client.post("/api/dumps/ed-1/links", json={"related_id": "ed-1"}).status_code == 400
    assert client.post("/api/dumps/ed-1/links", json={"related_id": "missing"}).status_code == 404
    assert client.post("/api/dumps/ed-1/links", json={"related_id": "ed-2"}).status_code == 200
    assert client.post("/api/dumps/ed-2/links", json={"related_id": "ed-1"}).status_code == 200  # no duplicate edge
    assert [r["id"] for r in client.get("/api/dumps/ed-1").json()["related"]] == ["ed-2"]
    assert [r["id"] for r in client.get("/api/dumps/ed-2").json()["related"]] == ["ed-1"]
    # removing from either side clears the edge for both
    assert client.delete("/api/dumps/ed-2/links/ed-1").status_code == 200
    assert client.get("/api/dumps/ed-1").json()["related"] == []


def test_save_dump_markdown_to_chosen_path(client, two_dumps, tmp_path):
    target = tmp_path / "my note"
    r = client.post("/api/dumps/ed-1/markdown/save", json={"path": str(target)})
    assert r.status_code == 200
    assert r.json()["path"].endswith("my note.md")           # extension appended when the dialog didn't add one
    assert "# Original title" in (tmp_path / "my note.md").read_text(encoding="utf-8")


def test_save_rejects_relative_and_missing_folder(client, two_dumps, tmp_path):
    assert client.post("/api/dumps/ed-1/markdown/save", json={"path": "note.md"}).status_code == 400
    assert client.post("/api/dumps/ed-1/markdown/save", json={"path": str(tmp_path / "nope" / "n.md")}).status_code == 400
    assert client.post("/api/dumps/missing/markdown/save", json={"path": str(tmp_path / "n.md")}).status_code == 404


def test_save_all_markdown_zip(client, two_dumps, tmp_path):
    r = client.post("/api/export/markdown/save", json={"path": str(tmp_path / "vault.zip")})
    assert r.status_code == 200
    with zipfile.ZipFile(tmp_path / "vault.zip") as z:
        assert any(n.startswith("dumps/") for n in z.namelist())
