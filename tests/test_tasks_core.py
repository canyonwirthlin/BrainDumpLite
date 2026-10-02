import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import db, planner, routes_tasks as rt
from app.main import create_app


@pytest.fixture
def client():
    c = TestClient(create_app())
    for t in ("items", "items_fts", "task_folders"):   # the data dir is shared across the session: start clean
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM dumps WHERE id='h'")
    return c


def _task(iid, due=None, content="do it", **cols):
    if not db.query_one("SELECT id FROM dumps WHERE id='h'"):
        db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status) "
                   "VALUES ('h',?,?,?,?,?,?,'ready')", (db.now_iso(), "freeform", "x", "x", "t", "s"))
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (iid, "h", "task", content, "approved", 0, due, db.now_iso()))
    for k, v in cols.items():
        db.execute(f"UPDATE items SET {k}=? WHERE id=?", (v, iid))


# ── date math ────────────────────────────────────────────────────────────────

def test_add_months_clamps_to_month_end():
    assert rt.add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert rt.add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)     # leap year
    assert rt.add_months(date(2026, 3, 31), 1) == date(2026, 4, 30)
    assert rt.add_months(date(2026, 11, 30), 3) == date(2027, 2, 28)    # year rollover
    assert rt.add_months(date(2026, 12, 15), 1) == date(2027, 1, 15)


def test_next_due_from_due_keeps_schedule_and_time():
    today = date(2026, 6, 10)
    assert rt.next_due({"every": 1, "unit": "day", "from": "due"}, "2026-06-10T09:30", today) == "2026-06-11T09:30"
    assert rt.next_due({"every": 1, "unit": "week", "from": "due"}, "2026-06-10", today) == "2026-06-17"
    # overdue: skip past dates instead of respawning in the past
    assert rt.next_due({"every": 1, "unit": "week", "from": "due"}, "2026-05-20", today) == "2026-06-17"
    # month-end anchor doesn't drift after clamping
    assert rt.next_due({"every": 1, "unit": "month", "from": "due"}, "2026-01-31", date(2026, 2, 28)) == "2026-03-31"


def test_next_due_from_done_counts_from_completion():
    today = date(2026, 6, 10)
    rec = {"every": 2, "unit": "week", "from": "done"}
    assert rt.next_due(rec, "2026-01-01", today) == "2026-06-24"
    assert rt.next_due(rec, None, today) == "2026-06-24"
    assert rt.next_due({"every": 1, "unit": "month", "from": "done"}, None, date(2026, 1, 31)) == "2026-02-28"


def test_clean_recurrence_validation():
    assert rt.clean_recurrence(None) is None
    assert rt.clean_recurrence({"every": "2", "unit": "week"}) == {"every": 2, "unit": "week", "from": "due"}
    for bad in ({"every": 0, "unit": "day"}, {"every": 1, "unit": "year"}, {"every": 1, "unit": "day", "from": "x"}, {"unit": "day"}, "daily"):
        with pytest.raises(ValueError):
            rt.clean_recurrence(bad)


# ── recurring completion ─────────────────────────────────────────────────────

def test_completing_a_recurring_task_spawns_the_next(client):
    due = date.today().isoformat() + "T08:00"
    _task("r1", due=due, priority=3, folder_id=None)
    r = client.put("/api/items/r1/recurrence", json={"recurrence": {"every": 1, "unit": "day", "from": "due"}})
    assert r.status_code == 200 and json.loads(r.json()["recurrence"])["unit"] == "day"
    client.patch("/api/items/r1", json={"done": True})
    rows = db.query("SELECT * FROM items WHERE content='do it' ORDER BY done DESC")
    assert len(rows) == 2
    done, new = rows[0], rows[1]
    assert done["id"] == "r1" and done["recurrence"] is None          # finished one can't spawn again
    assert new["done"] == 0 and new["priority"] == 3
    assert new["due_date"] == (date.today() + timedelta(days=1)).isoformat() + "T08:00"
    assert json.loads(new["recurrence"])["every"] == 1
    # re-completing / reopening the finished one doesn't spawn a third
    client.patch("/api/items/r1", json={"done": False})
    client.patch("/api/items/r1", json={"done": True})
    assert db.query_one("SELECT COUNT(*) n FROM items WHERE content='do it'")["n"] == 2
    assert any(t["id"] == new["id"] for t in client.get("/api/tasks").json())


def test_every_two_weeks_after_done(client):
    _task("r2", due="2020-01-01")
    client.put("/api/items/r2/recurrence", json={"recurrence": {"every": 2, "unit": "week", "from": "done"}})
    client.patch("/api/items/r2", json={"done": True})
    new = db.query_one("SELECT due_date FROM items WHERE id != 'r2' AND content='do it'")
    assert new["due_date"] == (date.today() + timedelta(weeks=2)).isoformat()


def test_non_recurring_and_cleared_recurrence_do_not_spawn(client):
    _task("n1")
    client.patch("/api/items/n1", json={"done": True})
    _task("n2", content="other")
    client.put("/api/items/n2/recurrence", json={"recurrence": {"every": 1, "unit": "day"}})
    client.put("/api/items/n2/recurrence", json={"recurrence": None})
    client.patch("/api/items/n2", json={"done": True})
    assert db.query_one("SELECT COUNT(*) n FROM items")["n"] == 2


def test_recurrence_endpoint_validation(client):
    _task("v1")
    assert client.put("/api/items/v1/recurrence", json={"recurrence": {"every": 0, "unit": "day"}}).status_code == 400
    assert client.put("/api/items/nope/recurrence", json={"recurrence": None}).status_code == 404


# ── folders ──────────────────────────────────────────────────────────────────

def test_folder_lifecycle_and_delete_keeps_tasks(client):
    f = client.post("/api/task-folders", json={"name": "  Work "}).json()
    assert f["name"] == "Work"
    assert client.post("/api/task-folders", json={"name": "  "}).status_code == 400
    _task("f1")
    assert client.put("/api/items/f1/folder", json={"folder_id": f["id"]}).json()["folder_id"] == f["id"]
    assert client.put("/api/items/f1/folder", json={"folder_id": "bogus"}).status_code == 404
    listed = client.get("/api/task-folders").json()
    assert listed[0]["open_count"] == 1
    assert client.get("/api/tasks").json()[0]["folder_id"] == f["id"]
    assert client.patch(f"/api/task-folders/{f['id']}", json={"name": "Home"}).json()["name"] == "Home"
    assert client.delete(f"/api/task-folders/{f['id']}").status_code == 200
    row = db.query_one("SELECT folder_id FROM items WHERE id='f1'")
    assert row is not None and row["folder_id"] is None             # task survives, unfiled
    assert client.get("/api/task-folders").json() == []
    assert client.delete("/api/task-folders/gone").status_code == 404


def test_recurrence_copy_keeps_folder(client):
    f = client.post("/api/task-folders", json={"name": "W"}).json()
    _task("fr", folder_id=f["id"])
    client.put("/api/items/fr/recurrence", json={"recurrence": {"every": 1, "unit": "week"}})
    client.patch("/api/items/fr", json={"done": True})
    assert db.query_one("SELECT folder_id FROM items WHERE id != 'fr'")["folder_id"] == f["id"]


# ── snooze gaps ──────────────────────────────────────────────────────────────

def test_snoozed_tasks_are_not_offered_by_the_planner(client):
    _task("s1", content="later")
    _task("s2", content="now")
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    client.post("/api/items/s1/snooze", json={"until": tomorrow})
    assert [t["id"] for t in planner.backlog()] == ["s2"]
    client.post("/api/items/s1/unsnooze")
    assert {t["id"] for t in planner.backlog()} == {"s1", "s2"}


def test_snooze_survives_in_tasks_list_for_the_ui(client):
    _task("s3")
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    client.post("/api/items/s3/snooze", json={"until": tomorrow})
    t = client.get("/api/tasks").json()[0]
    assert t["snoozed_until"] == tomorrow


def test_reschedule_overdue_moves_only_overdue(client):
    _task("o1", due="2020-01-01")
    _task("o2", due=(date.today() + timedelta(days=5)).isoformat())
    until = (date.today() + timedelta(days=1)).isoformat()
    assert client.post("/api/tasks/reschedule-overdue", json={"until": until}).json()["moved"] == 1
    assert db.query_one("SELECT due_date FROM items WHERE id='o1'")["due_date"] == until
