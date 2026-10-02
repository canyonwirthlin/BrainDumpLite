import pytest
from fastapi.testclient import TestClient

from app import db, phone, qr
from app.main import create_app


@pytest.fixture()
def clients(monkeypatch):
    main = create_app()
    phone.reset_limits()
    tok = phone.rotate_token()
    # keep the pipeline out of the way: just count that the normal create path ran
    monkeypatch.setattr("app.pipeline.run_pipeline", lambda dump_id: None)
    yield TestClient(phone.build_phone_app()), TestClient(main), tok
    phone.reset_limits()
    db.execute("DELETE FROM dumps_fts WHERE id IN (SELECT id FROM dumps WHERE raw_text LIKE 'x%' OR raw_text='hello from phone')")
    db.execute("DELETE FROM dumps WHERE raw_text LIKE 'x%' OR raw_text='hello from phone'")
    db.execute("DELETE FROM settings WHERE key='phone_token'")


def _post(c, tok, text="hello from phone", **kw):
    return c.post("/phone/capture", json={"text": text}, headers={"X-Phone-Token": tok}, **kw)


def test_token_required_and_dump_created(clients):
    ph, _, tok = clients
    assert _post(ph, "wrong").status_code == 403
    assert ph.post("/phone/capture", json={"text": "x"}).status_code == 403
    r = _post(ph, tok)
    assert r.status_code == 200
    row = db.query_one("SELECT raw_text, mode FROM dumps WHERE id=?", (r.json()["id"],))
    assert row["raw_text"] == "hello from phone" and row["mode"] == "freeform"


def test_page_only_with_token(clients):
    ph, _, tok = clients
    assert ph.get("/p/nope").status_code == 404
    r = ph.get(f"/p/{tok}")
    assert r.status_code == 200 and "Send to BrainDump" in r.text
    assert r.headers["cache-control"] == "no-store"


def test_rotate_invalidates_old_token(clients):
    ph, _, tok = clients
    assert _post(ph, tok).status_code == 200
    new = phone.rotate_token()
    assert new != tok
    assert _post(ph, tok).status_code == 403
    assert _post(ph, new).status_code == 200


def test_rate_limit(clients):
    ph, _, tok = clients
    codes = [_post(ph, tok).status_code for _ in range(phone.RATE_LIMIT + 3)]
    assert codes[:phone.RATE_LIMIT] == [200] * phone.RATE_LIMIT
    assert set(codes[phone.RATE_LIMIT:]) == {429}


def test_bad_token_brake(clients):
    ph, _, tok = clients
    for _ in range(phone.BAD_TOKEN_LIMIT):
        assert _post(ph, "guess").status_code == 403
    assert _post(ph, tok).status_code == 429  # even the right token waits out the brake
    assert ph.get(f"/p/{tok}").status_code == 429


def test_size_caps(clients):
    ph, _, tok = clients
    assert _post(ph, tok, text="x" * (phone.MAX_TEXT_CHARS + 1)).status_code == 413
    assert _post(ph, tok, text="x" * phone.MAX_TEXT_CHARS).status_code == 200
    big = ph.post("/phone/capture", content=b"{" + b" " * (phone.MAX_BODY_BYTES + 10) + b"}",
                  headers={"X-Phone-Token": tok})
    assert big.status_code == 413
    assert _post(ph, tok, text="   ").status_code == 400
    bad = ph.post("/phone/capture", content=b"not json", headers={"X-Phone-Token": tok})
    assert bad.status_code == 400


def test_nothing_else_is_exposed(clients):
    ph, _, tok = clients
    for path in ("/", "/api/dumps", "/api/settings", "/api/phone/status", "/docs", "/openapi.json",
                 "/index.html", "/static/index.html", "/phone.html", "/p", "/phone/capture/x"):
        assert ph.get(path).status_code in (404, 405), path
    assert ph.delete("/api/dumps/abc").status_code == 404
    assert ph.get("/phone/capture").status_code == 405


def test_settings_endpoints_local_only(clients):
    _, main, _ = clients
    assert main.get("/api/phone/status").json()["enabled"] is False
    remote = TestClient(create_app(), client=("192.168.1.50", 5000))
    assert remote.get("/api/phone/status").status_code == 403
    assert remote.put("/api/phone/enable", json={"enabled": True}).status_code == 403
    assert not phone.running()


def test_enable_disable_loopback_listener(clients, monkeypatch):
    _, main, _ = clients
    monkeypatch.setattr(phone, "lan_ip", lambda: "127.0.0.2")
    real_start = phone.start
    monkeypatch.setattr(phone, "start", lambda host="0.0.0.0", port=None: real_start("127.0.0.1", 18790))
    try:
        s = main.put("/api/phone/enable", json={"enabled": True}).json()
        assert s["enabled"] and s["url"].startswith("http://127.0.0.2:") and "/p/" in s["url"]
        assert s["qr_svg"].startswith("<svg")
        assert main.post("/api/phone/rotate").json()["url"] != s["url"]
    finally:
        assert main.put("/api/phone/enable", json={"enabled": False}).json()["enabled"] is False
    assert not phone.running()


def test_qr_encoder_shape():
    m = qr.encode("http://192.168.100.100:8790/p/" + "a" * 22)
    n = len(m)
    assert n in (29, 33, 37) and (n - 17) % 4 == 0
    # finder pattern corners are dark, timing pattern alternates
    assert m[0][0] and m[0][6] and m[6][0] and m[6][6] and not m[1][1] and m[2][2]
    assert [m[6][i] for i in range(8, 12)] == [True, False, True, False]
    with pytest.raises(ValueError):
        qr.encode("x" * 200)
