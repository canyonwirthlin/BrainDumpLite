import json
import shutil
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, plugins, suggestions
from app.main import create_app

GOOD = '''
def register(api):
    api.on_dump(lambda d: api.propose("plugin_action", "saw " + d["id"], {"action": "shout", "args": {"text": d["id"]}}, dump_id=d["id"]))
    api.action("shout", "Shout", lambda args: {"said": args.get("text", "").upper()})
    api.action("peek", "Peek", lambda args: {"rows": len(api.db_query("SELECT id FROM dumps LIMIT 3"))})
    api.action("naughty", "Naughty", lambda args: api.db_query("DELETE FROM dumps"))
    api.set_setting("hello", "world")
'''
BROKEN = "raise RuntimeError('I explode on import')\n\n\ndef register(api):\n    pass\n"


def make(folder: Path, pid: str, body: str, entry="main.py", meta_extra=None):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.json").write_text(json.dumps({"id": pid, "name": pid.title(), "version": "1.0.0",
                                                    "permissions": ["read-vault"], "entry": entry, **(meta_extra or {})}), encoding="utf-8")
    (folder / entry).write_text(body, encoding="utf-8")
    return folder


@pytest.fixture(autouse=True)
def clean():
    create_app()
    yield
    for p in plugins.plugins_dir().iterdir():
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
    plugins._loaded.clear()
    db.execute("DELETE FROM settings WHERE key = 'plugins_enabled' OR key LIKE 'plugin:%'")
    db.execute("DELETE FROM suggestions")
    db.execute("DELETE FROM dumps WHERE id='plug-d1'")


def test_install_from_folder_and_zip(tmp_path):
    src = make(tmp_path / "shouty", "shouty", GOOD)
    meta = plugins.install(str(src))
    assert meta["id"] == "shouty" and (plugins.plugins_dir() / "shouty" / "main.py").exists()
    z = tmp_path / "zipped.zip"
    src2 = make(tmp_path / "zippy", "zippy", GOOD)
    with zipfile.ZipFile(z, "w") as zf:
        for f in src2.iterdir():
            zf.write(f, f"zippy/{f.name}")
    assert plugins.install(str(z))["id"] == "zippy"
    assert {p["id"] for p in plugins.listing()} == {"shouty", "zippy"}
    assert all(p["enabled"] is False for p in plugins.listing())
    with pytest.raises(ValueError):
        plugins.install(str(tmp_path / "nope"))
    with pytest.raises(ValueError):
        plugins.install(str(make(tmp_path / "bad", "bad", GOOD, meta_extra={"entry": "../evil.py"})))


def test_enable_hooks_actions_and_readonly_db(tmp_path):
    plugins.install(str(make(tmp_path / "shouty", "shouty", GOOD)))
    plugins.set_enabled("shouty", True)
    entry = [p for p in plugins.listing() if p["id"] == "shouty"][0]
    assert entry["loaded"] and not entry["error"] and {a["id"] for a in entry["actions"]} == {"shout", "peek", "naughty"}
    assert db.get_setting("plugin:shouty")["hello"] == "world"
    assert plugins.run_action("shouty", "shout", {"text": "hi"}) == {"said": "HI"}
    assert plugins.run_action("shouty", "peek", {})["rows"] >= 0
    with pytest.raises(PermissionError):
        plugins.run_action("shouty", "naughty", {})
    with pytest.raises(ValueError):
        plugins.run_action("shouty", "ghost", {})

    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES ('plug-d1', ?, 'freeform', 'x', 'ready')", (db.now_iso(),))
    plugins.on_dump("plug-d1")
    s = suggestions.pending()[0]
    assert s["kind"] == "plugin_action" and s["source"] == "plugin:shouty" and s["payload"]["plugin"] == "shouty"
    done = suggestions.accept(s["id"])
    assert done["status"] == "accepted" and done["result"]["said"] == "PLUG-D1"

    plugins.set_enabled("shouty", False)
    assert plugins.all_actions() == []
    plugins.uninstall("shouty")
    assert plugins.listing() == []


def test_broken_plugin_is_isolated(tmp_path):
    plugins.install(str(make(tmp_path / "boom", "boom", BROKEN)))
    plugins.install(str(make(tmp_path / "shouty", "shouty", GOOD)))
    plugins.set_enabled("boom", True)
    plugins.set_enabled("shouty", True)
    by = {p["id"]: p for p in plugins.listing()}
    assert by["boom"]["error"] and not by["boom"]["loaded"]
    assert by["shouty"]["loaded"] and by["shouty"]["error"] is None
    assert plugins.run_action("shouty", "shout", {"text": "ok"})["said"] == "OK"


def test_example_plugin_ships_and_loads():
    src = Path(__file__).resolve().parents[1] / "examples" / "plugins" / "daily-digest"
    assert plugins.install(str(src))["id"] == "daily-digest"
    plugins.set_enabled("daily-digest", True)
    entry = [p for p in plugins.listing() if p["id"] == "daily-digest"][0]
    assert entry["loaded"] and [a["id"] for a in entry["actions"]] == ["digest_now"]
    assert isinstance(plugins.run_action("daily-digest", "digest_now", {"day": "1999-01-01"})["digest"], str)


def test_routes(tmp_path):
    c = TestClient(create_app())
    assert c.get("/api/plugins").json() == []
    src = make(tmp_path / "shouty", "shouty", GOOD)
    assert c.post("/api/plugins/install", json={"path": str(src)}).json()["id"] == "shouty"
    assert c.post("/api/plugins/install", json={"path": str(tmp_path / "ghost")}).status_code == 400
    assert c.put("/api/plugins/shouty/enabled", json={"enabled": True}).json()[0]["loaded"]
    assert c.post("/api/plugins/shouty/actions/shout", json={"args": {"text": "yo"}}).json()["said"] == "YO"
    assert c.post("/api/plugins/shouty/actions/nope", json={"args": {}}).status_code == 400
    assert c.delete("/api/plugins/shouty").json()["ok"]
    assert c.get("/api/plugins").json() == []
