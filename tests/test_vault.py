import io
import sqlite3
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import db, vault
from app.main import create_app


@pytest.fixture(autouse=True)
def back_to_default():
    create_app()
    yield
    if db.db_path().parent != db.data_dir():
        vault.reset_location()


def _count():
    return db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"]


def test_backup_zip_contains_a_valid_db():
    name, data = vault.backup_zip()
    assert name.startswith("braindump-backup-") and name.endswith(".zip")
    z = zipfile.ZipFile(io.BytesIO(data))
    assert "braindump.db" in z.namelist()
    raw = z.read("braindump.db")
    assert raw[:16] == b"SQLite format 3\x00"


def test_restore_rejects_bad_files_and_applies_good_ones(tmp_path):
    with pytest.raises(ValueError):
        vault.restore_zip(b"not a zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("other.txt", "x")
    with pytest.raises(ValueError):
        vault.restore_zip(buf.getvalue())
    # snapshot, add a dump, restore the snapshot → the dump is gone again
    _, snap = vault.backup_zip()
    before = _count()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES ('tmp-restore', '2026-01-01', 'freeform', 'x', 'ready')")
    assert _count() == before + 1
    r = vault.restore_zip(snap)
    assert r["ok"] and r["dumps"] == before and _count() == before
    assert (db.db_path().parent / "braindump.db.bak").exists()


def test_move_relocates_db_and_pointer(tmp_path):
    before = _count()
    info = vault.move(str(tmp_path / "vault"))
    assert info["custom"] and info["db_path"].startswith(str(tmp_path))
    assert db.db_path() == tmp_path / "vault" / "braindump.db"
    assert _count() == before  # data travelled
    assert (db.data_dir() / "vault-location.txt").read_text(encoding="utf-8").strip() == str(tmp_path / "vault")
    with pytest.raises(ValueError):
        vault.move(str(tmp_path / "vault"))  # already there
    vault.reset_location()
    assert db.db_path().parent == db.data_dir()


def test_vault_api(tmp_path):
    client = TestClient(create_app())
    assert client.get("/api/vault").json()["db_path"].endswith("braindump.db")
    r = client.get("/api/backup")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    bad = client.post("/api/restore", files={"file": ("b.zip", b"nope", "application/zip")})
    assert bad.status_code == 400
    mv = client.post("/api/vault/move", json={"path": str(tmp_path / "v2")})
    assert mv.status_code == 200 and mv.json()["custom"]
    assert client.post("/api/vault/reset").status_code == 200
