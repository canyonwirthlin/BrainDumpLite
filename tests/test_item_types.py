import pytest
from fastapi.testclient import TestClient

from app import db, item_types
from app.main import create_app


@pytest.fixture(autouse=True)
def fresh_types():
    create_app()  # init_db + seed
    yield
    for t in item_types.all():
        if not t["builtin"]:
            item_types.delete(t["id"])
        else:
            item_types.update(t["id"], enabled=True)


def test_seed_is_idempotent_and_ordered():
    item_types.seed()
    ids = [t["id"] for t in item_types.all() if t["builtin"]]
    assert ids == ["task", "goal", "idea", "concern", "event", "note"]
    assert all(t["enabled"] for t in item_types.all())


def test_create_update_enum_prompt():
    t = item_types.create("Question", icon="❓", color="blue", hint="something the user wants answered")
    assert t["id"] == "question" and not t["builtin"] and t["enabled"]
    with pytest.raises(ValueError):
        item_types.create("Question")
    with pytest.raises(ValueError):
        item_types.create("Q", color="purple")
    assert "question" in item_types.enum()
    assert "- question: something the user wants answered" in item_types.prompt_rules()
    item_types.update("question", label="Open question", color="#ff00aa", enabled=False)
    assert item_types.get("question")["label"] == "Open question"
    assert "question" not in item_types.enum()
    assert "question" not in item_types.prompt_rules()


def test_builtin_protection_and_delete_rekinds_items():
    with pytest.raises(ValueError):
        item_types.delete("task")
    with pytest.raises(ValueError):
        item_types.update("task", enabled=False)
    item_types.create("Gratitude")
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES ('d1', '2026-01-01T00:00:00', 'freeform', 'x', 'ready')")
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('i1', 'd1', 'gratitude', 'thanks', 'suggested', 0, '2026-01-01T00:00:00')")
    item_types.delete("gratitude")
    assert db.query_one("SELECT kind FROM items WHERE id='i1'")["kind"] == "note"
    db.execute("DELETE FROM dumps WHERE id='d1'")


def test_api_round_trip():
    client = TestClient(create_app())
    r = client.post("/api/item-types", json={"label": "Decision", "color": "green", "hint": "a choice made"})
    assert r.status_code == 200 and r.json()["id"] == "decision"
    assert client.post("/api/item-types", json={"label": "Decision"}).status_code == 400
    assert client.put("/api/item-types/decision", json={"label": "Decision made", "enabled": False}).json()["enabled"] is False
    ids = [t["id"] for t in client.get("/api/item-types").json()]
    assert "decision" in ids and ids[:6] == ["task", "goal", "idea", "concern", "event", "note"]
    assert client.delete("/api/item-types/task").status_code == 400
    assert client.delete("/api/item-types/decision").status_code == 200


def test_item_can_be_retagged_into_a_custom_type():
    client = TestClient(create_app())
    client.post("/api/item-types", json={"label": "Question", "color": "#22aa88"})
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES ('d9', '2026-01-01T00:00:00', 'freeform', 'x', 'ready')")
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES ('i9', 'd9', 'note', 'why?', 'suggested', 0, '2026-01-01T00:00:00')")
    try:
        r = client.patch("/api/items/i9", json={"kind": "question"})
        assert r.status_code == 200 and r.json()["kind"] == "question"
        nodes = client.get("/api/graph?items=1").json()["nodes"]
        assert next(n for n in nodes if n["id"] == "item:i9")["type"] == "question"
        assert client.patch("/api/items/i9", json={"kind": "nonsense"}).status_code == 400
        client.put("/api/item-types/question", json={"enabled": False})
        assert client.patch("/api/items/i9", json={"kind": "question"}).status_code == 400   # disabled types can't be assigned
        assert client.patch("/api/items/i9", json={"kind": "idea"}).json()["kind"] == "idea"
        assert client.patch("/api/items/i9", json={"done": True}).json()["kind"] == "idea"   # other patches leave kind alone
    finally:
        db.execute("DELETE FROM dumps WHERE id='d9'")
