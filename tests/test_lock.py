import pytest
from fastapi.testclient import TestClient

from app import db, lock
from app.main import create_app


@pytest.fixture(autouse=True)
def no_lock():
    create_app()
    yield
    db.execute("DELETE FROM settings WHERE key='app_lock'")
    lock.boot()


def test_set_verify_clear():
    assert not lock.is_set()
    with pytest.raises(ValueError):
        lock.set_passphrase("abc")
    lock.set_passphrase("hunter2")
    assert lock.is_set() and lock.verify("hunter2") and not lock.verify("nope")
    with pytest.raises(ValueError):
        lock.set_passphrase("newpass", current="wrong")
    lock.set_passphrase("newpass", current="hunter2")
    assert lock.verify("newpass")
    with pytest.raises(ValueError):
        lock.clear("wrong")
    lock.clear("newpass")
    assert not lock.is_set() and not lock.locked()


def test_middleware_gates_api_while_locked():
    client = TestClient(create_app())
    assert client.post("/api/lock/set", json={"passphrase": "hunter2"}).status_code == 200
    assert client.post("/api/lock/now").status_code == 200
    assert client.get("/api/status").json()["locked"] is True
    assert client.get("/api/dumps").status_code == 423
    assert client.get("/api/changelog").status_code == 200
    assert client.post("/api/unlock", json={"passphrase": "wrong"}).status_code == 401
    assert client.post("/api/unlock", json={"passphrase": "hunter2"}).status_code == 200
    assert client.get("/api/dumps").status_code == 200
    assert client.post("/api/lock/clear", json={"passphrase": "hunter2"}).status_code == 200
    assert client.get("/api/status").json()["lock_set"] is False
