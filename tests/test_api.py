from fastapi.testclient import TestClient

from app.main import create_app
from app.version import __version__


def test_changelog_endpoint_lists_entries():
    client = TestClient(create_app())
    r = client.get("/api/changelog")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == __version__
    # The newest entry may be the NEXT version (notes are written before release.ps1 bumps),
    # but the running version must always have its own section.
    assert __version__ in [e["version"] for e in body["entries"]]


def test_status_has_no_legacy_update_key():
    client = TestClient(create_app())
    assert "update_ready" not in client.get("/api/status").json()


def test_streaks_endpoint_shape():
    client = TestClient(create_app())
    body = client.get("/api/streaks").json()
    assert body["current_streak"] == 0 and body["at_risk"] is False
    assert set(body["words"]) == {"week", "month", "year", "alltime"}


def test_engine_gpu_endpoint_shape():
    client = TestClient(create_app())
    body = client.get("/api/engine/gpu").json()
    assert "vram_mb" in body["gpu"] and isinstance(body["capable"], bool)
    assert "idle_offload_minutes" in body


def test_onboarding_complete_sets_status():
    client = TestClient(create_app())
    client.post("/api/onboarding/complete")
    assert client.get("/api/status").json()["onboarded"] is True
