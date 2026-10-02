import pytest

from app import db, obsidian
from app.main import create_app


@pytest.fixture(autouse=True)
def reset():
    create_app()
    db.execute("DELETE FROM dumps")
    db.execute("DELETE FROM settings WHERE key=?", (obsidian.KEY,))
    yield
    db.execute("DELETE FROM dumps")
    db.execute("DELETE FROM settings WHERE key=?", (obsidian.KEY,))


def _dump(title="Plan the week", status="ready"):
    did = db.new_id()
    db.execute("INSERT INTO dumps(id, created_at, raw_text, clean_text, title, status, people, concepts) VALUES(?,?,?,?,?,?,?,?)",
               (did, db.now_iso(), "raw", "clean text", title, status, '["Ana"]', '["Focus"]'))
    return did


def _md(folder):
    return sorted(p for p in folder.glob("*.md"))


def test_create_and_idempotent(tmp_path):
    a = _dump()
    obsidian.configure(str(tmp_path / "vault"))
    files = _md(tmp_path / "vault")
    assert len(files) == 1 and a[:8] in files[0].name
    text = files[0].read_text(encoding="utf-8")
    assert f"braindump_id: {a}" in text and "[[Ana]]" in text
    mt = files[0].stat().st_mtime_ns
    r = obsidian.sync()
    assert r["written"] == 0 and files[0].stat().st_mtime_ns == mt
    assert obsidian.sync(full=True)["written"] == 0


def test_update_and_rename(tmp_path):
    a = _dump()
    obsidian.configure(str(tmp_path))
    db.execute("UPDATE dumps SET clean_text='changed body' WHERE id=?", (a,))
    assert obsidian.sync()["written"] == 1
    assert "changed body" in _md(tmp_path)[0].read_text(encoding="utf-8")
    db.execute("UPDATE dumps SET title='New name' WHERE id=?", (a,))
    obsidian.sync()
    files = _md(tmp_path)
    assert len(files) == 1 and files[0].name.startswith("New name")


def test_trash_and_delete_move_to_trash(tmp_path):
    a, b = _dump("One"), _dump("Two")
    obsidian.configure(str(tmp_path))
    assert len(_md(tmp_path)) == 2
    db.execute("UPDATE dumps SET deleted_at=? WHERE id=?", (db.now_iso(), a))
    db.execute("DELETE FROM dumps WHERE id=?", (b,))
    r = obsidian.sync()
    assert r["removed"] == 2 and _md(tmp_path) == []
    assert len(list((tmp_path / "_trash").glob("*.md"))) == 2
    db.execute("UPDATE dumps SET deleted_at=NULL WHERE id=?", (a,))   # restore from trash
    obsidian.sync()
    assert len(_md(tmp_path)) == 1


def test_foreign_files_untouched(tmp_path):
    a = _dump("Note")
    name, _ = obsidian.render(a)
    (tmp_path / name).write_text("my own note, no marker", encoding="utf-8")
    other = tmp_path / "Daily.md"
    other.write_text("---\ntitle: x\n---\nhello", encoding="utf-8")
    obsidian.configure(str(tmp_path))
    assert (tmp_path / name).read_text(encoding="utf-8") == "my own note, no marker"
    assert other.read_text(encoding="utf-8") == "---\ntitle: x\n---\nhello"
    assert "not overwriting" in obsidian.status()["last_error"]
    db.execute("UPDATE dumps SET deleted_at=? WHERE id=?", (db.now_iso(), a))
    obsidian.sync()
    assert (tmp_path / name).exists() and not (tmp_path / "_trash").exists()


def test_not_ready_and_disabled(tmp_path):
    _dump("Pending", status="pending")
    obsidian.configure(str(tmp_path))
    assert _md(tmp_path) == []
    obsidian.configure(None)
    _dump("Later")
    obsidian.sync()
    assert _md(tmp_path) == [] and obsidian.status()["enabled"] is False
