"""Private dumps: one unique word per exclusion point must never surface for a private dump."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import ai, ask, db, dupes, followup, graph, lock, obsidian
from app.main import create_app
from app.routes_dumps import duplicate_hints

WORD = "xylophonezzq"       # appears only in the private dump (text, title, person, concept, task)
PUB = "marmotpublic"


def _dump(title, body, private=False, people="[]", concepts="[]"):
    did = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, is_private, people, concepts) "
               "VALUES (?,?,?,?,?,?,?,'ready',?,?,?)",
               (did, db.now_iso(), "freeform", body, body, title, body[:40], 1 if private else 0, people, concepts))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?, ?)", (did, f"{title} {body}"))
    iid = db.new_id()
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?,'approved',0,?)",
               (iid, did, "task", f"task about {title}", db.now_iso()))
    db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)", (iid, did, f"task about {title}"))
    return did


@pytest.fixture
def client(monkeypatch):
    c = TestClient(create_app())
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "embed", lambda text: None)
    for t in ("dumps", "dumps_fts", "items_fts"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM settings WHERE key IN (?,?)", (obsidian.KEY, "app_lock"))
    lock.boot()
    yield c
    for t in ("dumps", "dumps_fts", "items_fts"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM settings WHERE key IN (?,?)", (obsidian.KEY, "app_lock"))
    lock.boot()


@pytest.fixture
def pair(client):
    pub = _dump(f"{PUB} day", f"{PUB} walked to the park and saw a marmot wearing a tiny hat today")
    priv = _dump(f"{WORD} secret", f"{WORD} confession about the marmot wearing a tiny hat today",
                 private=True, people=f'["{WORD}person"]', concepts=f'["{WORD}concept"]')
    return pub, priv


def test_search_never_returns_private(client, pair):
    pub, priv = pair
    for q in (WORD, WORD[:6], WORD + "person", WORD + "concept", "xylophonezzp"):   # exact, prefix, names, typo
        r = client.get("/api/search", params={"q": q}).json()
        blob = json.dumps({k: v for k, v in r.items() if k != "query"})   # the query echo is the caller's own text
        assert WORD not in blob and priv not in blob
    r = client.get("/api/search", params={"q": "marmot"}).json()
    assert [x["id"] for x in r["results"]] == [pub]
    assert WORD not in json.dumps(r)


def test_task_search_and_lists_skip_private_items(client, pair):
    pub, priv = pair
    assert client.get("/api/search/tasks", params={"q": WORD}).json()["ids"] == []
    assert WORD not in json.dumps(client.get("/api/tasks").json())
    assert WORD not in json.dumps(client.get("/api/browse/items/task").json())
    assert WORD not in json.dumps(client.get("/api/people").json() + client.get("/api/concepts").json())
    assert WORD not in json.dumps(client.get("/api/graph", params={"items": 1}).json())


def test_ask_sources_skip_private(client, pair, monkeypatch):
    pub, priv = pair
    seen = {}

    def fake(system, user, **kw):
        seen["user"] = user
        return "ok [1]"
    monkeypatch.setattr(ai, "chat", fake)
    r = client.post("/api/ask", json={"question": f"{WORD} marmot hat"}).json()
    assert priv not in [s["id"] for s in r["sources"]] and WORD not in json.dumps(r)
    assert WORD not in seen["user"].split("Question:")[0]   # sources block; the question echo is the user's own text
    assert ask.visible_dumps([priv]) == []


def test_markdown_exports_skip_private(client, pair):
    pub, priv = pair
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/export/markdown.zip").content))
    z2 = zipfile.ZipFile(io.BytesIO(client.get("/api/data/export.md").content))
    for zz in (z, z2):
        names = zz.namelist()
        assert len(names) == 1
        assert WORD not in " ".join(names) + zz.read(names[0]).decode()
    assert client.get(f"/api/dumps/{priv}/markdown").status_code == 404
    assert client.post(f"/api/dumps/{priv}/markdown/save", json={"path": "x.md"}).status_code in (404, 422)


def test_json_export_default_skips_private_but_param_can_include(client, pair):
    pub, priv = pair
    assert WORD not in client.get("/api/data/export.json").text
    assert WORD in client.get("/api/data/export.json", params={"include_private": 1}).text


def test_duplicate_hints_and_name_scan_skip_private(client):
    body = "the quick brown marmot jumped over the lazy dog near the river bank today"
    a = _dump("first copy", body)
    b = _dump(f"{WORD} copy", body, private=True, people=f'["{WORD}person"]')
    assert duplicate_hints() == {}
    assert b not in duplicate_hints()
    uses, titles = dupes._usage("person")
    assert WORD not in json.dumps(sorted(uses)) and b not in titles
    assert WORD not in json.dumps(client.get("/api/dumps-meta").json())


def test_obsidian_mirror_skips_then_trashes(client, pair, tmp_path):
    pub, priv = pair
    assert obsidian.select_ids() == [pub]
    obsidian.configure(str(tmp_path / "vault"))
    names = [p.name for p in (tmp_path / "vault").glob("*.md")]
    assert len(names) == 1 and not any(WORD in p.read_text(encoding="utf-8") for p in (tmp_path / "vault").glob("*.md"))
    # a mirrored dump that becomes private moves to _trash
    lock.set_passphrase("1234")
    assert client.post(f"/api/dumps/{pub}/private", json={"private": True}).status_code == 200
    assert list((tmp_path / "vault").glob("*.md")) == []
    assert len(list((tmp_path / "vault" / "_trash").glob("*.md"))) == 1


def test_followup_not_generated_for_private(client, pair, monkeypatch):
    pub, priv = pair
    monkeypatch.setattr(ai, "chat", lambda *a, **k: pytest.fail("AI must not be called for a private dump"))
    assert followup.get(priv) == {"state": "none"}


def test_digest_and_prompts_skip_private(client, pair):
    from app import digest
    assert WORD not in json.dumps(digest._task_rows(*(lambda s: (s, s))(digest.week_start(0))), default=str)
    assert WORD not in json.dumps(graph.today(), default=str)


def test_making_private_needs_a_pin(client, pair):
    pub, priv = pair
    r = client.post(f"/api/dumps/{pub}/private", json={"private": True})
    assert r.status_code == 409 and "pin_required" in r.json()["detail"]
    r = client.post("/api/dumps", json={"text": "secret thoughts", "mode": "freeform", "is_private": True})
    assert r.status_code == 409
    lock.set_passphrase("1234")
    r = client.post("/api/dumps", json={"text": "secret thoughts", "mode": "freeform", "is_private": True})
    assert r.status_code == 200
    assert db.query_one("SELECT is_private FROM dumps WHERE id=?", (r.json()["id"],))["is_private"] == 1
    assert client.post(f"/api/dumps/{pub}/private", json={"private": True}).json()["is_private"] is True
    assert client.post(f"/api/dumps/{pub}/private", json={"private": False}).json()["is_private"] is False
    assert client.get("/api/private/status").json()["pin_set"] is True


def test_phone_dumps_are_never_private(client):
    from app.phone import create_dump_from_phone
    out = create_dump_from_phone("from the phone with a thought")
    assert db.query_one("SELECT is_private FROM dumps WHERE id=?", (out["id"],))["is_private"] == 0


def test_history_flags_and_hides_when_locked(client, pair):
    pub, priv = pair
    lock.set_passphrase("1234")
    rows = {d["id"]: d for d in client.get("/api/dumps").json()}
    assert rows[priv]["is_private"] is True and rows[pub]["is_private"] is False
    lock.lock()
    r = client.get("/api/dumps")                     # PIN gate: nothing readable while locked
    assert r.status_code == 423 and WORD not in r.text
    assert lock.unlock("1234")


def test_merge_with_private_refused(client, pair):
    pub, priv = pair
    r = client.post("/api/dumps/merge", json={"ids": [pub, priv]})
    assert r.status_code == 400
