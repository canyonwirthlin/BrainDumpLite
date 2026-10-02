"""Auto backup: scheduler due-ness, keep-N pruning, chosen folder, failure surfacing, restore with a safety copy."""
import os
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from app import backup, db
from app.main import create_app


@pytest.fixture(autouse=True)
def _vault(tmp_path):
    db.init_db()
    db.set_setting("backup", {"enabled": True, "dir": str(tmp_path / "bk"), "keep": 3})
    db.set_setting("backup_state", {})
    db.execute("DELETE FROM dumps")
    yield
    db.set_setting("backup", {})
    db.set_setting("backup_state", {})


def _dump(did, private=0):
    db.execute("INSERT INTO dumps (id, created_at, raw_text, title, status, is_private) VALUES (?,?,?,?,?,?)",
               (did, "2026-09-10T10:00:00+00:00", "body " + did, "T " + did, "ready", private))


def _fake(folder, stamp, age_s=0):
    f = folder / f"braindump-{stamp}.db"
    f.write_bytes(b"x")
    t = time.time() - age_s
    os.utime(f, (t, t))
    return f


def test_backup_goes_to_chosen_folder_and_is_a_valid_db(tmp_path):
    _dump("a")
    made = backup.run_backup()
    f = tmp_path / "bk" / made["name"]
    assert f.exists()
    c = sqlite3.connect(str(f))
    assert c.execute("SELECT COUNT(*) FROM dumps").fetchone()[0] == 1
    c.close()
    assert backup.status()["last_ok"] and backup.status()["last_error"] is None


def test_keeps_only_newest_n(tmp_path):
    d = tmp_path / "bk"
    d.mkdir()
    for i in range(6):
        _fake(d, f"2026010{i + 1}-120000", age_s=(6 - i) * 86400)
    backup.run_backup()
    names = [b["name"] for b in backup.list_backups()]
    assert len(names) == 3
    assert "braindump-20260101-120000.db" not in names


def test_due_only_after_interval(tmp_path):
    d = tmp_path / "bk"
    d.mkdir()
    assert backup._due()                                   # no backups yet
    f = _fake(d, "20260101-120000", age_s=3600)
    assert not backup._due()                               # an hour old
    os.utime(f, (time.time() - 25 * 3600,) * 2)
    assert backup._due()                                   # a day+ old
    db.set_setting("backup", {**backup.config(), "enabled": False})
    assert not backup._due()


def test_failure_is_recorded_and_surfaced(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(backup, "_snapshot", boom)
    with pytest.raises(OSError):
        backup.run_backup()
    st = backup.status()
    assert st["last_error"] == "disk full" and st["last_error_at"]
    monkeypatch.undo()
    backup.run_backup()
    assert backup.status()["last_error"] is None


def test_private_dumps_can_be_excluded_from_the_copy(tmp_path):
    _dump("pub")
    _dump("priv", private=1)
    backup.run_backup()
    full = backup.list_backups()[0]["name"]
    c = sqlite3.connect(str(tmp_path / "bk" / full))
    assert c.execute("SELECT COUNT(*) FROM dumps").fetchone()[0] == 2     # default: whole-db copy
    c.close()
    backup.set_config(include_private=False)
    dest = tmp_path / "bk" / "braindump-20300101-000000.db"
    backup._snapshot(dest, backup.config()["include_private"])
    c = sqlite3.connect(str(dest))
    assert [r[0] for r in c.execute("SELECT id FROM dumps")] == ["pub"]
    c.close()
    assert db.query_one("SELECT 1 FROM dumps WHERE id='priv'")          # live vault untouched


def test_restore_swaps_in_backup_and_saves_a_pre_restore_copy(tmp_path):
    _dump("old")
    made = backup.run_backup()
    _dump("newer")
    r = backup.restore_backup(made["name"])
    assert r["ok"] and r["dumps"] == 1
    assert [x["id"] for x in db.query("SELECT id FROM dumps")] == ["old"]
    pre = tmp_path / "bk" / r["pre_restore_copy"]
    c = sqlite3.connect(str(pre))
    assert c.execute("SELECT COUNT(*) FROM dumps").fetchone()[0] == 2    # the live vault as it was
    c.close()
    assert r["pre_restore_copy"] in backup.status()["pre_restore"]
    assert all(b["name"] != r["pre_restore_copy"] for b in backup.list_backups())   # not subject to pruning


def test_restore_rejects_bad_names_and_corrupt_files(tmp_path):
    for bad in ("../braindump.db", "braindump-20260101-120000.db", "x.db"):
        with pytest.raises(ValueError):
            backup.restore_backup(bad)
    d = tmp_path / "bk"
    d.mkdir(exist_ok=True)
    _fake(d, "20260102-120000")                                          # b"x" is not a sqlite file
    _dump("keep")
    with pytest.raises(Exception):
        backup.restore_backup("braindump-20260102-120000.db")
    assert db.query_one("SELECT 1 FROM dumps WHERE id='keep'")           # live vault untouched


def test_endpoints(tmp_path):
    c = TestClient(create_app())
    _dump("a")
    r = c.post("/api/autobackup/run")
    assert r.status_code == 200
    name = r.json()["name"]
    assert c.get("/api/autobackup").json()["count"] == 1
    assert c.post("/api/autobackup/restore", json={"name": "nope.db"}).status_code == 400
    assert c.post("/api/autobackup/restore", json={"name": name}).status_code == 200
