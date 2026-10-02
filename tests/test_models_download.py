"""Pause / resume / cancel of model downloads (against a local fake HTTP server with Range support),
and the Copy-diagnostics endpoint. No real model is ever downloaded."""
import hashlib
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app import db, engine
from app.main import create_app
from app.routes_models import redact

PAYLOAD = os.urandom(3 << 20)
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class _Handler(BaseHTTPRequestHandler):
    ranges: list = []
    delay = 0.05

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get("Range")
        _Handler.ranges.append(rng)
        start = int(rng.split("=")[1].rstrip("-")) if rng else 0
        body = PAYLOAD[start:]
        self.send_response(206 if rng else 200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            for i in range(0, len(body), 1 << 18):
                self.wfile.write(body[i:i + (1 << 18)])
                self.wfile.flush()
                time.sleep(_Handler.delay)
        except OSError:
            pass


@pytest.fixture
def server():
    _Handler.ranges, _Handler.delay = [], 0.05
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/m.gguf"
    srv.shutdown()


@pytest.fixture(autouse=True)
def clean():
    create_app()
    engine._cancel.clear()
    engine._phase("idle")
    yield
    engine._cancel.clear()
    engine._phase("idle")


def _run(url, dest, errors):
    try:
        engine._download(url, dest, SHA, len(PAYLOAD), "model", "test model")
    except Exception as e:
        errors.append(e)


def _wait(pred, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _start(url, dest):
    errors = []
    engine._cancel.clear()
    engine._phase("model", "test model")
    t = threading.Thread(target=_run, args=(url, dest, errors))
    t.start()
    return t, errors


def test_pause_keeps_partial_and_resume_uses_range(server, tmp_path):
    dest = tmp_path / "m.gguf"
    t, errors = _start(server, dest)
    assert _wait(lambda: engine.setup_progress()["done_mb"] >= 1)
    assert engine.pause_setup() is True
    t.join(10)
    assert [type(e) for e in errors] == [engine.SetupCancelled]
    part = tmp_path / "m.gguf.part"
    assert part.exists() and 0 < part.stat().st_size < len(PAYLOAD)
    kept = part.stat().st_size

    t, errors = _start(server, dest)
    t.join(30)
    assert not errors
    assert dest.read_bytes() == PAYLOAD and not part.exists()
    assert _Handler.ranges[0] is None and _Handler.ranges[1] == f"bytes={kept}-"


def test_cancel_discards_partial(server, tmp_path):
    dest = tmp_path / "m.gguf"
    t, errors = _start(server, dest)
    assert _wait(lambda: engine.setup_progress()["done_mb"] >= 1)
    assert engine.cancel_setup() is True
    t.join(10)
    assert [type(e) for e in errors] == [engine.SetupCancelled]
    assert not (tmp_path / "m.gguf.part").exists() and not dest.exists()


def test_speed_and_eta_reported(server, tmp_path):
    _Handler.delay = 0.2
    dest = tmp_path / "m.gguf"
    t, errors = _start(server, dest)
    assert _wait(lambda: engine.setup_progress().get("speed_mbps"))
    p = engine.setup_progress()
    assert p["speed_mbps"] > 0 and p["eta_s"] is not None
    engine.cancel_setup()
    t.join(10)


def test_pause_resume_api_and_state(monkeypatch):
    c = TestClient(create_app())
    assert c.post("/api/engine/pause").json() == {"paused": False}
    assert c.post("/api/engine/resume").status_code == 400
    engine._phase("model", "x")
    assert c.post("/api/engine/pause").json() == {"paused": True}
    assert engine._stop_mode == "pause" and engine._cancel.is_set()
    engine._cancel.clear()
    # paused phase: resume restarts setup for the same model; cancel discards the kept file
    engine._setup_model_id = engine.CHAT_MODELS()[0]["id"]
    engine._phase("paused", "p")
    started = []
    monkeypatch.setattr(engine, "start_setup", lambda mid: (started.append(mid), (True, "started"))[1])
    assert c.post("/api/engine/resume").status_code == 200 and started == [engine._setup_model_id]
    m = engine.CHAT_MODELS()[0]
    part = engine.model_path(m).with_name(m["file"] + ".part")
    part.write_bytes(b"x")
    assert c.post("/api/engine/cancel").json() == {"cancelled": True}
    assert not part.exists() and engine.setup_progress()["phase"] == "cancelled"


def test_diagnostics_has_no_private_data(monkeypatch):
    c = TestClient(create_app())
    db.execute("INSERT INTO dumps (id, created_at, raw_text) VALUES ('d1', '2026-01-01', 'SECRET DUMP TEXT')")
    user = os.environ.get("USERNAME") or os.environ.get("USER") or "someuser"
    log = engine._log_path("engine-chat.log")
    log.write_text(f"loading C:\\Users\\{user}\\models\\x.gguf key sk-abcdefghijklmnop1234", encoding="utf-8")
    try:
        r = c.get("/api/diagnostics")
        assert r.status_code == 200
        d = r.json()
        assert d["counts"]["dumps"] >= 1 and d["app_version"]
        blob = str(d)
        assert "SECRET DUMP TEXT" not in blob
        assert "sk-abcdefghijklmnop1234" not in blob
        assert f"\\{user}\\" not in blob and "<user>" in blob
        assert "BrainDump Lite" in d["text"]
    finally:
        log.unlink(missing_ok=True)
        db.execute("DELETE FROM dumps WHERE id='d1'")


def test_redact_keys():
    assert "AIzaSyA1234567890123456789012345" not in redact("k=AIzaSyA1234567890123456789012345")
    assert redact("") == ""
