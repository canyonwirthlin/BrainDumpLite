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


# ── Theme editor: create / rename / recolor custom themes ────────────────────

EDITOR_COLORS = {k: v for k, v in GOOD["colors"].items() if k != "accentSoft"}


def _editor_theme(**over):
    return {"name": "Dusk", "scheme": "dark", "colors": dict(EDITOR_COLORS), "radius": 14, **over}


def test_editor_create_makes_id_from_name_and_derives_tint():
    client = TestClient(create_app())
    made = []
    try:
        r = client.post("/api/themes", json=_editor_theme(name="My Cool Theme!"))
        assert r.status_code == 200
        t = r.json(); made.append(t["id"])
        assert t["id"] == "my-cool-theme" and t["name"] == "My Cool Theme!"
        assert t["colors"]["accentSoft"] == "rgba(255,176,0,.16)"          # from accent #ffb000, dark
        light = client.post("/api/themes", json=_editor_theme(name="Daylight", scheme="light")).json()
        made.append(light["id"])
        assert light["colors"]["accentSoft"].endswith(",.12)")
        assert "my-cool-theme" in [x["id"] for x in client.get("/api/themes").json()["themes"]]
    finally:
        for i in made:
            client.delete(f"/api/themes/{i}")


def test_editor_ids_stay_unique_and_never_shadow_builtins():
    client = TestClient(create_app())
    made = []
    try:
        for name, want in [("Midnight", "midnight-2"), ("Midnight", "midnight-3"), ("A", "theme-a"), ("!!!", "theme")]:
            r = client.post("/api/themes", json=_editor_theme(name=name))
            assert r.status_code == 200, r.text
            made.append(r.json()["id"])
            assert r.json()["id"] == want
        assert [t["id"] for t in themes.BUILTIN][0] == "midnight"          # built-in untouched
    finally:
        for i in made:
            client.delete(f"/api/themes/{i}")


def test_editor_update_renames_and_recolors_in_place():
    client = TestClient(create_app())
    tid = client.post("/api/themes", json=_editor_theme(name="Before")).json()["id"]
    try:
        colors = {**EDITOR_COLORS, "accent": "#00ff88", "bg": "#101010"}
        r = client.put(f"/api/themes/{tid}", json=_editor_theme(name="After", colors=colors, radius=8))
        assert r.status_code == 200
        t = r.json()
        assert t["id"] == tid and t["name"] == "After" and t["radius"] == 8
        assert t["colors"]["accent"] == "#00ff88" and t["colors"]["accentSoft"] == "rgba(0,255,136,.16)"
        assert [x["name"] for x in client.get("/api/themes").json()["themes"] if x["id"] == tid] == ["After"]
    finally:
        client.delete(f"/api/themes/{tid}")


def test_editor_rejects_bad_input_and_builtin_edits():
    client = TestClient(create_app())
    assert client.put("/api/themes/midnight", json=_editor_theme()).status_code == 400   # built-ins are read-only
    assert client.put("/api/themes/ghost-theme", json=_editor_theme()).status_code == 400
    assert client.post("/api/themes", json=_editor_theme(name="   ")).status_code == 400
    assert client.post("/api/themes", json=_editor_theme(colors={**EDITOR_COLORS, "bg": "not-a-color"})).status_code == 400
    assert client.post("/api/themes", json=_editor_theme(radius=99)).status_code == 400
    assert client.post("/api/themes", json=_editor_theme(scheme="blue")).status_code == 400
    assert client.post("/api/themes", json=[1, 2]).status_code in (400, 422)
