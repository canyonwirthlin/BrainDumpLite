import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import ai, backup, db, embeddings, engine
from app.main import create_app


@pytest.fixture
def client():
    return TestClient(create_app())


def _dump(did, title="t", concepts=(), people=(), tone=None, created=None, emb=None):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, concepts, people, tone, embedding) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?)",
               (did, created or db.now_iso(), "freeform", "some words here", "some words here", title, "s",
                json.dumps(list(concepts)), json.dumps(list(people)), json.dumps(tone) if tone else None, emb))


def _task(iid, due=None, done=0, content="do it"):
    _dump("host-" + iid)
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (iid, "host-" + iid, "task", content, "approved", done, due, db.now_iso()))


# ── backups ──────────────────────────────────────────────────────────────────

def test_backup_run_prunes_and_is_a_valid_db(client, tmp_path):
    client.put("/api/autobackup", json={"dir": str(tmp_path), "keep": 2})
    _dump("b1", "kept")
    names = []
    for _ in range(3):
        r = client.post("/api/autobackup/run")
        assert r.status_code == 200
        names.append(r.json()["name"])
        import time; time.sleep(1.1)   # names carry seconds
    st = client.get("/api/autobackup").json()
    assert st["count"] == 2 and st["folder"] == str(tmp_path)
    import sqlite3
    c = sqlite3.connect(str(tmp_path / st["backups"][0]["name"]))
    assert c.execute("select count(*) from dumps where id='b1'").fetchone()[0] == 1
    c.close()
    db.execute("DELETE FROM dumps WHERE id='b1'")
    db.set_setting(backup.KEY, {})


def test_backup_due_logic(client, tmp_path):
    client.put("/api/autobackup", json={"dir": str(tmp_path), "enabled": True})
    assert backup._due()                      # none yet
    client.post("/api/autobackup/run")
    assert not backup._due()                  # fresh one exists
    client.put("/api/autobackup", json={"enabled": False})
    assert not backup._due()
    db.set_setting(backup.KEY, {})


# ── embeddings ───────────────────────────────────────────────────────────────

def test_rebuild_fills_missing_embeddings(client, monkeypatch):
    _dump("e1")
    _dump("e2", emb=json.dumps([0.1]))
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "embed", lambda t: [0.5, 0.5])
    assert client.get("/api/embeddings/status").json()["missing"] >= 1
    assert client.post("/api/embeddings/rebuild").status_code == 200
    import time
    for _ in range(50):
        if not embeddings.status()["running"]:
            break
        time.sleep(0.1)
    assert db.query_one("SELECT embedding FROM dumps WHERE id='e1'")["embedding"] == "[0.5, 0.5]"
    assert db.query_one("SELECT embedding FROM dumps WHERE id='e2'")["embedding"] == "[0.1]"
    for d in ("e1", "e2"):
        db.execute("DELETE FROM dumps WHERE id=?", (d,))


def test_rebuild_needs_an_ai(client, monkeypatch):
    monkeypatch.setattr(ai, "available", lambda: False)
    assert client.post("/api/embeddings/rebuild").status_code == 400


# ── cancel ───────────────────────────────────────────────────────────────────

def test_cancel_only_while_downloading(client):
    engine._phase("done")
    assert client.post("/api/engine/cancel").json() == {"cancelled": False}
    engine._phase("model", "x")
    assert client.post("/api/engine/cancel").json() == {"cancelled": True}
    assert engine._cancel.is_set()
    engine._cancel.clear()
    engine._phase("done")


# ── snooze / reschedule ──────────────────────────────────────────────────────

def test_snooze_reschedules_an_overdue_task(client):
    old = (date.today() - timedelta(days=4)).isoformat()
    new = (date.today() + timedelta(days=2)).isoformat()
    _task("s1", due=old + "T09:30")
    r = client.post("/api/items/s1/snooze", json={"until": new}).json()
    assert r["snoozed_until"] == new and r["due_date"] == new + "T09:30"
    client.post("/api/items/s1/unsnooze")
    assert db.query_one("SELECT snoozed_until FROM items WHERE id='s1'")["snoozed_until"] is None
    db.execute("DELETE FROM dumps WHERE id='host-s1'")


def test_snooze_keeps_a_later_due_date_and_rejects_the_past(client):
    later = (date.today() + timedelta(days=10)).isoformat()
    _task("s2", due=later)
    soon = (date.today() + timedelta(days=1)).isoformat()
    assert client.post("/api/items/s2/snooze", json={"until": soon}).json()["due_date"] == later
    assert client.post("/api/items/s2/snooze", json={"until": "2001-01-01"}).status_code == 400
    assert client.post("/api/items/s2/snooze", json={"until": "nope"}).status_code == 400
    assert client.post("/api/items/missing/snooze", json={"until": soon}).status_code == 404
    db.execute("DELETE FROM dumps WHERE id='host-s2'")


def test_reschedule_all_overdue(client):
    y = (date.today() - timedelta(days=1)).isoformat()
    _task("o1", due=y)
    _task("o2", due=y, done=1)                 # finished: untouched
    _task("o3", due=None)                      # undated: untouched
    new = (date.today() + timedelta(days=3)).isoformat()
    assert client.post("/api/tasks/reschedule-overdue", json={"until": new}).json()["moved"] == 1
    assert db.query_one("SELECT due_date FROM items WHERE id='o1'")["due_date"] == new
    assert db.query_one("SELECT due_date FROM items WHERE id='o2'")["due_date"] == y
    for i in ("o1", "o2", "o3"):
        db.execute("DELETE FROM dumps WHERE id=?", ("host-" + i,))


# ── habits ───────────────────────────────────────────────────────────────────

def test_daily_habit_streak(client):
    h = client.post("/api/habits", json={"title": "Stretch"}).json()
    today = date.today()
    for back in (1, 2, 3):                     # yesterday and before; today still pending
        client.post(f"/api/habits/{h['id']}/check", json={"day": (today - timedelta(days=back)).isoformat()})
    v = client.get("/api/habits").json()[0]
    assert v["streak"] == 3 and not v["done_today"]
    v = client.post(f"/api/habits/{h['id']}/check", json={}).json()
    assert v["streak"] == 4 and v["done_today"] and v["best"] == 4
    v = client.post(f"/api/habits/{h['id']}/check", json={"done": False}).json()
    assert v["streak"] == 3
    assert client.post(f"/api/habits/{h['id']}/check", json={"day": (today + timedelta(days=1)).isoformat()}).status_code == 400
    client.delete(f"/api/habits/{h['id']}")
    assert client.get("/api/habits").json() == []


def test_weekly_habit_counts_weeks(client):
    h = client.post("/api/habits", json={"title": "Gym", "frequency": "weekly", "target": 2}).json()
    mon = date.today() - timedelta(days=date.today().weekday())
    for w in (1, 2):                            # two previous weeks, two check-ins each
        for d in (0, 2):
            client.post(f"/api/habits/{h['id']}/check", json={"day": (mon - timedelta(days=7 * w) + timedelta(days=d)).isoformat()})
    v = client.get("/api/habits").json()[0]
    assert v["streak"] == 2 and v["target"] == 2
    client.delete(f"/api/habits/{h['id']}")


# ── weekly digest ────────────────────────────────────────────────────────────

def test_weekly_digest(client):
    now = datetime.now(timezone.utc)
    _dump("w1", concepts=["sleep", "Gym"], people=["Sam"], tone={"label": "hopeful", "valence": 1, "energy": 1}, created=now.isoformat())
    _dump("w2", concepts=["sleep"], people=["Sam"], tone={"label": "low", "valence": -2, "energy": 0}, created=now.isoformat())
    d = client.get("/api/digest/weekly").json()
    assert d["current"] and d["dumps"] >= 2
    assert d["concepts"][0]["name"].lower() == "sleep" and d["concepts"][0]["count"] >= 2
    assert d["people"][0]["name"] == "Sam"
    assert d["mood"]["avg"] is not None and len(d["days"]) == 7
    older = client.get("/api/digest/weekly?weeks_back=3").json()
    assert not older["current"] and older["start"] < d["start"]
    for x in ("w1", "w2"):
        db.execute("DELETE FROM dumps WHERE id=?", (x,))


# ── duplicate hints / dismissed reset ────────────────────────────────────────

def test_hints_and_reset(client):
    _dump("h1", people=["Bela"])
    _dump("h2", people=["Bella"])
    assert client.get("/api/merge/hints").json()["person"] >= 1
    client.post("/api/merge/dismiss", json={"kind": "person", "names": ["Bela", "Bella"]})
    assert client.get("/api/merge/hints").json()["person"] == 0
    assert client.post("/api/merge/dismiss/reset").json()["cleared"] >= 1
    assert client.get("/api/merge/hints").json()["person"] >= 1
    for x in ("h1", "h2"):
        db.execute("DELETE FROM dumps WHERE id=?", (x,))
