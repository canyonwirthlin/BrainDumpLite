from fastapi.testclient import TestClient

from app.main import create_app
from app.version import __version__


def test_changelog_endpoint_lists_entries():
    client = TestClient(create_app())
    r = client.get("/api/changelog")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == __version__
    assert body["entries"][0]["version"] == __version__


def test_status_has_no_legacy_update_key():
    client = TestClient(create_app())
    assert "update_ready" not in client.get("/api/status").json()
