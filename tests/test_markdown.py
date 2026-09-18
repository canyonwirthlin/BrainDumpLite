import io
import json
import zipfile

import pytest

from app import db, export_md, import_md, wikilinks
from app.main import create_app


@pytest.fixture
def dump():
    create_app()
    did = "md-test-1"
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people, tone, provider) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?)",
               (did, "2026-09-18T15:30:00+00:00", "freeform", "raw text [[Work Fog]]", "clean text", "Dentist & work",
                "• book the dentist", json.dumps(["dentist", "Work Fog"]), json.dumps(["Sam"]),
                json.dumps({"label": "anxious", "valence": -1, "energy": 1}), "builtin"))
    db.execute("INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at, est_minutes, urgency) "
               "VALUES ('mdi1', ?, 'task', 'Book the dentist', 'find the number', 4, '2026-09-25', 'approved', 0, '2026-09-18T15:31:00', 30, 2)", (did,))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('mdi2', ?, 'idea', 'water app', 'suggested', 0, '2026-09-18T15:32:00')", (did,))
    yield did
    db.execute("DELETE FROM dumps WHERE id IN ('md-test-1') OR title LIKE 'imported%' OR title = 'Meeting notes'")


def test_markdown_render_with_and_without_wikilinks(dump):
    name, text = export_md.dump_markdown(dump)
    assert name.endswith("Dentist  work.md") or name.endswith("Dentist & work.md")
    assert "id: md-test-1" in text and "source: braindump-lite" in text
    assert "# Dentist & work" in text
    assert "- [ ] Book the dentist (~30m, urgency 2, due 2026-09-25)" in text
    assert "  - find the number" in text
    assert "- **idea:** water app" in text
    assert "[[Work Fog]]" in text and "[[Sam]]" in text
    _, plain = export_md.dump_markdown(dump, wikilinks=False)
    assert "[[" not in plain and "Work Fog" in plain
    z = zipfile.ZipFile(io.BytesIO(export_md.vault_markdown_zip()))
    assert any(n.startswith("dumps/") and n.endswith(".md") for n in z.namelist())


def test_wikilinks_extract_and_merge():
    assert wikilinks.extract("see [[Work Fog]] and [[Sam|Sam A]] and [[Work fog#x]]") == ["Work Fog", "Sam"]
    people, concepts = wikilinks.merge("[[Sam]] [[sleep]] [[dentist]]", ["Dan"], ["dentist"], {"sam"})
    assert people == ["Dan", "Sam"] and concepts == ["dentist", "sleep"]


def test_import_parses_and_skips_own_export(dump, monkeypatch):
    monkeypatch.setattr(import_md, "enqueue", lambda did: None)
    _, text = export_md.dump_markdown(dump)
    r = import_md.import_files([("x.md", text, None)])
    assert r == {"imported": 0, "skipped": 1, "ids": []}
    note = "---\ncreated: 2026-01-05T10:00:00\ntags: [a]\n---\n# Meeting notes\n\nTalk to [[Sam]] about the roadmap.\n"
    p = import_md.parse_file("2026-01-05 notes.md", note, None)
    assert p["title"] == "Meeting notes" and p["created_at"].startswith("2026-01-05T10:00:00") and p["text"].startswith("Talk to")
    r = import_md.import_files([("2026-01-05 notes.md", note, None), ("empty.md", "---\n---\n", None)])
    assert r["imported"] == 1 and r["skipped"] == 1
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (r["ids"][0],))
    assert d["title"] == "Meeting notes" and d["status"] == "pending" and d["created_at"].startswith("2026-01-05")
    db.execute("DELETE FROM dumps WHERE id=?", (r["ids"][0],))
