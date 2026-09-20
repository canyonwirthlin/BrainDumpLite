"""Platform behaviour that only matters off Windows (and must not regress on it)."""
import os
import threading
from pathlib import Path

from app import db, engine, launch
from app.main import create_app
from fastapi.testclient import TestClient


def test_default_data_dir_per_platform():
    home = Path("/Users/sam")
    mac = db.default_data_dir(nt=False, platform="darwin", environ={}, home=home)
    assert mac.parts[-3:] == ("Library", "Application Support", "BrainDumpLite")
    assert db.default_data_dir(nt=False, platform="linux", environ={}, home=home).name == ".braindump-lite"
    win = db.default_data_dir(nt=True, platform="win32", environ={"LOCALAPPDATA": "C:/Local"}, home=home)
    assert win.parts[-2:] == ("Local", "BrainDumpLite")


def test_posix_parent_watchdog_fires_when_parent_disappears(monkeypatch):
    fired = threading.Event()
    state = {"alive": True}
    monkeypatch.setattr(os, "getppid", lambda: 1 if not state["alive"] else 4242, raising=False)   # re-parented to launchd
    def fake_kill(pid, sig):
        if not state["alive"]:
            raise ProcessLookupError
    monkeypatch.setattr(os, "kill", fake_kill)
    t = launch._watch_parent_posix(4242, fired.set, interval=0.05)
    assert not fired.wait(0.3)                       # parent alive: stays quiet
    state["alive"] = False
    assert fired.wait(2)                             # parent gone: shuts the backend down
    t.join(1)


def test_status_reports_platform_and_builtin_availability():
    body = TestClient(create_app()).get("/api/status").json()
    assert body["platform"] in ("windows", "macos", "linux")
    assert body["builtin_ai"] is engine.SUPPORTED


def test_builtin_ai_refuses_politely_where_unsupported(monkeypatch):
    monkeypatch.setattr(engine, "SUPPORTED", False)
    ok, msg = engine.start_setup("anything")
    assert not ok and "Gemini" in msg
    assert engine.status()["supported"] is False
    gpu = TestClient(create_app()).get("/api/engine/gpu").json()
    assert gpu["supported"] is False and gpu["capable"] is False     # never "recommend" an engine we can't run
