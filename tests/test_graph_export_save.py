"""POST /api/graph/export/save: the client names an absolute path, so the endpoint has to be strict."""
import base64

import pytest
from fastapi.testclient import TestClient

from app import db
from app import routes_graph_export as rge
from app.main import create_app


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app())


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


PNG = b"\x89PNG\r\n\x1a\n" + b"rest"
WEBM = b"\x1a\x45\xdf\xa3" + b"rest"
GOOD = {"map.svg": b"<svg/>", "map.png": PNG, "map.canvas": b'{"nodes":[],"edges":[]}', "map.webm": WEBM,
        "MAP.SVG": b'<?xml version="1.0"?><svg/>'}


def _save(client, path, data=b"<svg/>"):
    return client.post("/api/graph/export/save", json={"path": str(path), "data": _b64(data)})


def test_save_writes_file(client, tmp_path):
    target = tmp_path / "map.svg"
    r = _save(client, target)
    assert r.status_code == 200 and r.json()["path"] == str(target.resolve())
    assert target.read_bytes() == b"<svg/>"
    assert [p.name for p in tmp_path.iterdir()] == ["map.svg"]      # no temp file left behind


@pytest.mark.parametrize("name", sorted(GOOD))
def test_save_allowed_extensions(client, tmp_path, name):
    assert _save(client, tmp_path / name, GOOD[name]).status_code == 200


def test_save_overwrites_plain_file(client, tmp_path):
    target = tmp_path / "map.svg"
    target.write_text("old")
    assert _save(client, target, b"<svg>new</svg>").status_code == 200
    assert target.read_bytes() == b"<svg>new</svg>"


def test_save_rejects_bad_requests(client, tmp_path):
    ok = _b64(b"<svg/>")

    def post(path, data=ok):
        return client.post("/api/graph/export/save", json={"path": path, "data": data}).status_code

    assert post("map.png") == 400                                                  # relative
    assert post(str(tmp_path / "evil.exe")) == 400
    assert post(str(tmp_path / "evil.svg.exe")) == 400
    assert post(str(tmp_path / "noexist" / "m.svg")) == 400
    assert post(str(tmp_path / "m.svg"), "!!not base64!!") == 400
    assert post(str(tmp_path / "m.png")) == 400                                    # svg bytes under a png name
    assert post(str(tmp_path / "m.canvas"), _b64(b"not json")) == 400
    assert post(str(tmp_path / "m.canvas"), _b64(b"[1,2]")) == 400
    assert post(str(tmp_path / ".svg")) == 400                                     # no name
    assert post(str(tmp_path / "m\x00.svg")) == 400
    assert post("\\\\server\\share\\m.svg") == 400                                  # UNC / network
    assert post("") == 400
    assert not list(tmp_path.iterdir())


def test_save_refuses_app_folders_and_dot_directories(client, tmp_path):
    assert _save(client, db.data_dir() / "vault-note.svg").status_code == 400
    assert _save(client, rge.CODE_DIR / "app" / "x.svg").status_code == 400
    assert not (rge.CODE_DIR / "app" / "x.svg").exists() and not (db.data_dir() / "vault-note.svg").exists()
    hidden = tmp_path / ".ssh"
    hidden.mkdir()
    assert _save(client, hidden / "m.svg").status_code == 400
    assert _save(client, tmp_path / ".hidden.svg").status_code == 400


def test_save_refuses_folders_and_symlinks(client, tmp_path):
    (tmp_path / "dir.svg").mkdir()
    assert _save(client, tmp_path / "dir.svg").status_code == 400
    real = tmp_path / "real.svg"
    real.write_text("keep")
    link = tmp_path / "link.svg"
    try:
        link.symlink_to(real)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not available")
    assert _save(client, link).status_code == 400
    assert real.read_text() == "keep"


def test_save_refuses_through_symlinked_folder_into_app_data(client, tmp_path):
    link = tmp_path / "sneaky"
    try:
        link.symlink_to(db.data_dir(), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not available")
    assert _save(client, link / "m.svg").status_code == 400
    assert not (db.data_dir() / "m.svg").exists()


def test_save_rejects_huge_bodies(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rge, "MAX_BYTES", 1000)
    monkeypatch.setattr(rge, "MAX_BODY", 2000)
    r = _save(client, tmp_path / "big.svg", b"<svg>" + b"x" * 5000)
    assert r.status_code == 413 and not list(tmp_path.iterdir())
    assert _save(client, tmp_path / "ok.svg").status_code == 200


def test_save_errors_do_not_leak_internals(client, tmp_path):
    r = _save(client, tmp_path / "nofolder" / "m.svg")
    assert r.status_code == 400 and "Traceback" not in r.text and str(tmp_path) not in r.text
