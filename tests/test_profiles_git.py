import subprocess

import pytest

from app import db, gitsync, profiles
from app.main import create_app


@pytest.fixture(autouse=True)
def reset(tmp_path):
    create_app()
    yield
    if profiles.active() != profiles.DEFAULT:
        profiles.switch(profiles.DEFAULT)
    for p in profiles.list_profiles():
        if not p["default"]:
            profiles.remove(p["name"])
    db.execute("DELETE FROM settings WHERE key='git_mirror'")


def test_profiles_create_switch_remove(tmp_path):
    assert profiles.list_profiles()[0]["name"] == "Default" and profiles.active() == "Default"
    with pytest.raises(ValueError):
        profiles.add("Work", str(tmp_path / "nope"))
    profiles.create("Work", str(tmp_path / "work"))
    with pytest.raises(ValueError):
        profiles.create("work", str(tmp_path / "work2"))
    before = db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"]
    r = profiles.switch("Work")
    assert r["active"] == "Work" and db.db_path() == tmp_path / "work" / "braindump.db"
    assert db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"] == 0
    assert len(db.query("SELECT id FROM item_types")) == 6   # seeded in the fresh vault
    with pytest.raises(ValueError):
        profiles.remove("Work")  # active
    profiles.switch("Default")
    assert db.query_one("SELECT COUNT(*) AS n FROM dumps")["n"] == before
    profiles.add("Work again", str(tmp_path / "work"))
    profiles.remove("Work"); profiles.remove("Work again")
    assert [p["name"] for p in profiles.list_profiles()] == ["Default"]


@pytest.mark.skipif(not gitsync.git_available(), reason="git not installed")
def test_git_mirror_sync(tmp_path):
    repo = tmp_path / "mirror"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    with pytest.raises(ValueError):
        gitsync.configure(str(tmp_path / "not-a-repo"))
    st = gitsync.configure(str(repo))
    assert st["configured"] and st["git_available"]
    r = gitsync.sync_now("first sync", push=False)
    assert r["ok"] and "exported" in r["log"] and (repo / "braindump-backup.zip").exists()
    log = subprocess.run(["git", "log", "--oneline"], cwd=repo, capture_output=True, text=True).stdout
    assert "first sync" in log
    assert gitsync.status()["last_sync"]
