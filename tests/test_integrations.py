import json
import os

import pytest
from fastapi.testclient import TestClient

from app import ai, db, google_cal, planner, secrets, suggestions, todoist
from app.main import create_app


@pytest.fixture(autouse=True)
def clean():
    create_app()
    yield
    db.execute("DELETE FROM suggestions")
    db.execute("DELETE FROM settings WHERE key LIKE 'secret:%' OR key IN ('google_client', 'google_account')")
    db.execute("DELETE FROM dumps WHERE id='int-d1'")


def test_secrets_round_trip():
    secrets.set_secret("t", "hello world")
    stored = db.get_setting("secret:t")
    assert stored.startswith("dpapi:" if os.name == "nt" else "plain:") and "hello world" not in stored
    assert secrets.get_secret("t") == "hello world"
    secrets.set_secret("t", None)
    assert secrets.get_secret("t") is None


def test_google_auth_url_and_callback(monkeypatch):
    with pytest.raises(ValueError):
        google_cal.auth_url(8756)
    google_cal.set_client("cid.apps.googleusercontent.com", "sec")
    url = google_cal.auth_url(8756)
    assert "code_challenge_method=S256" in url and "redirect_uri=http%3A%2F%2F127.0.0.1%3A8756%2Foauth%2Fgoogle%2Fcallback" in url
    state = url.split("state=")[1].split("&")[0]
    calls = []
    def fake_http(method, u, data=None, token=None, form=False):
        calls.append((method, u, data))
        if u == google_cal.TOKEN_URL:
            assert data["code_verifier"] and data["client_secret"] == "sec"
            return {"access_token": "at", "refresh_token": "rt", "expires_in": 3600}
        if u.endswith("/calendars/primary"):
            return {"id": "me@example.com"}
        if "/events" in u and method == "POST":
            return {"id": "ev1", "htmlLink": "https://cal/ev1"}
        if "/events?" in u:
            return {"items": [{"summary": "Standup", "start": {"dateTime": "2026-09-18T10:00:00-06:00"}, "end": {"dateTime": "2026-09-18T10:30:00-06:00"}}]}
        return {}
    monkeypatch.setattr(google_cal, "_http", fake_http)
    with pytest.raises(ValueError):
        google_cal.handle_callback("code", "bad-state")
    r = google_cal.handle_callback("code", state)
    assert r["connected"] and google_cal.connected() and r["account"] == "me@example.com"
    ev = google_cal.create_event("Dentist", "2026-09-25", "find the number")
    assert ev["id"] == "ev1"
    assert google_cal.events("2026-09-18")[0]["title"] == "Standup"
    google_cal.disconnect()
    assert not google_cal.connected()


def test_todoist_and_inbox_lifecycle(monkeypatch):
    posted = []
    def fake_http(method, url, data, token):
        assert token == "tok"
        if url.endswith("/projects"):
            return [{"id": 1}]
        posted.append(data)
        return {"id": "42", "url": "https://todoist.com/showTask?id=42"}
    monkeypatch.setattr(todoist, "_http", fake_http)
    assert todoist.set_token("tok") and todoist.connected()
    s = suggestions.create("todoist_push", "Send to Todoist: call mom", {"title": "call mom", "due": "2026-09-20"}, "manual")
    assert suggestions.count_pending() == 1
    done = suggestions.accept(s["id"], edits={"title": "Call Mom tonight"})
    assert done["status"] == "accepted" and done["result"]["id"] == "42" and posted[0]["content"] == "Call Mom tonight"
    bad = suggestions.create("calendar_push", "x", {"title": "no date"})
    assert suggestions.accept(bad["id"])["status"] == "failed"
    d = suggestions.create("todoist_push", "y", {"title": "y"})
    assert suggestions.dismiss(d["id"])["status"] == "dismissed" and suggestions.count_pending() == 0
    with pytest.raises(ValueError):
        suggestions.accept(d["id"])
    todoist.set_token(None)


def test_pipeline_proposes_only_when_connected(monkeypatch):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES ('int-d1', ?, 'freeform', 'x', 'ready')", (db.now_iso(),))
    db.execute("INSERT INTO items (id, dump_id, kind, content, due_date, status, done, created_at) VALUES ('int-i1', 'int-d1', 'task', 'book dentist', '2026-09-25', 'suggested', 0, ?)", (db.now_iso(),))
    assert suggestions.from_dump("int-d1") == 0
    monkeypatch.setattr(todoist, "connected", lambda: True)
    assert suggestions.from_dump("int-d1") == 1
    assert suggestions.pending()[0]["kind"] == "todoist_push"


def test_planner_gaps_and_greedy(monkeypatch):
    monkeypatch.setattr(google_cal, "connected", lambda: True)
    monkeypatch.setattr(google_cal, "events", lambda day: [{"title": "Standup", "start": f"{day}T10:00:00", "end": f"{day}T10:30:00", "all_day": False}])
    monkeypatch.setattr(planner, "backlog", lambda limit=15: [{"id": "t1", "content": "write report", "est_minutes": 60, "urgency": 3, "due_date": None}])
    monkeypatch.setattr(ai, "available", lambda: False)
    p = planner.plan("2026-09-18")
    assert p["gaps"][0] == {"start": "09:00", "end": "10:00"} and p["gaps"][1]["start"] == "10:30"
    assert p["via"] == "greedy" and p["slots"][0]["task_id"] == "t1" and p["slots"][0]["task"] == "write report"
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "chat_json", lambda *a, **k: {"slots": [{"start": "11:00", "end": "12:00", "task_id": "t1", "reason": "urgent"}, {"start": "13:00", "end": "14:00", "task_id": "nope"}]})
    p = planner.plan("2026-09-18")
    assert p["via"] == "ai" and [s["task_id"] for s in p["slots"]] == ["t1"]


def test_api_surface(monkeypatch):
    client = TestClient(create_app())
    assert client.get("/api/integrations").json()["google"]["connected"] is False
    assert client.get("/api/suggestions").json() == {"pending": [], "recent": []}
    assert client.get("/api/plan?day=2026-09-18").json()["day"] == "2026-09-18"
    assert client.get("/oauth/google/callback?error=access_denied").status_code == 200
