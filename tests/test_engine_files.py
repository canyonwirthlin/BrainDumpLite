import pytest
from fastapi.testclient import TestClient

from app import catalog, db, engine
from app.main import create_app


@pytest.fixture(autouse=True)
def models_dir(monkeypatch):
    create_app()
    monkeypatch.setattr(catalog, "fetch_remote", lambda timeout=10.0: None)
    d = engine.models_dir()
    assert "bdl-test-" in str(d), "tests must never touch the real models folder"
    yield d
    for p in d.glob("*"):
        p.unlink()
    db.execute("DELETE FROM settings WHERE key IN ('builtin_model', 'catalog_cache')")
    engine._phase("idle")


def _model():
    return catalog.chat_models()[0]


def test_delete_removes_model_and_partial(models_dir):
    m = _model()
    (models_dir / m["file"]).write_bytes(b"x" * 10)
    (models_dir / (m["file"] + ".part")).write_bytes(b"y")
    assert engine.delete_model(m["id"]) == (True, "deleted")
    assert not (models_dir / m["file"]).exists() and not (models_dir / (m["file"] + ".part")).exists()
    assert engine.delete_model("no-such-model") == (False, "Unknown model")


def test_deleting_the_active_model_turns_builtin_ai_off(models_dir):
    m = _model()
    (models_dir / m["file"]).write_bytes(b"x")
    db.set_setting("builtin_model", m["id"])
    assert engine.delete_model(m["id"])[0] is True
    assert engine.active_model() == "" and not engine.is_configured()
    assert not (models_dir / m["file"]).exists()


def test_nothing_is_deleted_while_a_download_runs(models_dir):
    m = _model()
    (models_dir / m["file"]).write_bytes(b"x")
    (models_dir / "old.gguf").write_bytes(b"x")
    engine._phase("model", m["label"])
    assert engine.delete_model(m["id"])[0] is False
    assert engine.delete_file("old.gguf")[0] is False
    assert (models_dir / m["file"]).exists() and (models_dir / "old.gguf").exists()
    engine._phase("idle")
    assert engine.delete_file("old.gguf")[0] is True


def test_other_files_lists_strays_and_only_deletes_those(models_dir):
    m = _model()
    (models_dir / m["file"]).write_bytes(b"x")                       # a catalog model: not "other"
    (models_dir / engine.EMBED_MODEL["file"]).write_bytes(b"x")      # the search model: not "other"
    (models_dir / "dropped-model.gguf").write_bytes(b"x" * (3 << 20))
    (models_dir / "half.gguf.part").write_bytes(b"x")
    (models_dir / "notes.txt").write_text("keep me")
    listed = {f["name"]: f for f in engine.status()["other_files"]}
    assert set(listed) == {"dropped-model.gguf", "half.gguf.part"}
    assert listed["dropped-model.gguf"]["size_mb"] == 3 and listed["half.gguf.part"]["partial"] is True
    for bad in ("../escape.gguf", "..\\escape.gguf", m["file"], engine.EMBED_MODEL["file"], "notes.txt", "C:\\x.gguf", "missing.gguf"):
        assert engine.delete_file(bad)[0] is False, bad
    assert (models_dir / m["file"]).exists() and (models_dir / "notes.txt").exists()
    assert engine.delete_file("dropped-model.gguf")[0] is True
    assert [f["name"] for f in engine.other_files()] == ["half.gguf.part"]


def test_api_delete_file_and_active_model(models_dir):
    client = TestClient(create_app())
    m = _model()
    (models_dir / m["file"]).write_bytes(b"x")
    (models_dir / "leftover.gguf").write_bytes(b"x")
    assert client.delete("/api/engine/files/leftover.gguf").status_code == 200
    assert client.delete("/api/engine/files/leftover.gguf").status_code == 400
    assert client.delete("/api/engine/files/..%2Fsecret.gguf").status_code in (400, 404, 405)   # never 200
    db.set_setting("builtin_model", m["id"])
    assert client.delete(f"/api/engine/models/{m['id']}").status_code == 200
    assert client.get("/api/engine/status").json()["active_model"] == ""
