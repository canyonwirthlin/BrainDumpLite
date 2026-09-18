import json

import pytest
from fastapi.testclient import TestClient

from app import themes
from app.main import create_app

GOOD = {
    "id": "solar", "name": "Solar", "scheme": "dark",
    "colors": {"bg": "#000", "rail": "#050505", "panel": "#111111", "panel2": "#181818",
               "line": "#222222", "text": "#fafafa", "dim": "#999999", "accent": "#ffb000",
               "accent2": "#ff7000", "accentSoft": "rgba(255,176,0,.16)",
               "green": "#4ade80", "red": "#f87171", "amber": "#fbbf24"},
    "radius": 10,
}


def test_builtin_themes_are_valid_and_complete():
    ids = [t["id"] for t in themes.BUILTIN]
    assert ids == ["midnight", "ocean", "forest", "ember", "paper", "sakura"]
    for t in themes.BUILTIN:
        assert themes.validate(t) == t
        assert set(t["colors"]) == set(themes.COLOR_KEYS)


@pytest.mark.parametrize("mutate, reason", [
    (lambda t: t.update(id="Bad Id"), "id"),
    (lambda t: t.update(scheme="blue"), "scheme"),
    (lambda t: t["colors"].pop("dim"), "dim"),
    (lambda t: t["colors"].update(bg="red"), "bg"),
    (lambda t: t.update(radius=99), "radius"),
    (lambda t: t.update(id="midnight"), "reserved"),
])
def test_validate_rejects_bad_themes(mutate, reason):
    t = json.loads(json.dumps(GOOD))
    mutate(t)
    with pytest.raises(ValueError) as e:
        themes.import_theme(t)
    assert reason in str(e.value)


def test_import_list_export_delete_round_trip():
    client = TestClient(create_app())
    r = client.post("/api/themes/import", json=GOOD)
    assert r.status_code == 200 and r.json()["id"] == "solar"
    listed = client.get("/api/themes").json()
    assert "solar" in [t["id"] for t in listed["themes"]]
    assert client.put("/api/themes/active", json={"id": "solar"}).status_code == 200
    assert client.get("/api/themes").json()["active"] == "solar"
    ex = client.get("/api/themes/solar/export")
    assert ex.status_code == 200 and "attachment" in ex.headers["content-disposition"]
    assert ex.json()["name"] == "Solar"
    assert client.delete("/api/themes/midnight").status_code == 400
    assert client.delete("/api/themes/solar").status_code == 200
    after = client.get("/api/themes").json()
    assert after["active"] == "midnight"
    assert "solar" not in [t["id"] for t in after["themes"]]


def test_import_replaces_same_id_and_bad_json_is_400():
    client = TestClient(create_app())
    client.post("/api/themes/import", json=GOOD)
    client.post("/api/themes/import", json={**GOOD, "name": "Solar 2"})
    names = [t["name"] for t in client.get("/api/themes").json()["themes"] if t["id"] == "solar"]
    assert names == ["Solar 2"]
    assert client.post("/api/themes/import", json={"id": "x"}).status_code == 400
    assert client.put("/api/themes/active", json={"id": "nope"}).status_code == 400
    client.delete("/api/themes/solar")
