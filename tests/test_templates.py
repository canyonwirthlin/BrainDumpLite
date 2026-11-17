"""Dump templates: GET/PUT validation, persistence in one settings key, export round trip."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import dataio, db, routes_templates as rt
from app.main import create_app

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def client():
    c = TestClient(create_app())
    db.execute("DELETE FROM settings WHERE key=?", (rt.KEY,))
    yield c
    db.execute("DELETE FROM settings WHERE key=?", (rt.KEY,))


def _t(i, label=None, text="Line one\n\nLine two\n"):
    return {"id": f"u_{i}", "label": label or f"Tpl {i}", "text": text}


def test_empty_by_default(client):
    d = client.get("/api/templates").json()
    assert d == {"templates": [], "overrides": {}, "deleted": [], "order": [], "pinned": None}


def test_round_trip_and_persisted_in_one_settings_key(client):
    doc = {"templates": [_t(1), _t(2)], "overrides": {"morning": {"label": "AM", "text": "Hi\n\nthere"}},
           "deleted": ["worry"], "order": ["u_2", "morning", "u_1"], "pinned": ["u_1", "morning"]}
    r = client.put("/api/templates", json=doc)
    assert r.status_code == 200 and r.json() == doc
    assert client.get("/api/templates").json() == doc
    assert db.get_setting(rt.KEY) == doc
    rows = db.query("SELECT key FROM settings WHERE key LIKE '%templ%'")
    assert [r["key"] for r in rows] == [rt.KEY]


def test_trims_and_normalises(client):
    r = client.put("/api/templates", json={"templates": [{"id": "u_a", "label": "  Hello  ", "text": "a\r\nb"}],
                                           "order": ["u_a", "u_a"], "pinned": ["u_a", "u_a"]})
    d = r.json()
    assert d["templates"][0] == {"id": "u_a", "label": "Hello", "text": "a\nb"}
    assert d["order"] == ["u_a"] and d["pinned"] == ["u_a"]


@pytest.mark.parametrize("doc,frag", [
    ({"templates": [{"id": "u_1", "label": "", "text": "x"}]}, "name"),
    ({"templates": [{"id": "u_1", "label": "   ", "text": "x"}]}, "name"),
    ({"templates": [{"id": "u_1", "label": "x" * 31, "text": "x"}]}, "30"),
    ({"templates": [{"id": "u_1", "label": "ok", "text": "  \n "}]}, "empty"),
    ({"templates": [{"id": "u_1", "label": "ok", "text": "x" * 5001}]}, "5000"),
    ({"templates": [{"id": "bad id!", "label": "ok", "text": "x"}]}, "id"),
    ({"templates": [{"label": "ok", "text": "x"}]}, "id"),
    ({"templates": [_t(1), _t(1)]}, "share the id"),
    ({"templates": [_t(i) for i in range(rt.MAX_TEMPLATES + 1)]}, "too many"),
    ({"templates": "nope"}, "list"),
    ({"overrides": {"morning": {"label": "", "text": "x"}}}, "name"),
    ({"overrides": {"u_1": {"label": "a", "text": "b"}}, "templates": [_t(1)]}, "both"),
    ({"overrides": {"morning": {"label": "a", "text": "b"}}, "deleted": ["morning"]}, "deleted"),
    ({"deleted": "morning"}, "list"),
    ({"order": [1]}, "id"),
    ({"pinned": {"a": 1}}, "list"),
])
def test_rejects_invalid(client, doc, frag):
    r = client.put("/api/templates", json=doc)
    assert r.status_code == 422, doc
    assert frag in r.json()["detail"]
    assert client.get("/api/templates").json()["templates"] == []     # nothing was stored


def test_boundaries_accepted(client):
    doc = {"templates": [{"id": "u_1", "label": "x" * 30, "text": "y" * 5000}]}
    assert client.put("/api/templates", json=doc).status_code == 200
    many = {"templates": [_t(i) for i in range(rt.MAX_TEMPLATES)]}
    assert client.put("/api/templates", json=many).status_code == 200
    assert len(client.get("/api/templates").json()["templates"]) == rt.MAX_TEMPLATES


def test_put_replaces_whole_set(client):
    client.put("/api/templates", json={"templates": [_t(1)], "pinned": ["u_1"]})
    client.put("/api/templates", json={"templates": [_t(2)]})
    d = client.get("/api/templates").json()
    assert [t["id"] for t in d["templates"]] == ["u_2"] and d["pinned"] is None


def test_corrupt_stored_value_reads_as_defaults(client):
    db.set_setting(rt.KEY, {"templates": "garbage"})
    assert client.get("/api/templates").json()["templates"] == []
    db.set_setting(rt.KEY, ["not", "a", "dict"])
    assert client.get("/api/templates").json()["overrides"] == {}


def test_frontend_wiring():
    """No browser in the suite: check the files and hooks the UI depends on exist."""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    assert (root / "static/js/templates-ui.js").exists() and (root / "static/css/templates.css").exists()
    assert "css/templates.css" in (root / "static/index.html").read_text(encoding="utf-8")
    assert "templates-ui.js" in (root / "static/js/views/capture.js").read_text(encoding="utf-8")
    st = (root / "static/js/views/settings.js").read_text(encoding="utf-8")
    assert '["templates", "Templates"]' in st and "mountTemplateManager" in st
    assert 'api.put("/templates"' in (root / "static/js/templates.js").read_text(encoding="utf-8")


def test_ids_with_a_trailing_newline_are_rejected(client):
    """Python's `$` matches before a final newline, so a regex id check let "abc\\n" through."""
    for doc in ({"templates": [_t(1) | {"id": "u_1\n"}]}, {"deleted": ["morning\n"]}, {"order": ["x\n"]}, {"overrides": {"morning\n": {"label": "a", "text": "b"}}}):
        assert client.put("/api/templates", json=doc).status_code == 422, doc


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_a_failed_first_load_never_overwrites_the_saved_templates():
    """loadDoc() used to fall back to an EMPTY document when the server could not be reached; the next pin / edit then
    PUT that empty document over the user's real templates."""
    script = """
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const calls = [];
let down = true;
globalThis.fetch = async (url, opts = {}) => {
  calls.push((opts.method || "GET") + " " + url);
  if (down) throw new TypeError("offline");
  return { ok: true, json: async () => ({ templates: [{ id: "u_1", label: "Mine", text: "x" }], overrides: {}, deleted: [], order: [], pinned: null }) };
};
const T = await import(%s);
await T.loadDoc();
let refused = "";
try { await T.saveDoc(T.withPin(T.getDoc(), "morning", false)); } catch (e) { refused = e.message; }
const putsWhileDown = calls.filter((c) => c.startsWith("PUT")).length;
down = false;
await T.loadDoc();                                   // a later visit retries the load
console.log(JSON.stringify({ refused, putsWhileDown, mine: T.resolveTemplates().some((t) => t.id === "u_1") }));
""" % json.dumps((ROOT / "static/js/templates.js").as_uri())
    out = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])
    assert r["putsWhileDown"] == 0 and r["refused"], "saving before the templates ever loaded must be refused, not sent"
    assert r["mine"], "the next load must still fetch the real document"


def test_included_in_json_export(client):
    doc = {"templates": [_t(1)], "overrides": {}, "deleted": ["worry"], "order": ["u_1"], "pinned": ["u_1"]}
    client.put("/api/templates", json=doc)
    out = dataio.export_data()
    assert out["settings"][rt.KEY] == doc
    # import into a vault that has none: the key arrives (an existing key is never overwritten, like every setting)
    db.execute("DELETE FROM settings WHERE key=?", (rt.KEY,))
    dataio.import_data(out)
    assert client.get("/api/templates").json() == doc
