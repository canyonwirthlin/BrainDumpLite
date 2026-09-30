"""0.20: smarter search, browse-by-type, hand-written tasks, task/goal split, journal prompts, people."""
import json
import random

import pytest
from fastapi.testclient import TestClient

from app import db, graph, item_types, pipeline, prompts
from app import search as search_mod
from app.main import create_app


@pytest.fixture(autouse=True)
def _vault():
    db.init_db()
    item_types.seed()


def _dump(did, title, body, people=(), concepts=(), created="2026-09-10T10:00:00+00:00", status="ready"):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, status, people, concepts) "
               "VALUES (?,?,?,?,?,?,?,?,?,?)",
               (did, created, "freeform", body, body, title, "", status, json.dumps(list(people)), json.dumps(list(concepts))))
    db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (did, f"{title}\n{body}"))


def _item(iid, did, kind, content, created="2026-09-10T10:00:00+00:00", done=0, status="approved"):
    db.execute("INSERT INTO items (id, dump_id, kind, content, status, done, created_at) VALUES (?,?,?,?,?,?,?)",
               (iid, did, kind, content, status, done, created))
    db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)", (iid, did, content))


def _clean():
    for t in ("items", "dumps_fts", "items_fts", "dumps"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM settings WHERE key='journal_prompts_seen'")


# ── search ───────────────────────────────────────────────────────────────────

def test_search_stems_prefixes_and_fixes_typos():
    _clean()
    _dump("s1", "Gym plans", "I was running every morning and lifting weights", ["Bella"], ["fitness"])
    _dump("s2", "Dentist", "need to see the dentist about a filling")
    assert [r["id"] for r in search_mod.search("run")["results"]] == ["s1"]          # stemming
    assert [r["id"] for r in search_mod.search("dent")["results"]] == ["s2"]         # prefix
    out = search_mod.search("dentst")                                                # typo
    assert [r["id"] for r in out["results"]] == ["s2"] and out["corrected"] == {"dentst": "dentist"}


def test_search_all_words_beat_some_words():
    _clean()
    _dump("a1", "Both", "the garden needs water and the roof needs repair")
    _dump("a2", "One", "the garden is lovely this year")
    ids = [r["id"] for r in search_mod.search("garden roof")["results"]]
    assert ids[0] == "a1" and "a2" in ids


def test_search_finds_people_and_returns_the_name():
    _clean()
    _dump("p1", "Lunch", "we talked for hours", ["Bella"])
    _dump("p2", "Call", "she called me back", ["Bella", "Sam"])
    _dump("p3", "Other", "nothing here", ["Sam"])
    out = search_mod.search("bella")
    assert {r["id"] for r in out["results"]} == {"p1", "p2"}
    assert out["entities"][0] == {"type": "person", "name": "Bella", "count": 2}
    assert all(r["via"] == "name" for r in out["results"])


def test_search_matches_items_and_says_which():
    _clean()
    _dump("i1", "Errands", "a busy day")
    _item("ii1", "i1", "task", "renew the passport")
    out = search_mod.search("passport")["results"]
    assert out[0]["id"] == "i1" and out[0]["matched_items"][0]["content"] == "renew the passport"


def test_search_empty_and_stopword_only_queries():
    _clean()
    assert search_mod.search("   ")["results"] == []
    assert search_mod.search("the")["results"] == []     # only a stop word, nothing to find


# ── browse ───────────────────────────────────────────────────────────────────

def test_browse_counts_types_and_lists_items():
    _clean()
    _dump("b1", "One", "x", ["Bella"], ["sleep"])
    _dump("b2", "Two", "y", ["Bella", "Sam"], ["sleep", "work"])
    _item("bi1", "b1", "idea", "start a podcast")
    _item("bi2", "b2", "idea", "learn to sail", status="rejected")
    counts = {t["id"]: t["count"] for t in graph.browse()}
    assert counts["person"] == 2 and counts["concept"] == 2 and counts["idea"] == 1
    c = TestClient(create_app())
    people = {p["name"]: p["count"] for p in c.get("/api/people").json()}
    assert people == {"Bella": 2, "Sam": 1}
    assert [i["content"] for i in c.get("/api/browse/items/idea").json()] == ["start a podcast"]
    assert c.get("/api/browse/items/idea").json()[0]["dump_title"] == "One"


# ── hand-written tasks ───────────────────────────────────────────────────────

def test_create_edit_and_list_hand_tasks():
    _clean()
    c = TestClient(create_app())
    t = c.post("/api/tasks", json={"content": "  Pay rent ", "due_date": "2026-10-01", "priority": 4}).json()
    assert t["content"] == "Pay rent" and t["status"] == "approved" and t["manual"] is True
    assert c.post("/api/tasks", json={"content": " "}).status_code == 400
    assert c.post("/api/tasks", json={"content": "x", "kind": "note"}).status_code == 400
    assert c.post("/api/tasks", json={"content": "x", "due_date": "soon"}).status_code == 400
    c.patch(f"/api/items/{t['id']}", json={"content": "Pay rent + parking", "priority": 5, "est_minutes": 15})
    got = [x for x in c.get("/api/tasks").json() if x["id"] == t["id"]][0]
    assert got["content"] == "Pay rent + parking" and got["priority"] == 5 and got["est_minutes"] == 15 and got["manual"]
    c.patch(f"/api/items/{t['id']}", json={"priority": 0})
    assert [x for x in c.get("/api/tasks").json() if x["id"] == t["id"]][0]["priority"] is None
    # the hidden holder never leaks into dumps, stats or search
    assert all(d["id"] != db.MANUAL_DUMP_ID for d in c.get("/api/dumps").json())
    assert search_mod.search("parking")["results"] == []
    assert c.get("/api/stats").json()["total_dumps"] == 0


def test_tasks_endpoint_carries_goals_and_ideas_for_the_ui_to_separate():
    _clean()
    _dump("t1", "Gym", "x")
    _item("t1a", "t1", "task", "book a trainer")
    _item("t1b", "t1", "goal", "get stronger")
    _item("t1c", "t1", "note", "gym opens at 6")
    kinds = {x["content"]: x["kind"] for x in TestClient(create_app()).get("/api/tasks").json()}
    assert kinds == {"book a trainer": "task", "get stronger": "goal"}


# ── task vs goal ─────────────────────────────────────────────────────────────

def test_ongoing_aims_are_filed_as_goals_not_tasks():
    data = {"items": [
        {"type": "task", "content": "Get stronger at the gym"},
        {"type": "task", "content": "Be more patient with my kids"},
        {"type": "task", "content": "Call the dentist"},
        {"type": "task", "content": "Get groceries"},
        {"type": "task", "content": "Get a better mattress"},
        {"type": "task", "content": "Lose 10 pounds by Friday", "due_date_iso": "2026-10-03"},
        {"type": "idea", "content": "Get in shape"},
    ]}
    kinds = {i["content"]: i["kind"] for i in pipeline._parse_items(data)}
    assert kinds["Get stronger at the gym"] == "goal" and kinds["Be more patient with my kids"] == "goal"
    assert kinds["Call the dentist"] == kinds["Get groceries"] == kinds["Get a better mattress"] == "task"
    assert kinds["Lose 10 pounds by Friday"] == "task"        # a dated commitment stays a task
    assert kinds["Get in shape"] == "idea"                    # the model's own non-task call is respected


def test_builtin_hints_upgrade_only_when_untouched():
    item_types.seed()
    db.execute("UPDATE item_types SET hint=? WHERE id='task'", (item_types._OLD_HINTS["task"][0],))
    db.execute("UPDATE item_types SET hint='my own rule' WHERE id='goal'")
    item_types.seed()
    assert "checked off" in item_types.get("task")["hint"]
    assert item_types.get("goal")["hint"] == "my own rule"
    db.execute("UPDATE item_types SET hint=? WHERE id='goal'", (item_types.BUILTIN_SEED[1][4],))


# ── people ───────────────────────────────────────────────────────────────────

def test_people_you_already_know_are_added_when_the_model_misses_them():
    got = pipeline._add_mentioned_people("Talked to bella today, and Sam. Also Bellamy.", ["Sam"], ["Bella", "Sam", "Bellamy2"])
    assert got == ["Sam", "Bella"]


# ── journal prompts ──────────────────────────────────────────────────────────

def test_prompts_do_not_repeat_until_the_bank_is_used():
    _clean()
    rng = random.Random(1)
    seen = [prompts.next_prompt(rng)["id"] for _ in range(len(prompts.BANK))]
    assert len(set(seen)) == len(seen)
    assert prompts.next_prompt(rng)["text"]           # the next round starts again without error


def test_prompts_can_be_built_from_your_own_vault():
    _clean()
    _dump("j1", "Job stuff", "x", ["Bella"], ["career change"])
    _dump("j2", "More job", "x", ["Bella"], ["career change"])
    _dump("j3", "Again", "x", [], ["career change"])
    _item("ji", "j1", "task", "update the resume", created="2020-01-01T00:00:00+00:00", done=0)
    texts = " ".join(p["text"] for p in prompts.personal())
    assert "update the resume" in texts and "career change" in texts and "Bella" in texts


def test_journal_prompt_setting_and_endpoint():
    _clean()
    c = TestClient(create_app())
    r = c.get("/api/journal-prompt").json()
    assert r["enabled"] and r["text"] and c.get("/api/journal-prompt").json()["text"] != r["text"]
    assert c.get("/api/settings").json()["journal_prompt_enabled"] is True
    c.put("/api/settings", json={"journal_prompt_enabled": False})
    assert c.get("/api/journal-prompt").json() == {"enabled": False}
    c.put("/api/settings", json={"journal_prompt_enabled": True})


def test_old_plain_fts_indexes_are_rebuilt_with_stemming():
    _clean()
    _dump("m1", "Running", "I went running", status="ready")
    db.execute("DROP TABLE dumps_fts")
    db.execute("CREATE VIRTUAL TABLE dumps_fts USING fts5(id UNINDEXED, body)")      # the pre-0.20 shape
    db.init_db()                                                                     # migration runs here
    sql = db.query_one("SELECT sql FROM sqlite_master WHERE name='dumps_fts'")["sql"]
    assert "porter" in sql
    assert [r["id"] for r in search_mod.search("run")["results"]] == ["m1"]           # re-indexed from the dumps table


def test_auto_made_dump_links_are_dropped_once_but_hand_links_stay():
    _clean()
    _dump("l1", "A", "x"); _dump("l2", "B", "x"); _dump("l3", "C", "x")
    db.execute("DELETE FROM links")
    db.execute("INSERT INTO links VALUES ('l1','l2',0.5)")      # what the old pipeline wrote
    db.execute("INSERT INTO links VALUES ('l1','l3',1.0)")      # what "add link" writes
    db.execute("DELETE FROM settings WHERE key='auto_links_removed'")
    db.init_db()
    assert [(r["dump_id"], r["related_id"]) for r in db.query("SELECT * FROM links")] == [("l1", "l3")]
    db.init_db()                                                 # runs only once
    assert db.query_one("SELECT COUNT(*) AS n FROM links")["n"] == 1


def test_static_files_are_revalidated_so_updates_show_up():
    r = TestClient(create_app()).get("/js/main.js")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"


# ── merging nodes ────────────────────────────────────────────────────────────

def _names(did, col):
    return json.loads(db.query_one(f"SELECT {col} FROM dumps WHERE id=?", (did,))[col])


def test_merge_concepts_rewrites_dumps_and_remembers_aliases():
    _clean()
    db.execute("DELETE FROM settings WHERE key='name_aliases'")
    _dump("m1", "A", "x", concepts=["internships", "gym"])
    _dump("m2", "B", "x", concepts=["internship applications", "internships"])
    _dump("m3", "C", "x", concepts=["career"])
    c = TestClient(create_app())
    r = c.post("/api/merge", json={"kind": "concept", "sources": ["internships", "internship applications"], "target": "Internships"}).json()
    assert r == {"merged_dumps": 2, "name": "Internships"}
    assert _names("m1", "concepts") == ["Internships", "gym"]
    assert _names("m2", "concepts") == ["Internships"]                     # both spellings collapse to one
    assert _names("m3", "concepts") == ["career"]
    assert {c_["name"]: c_["count"] for c_ in c.get("/api/concepts").json()}["Internships"] == 2
    # a later dump that says the old phrase is folded in too
    assert graph.apply_aliases("concept", ["Internship Applications", "sleep"]) == ["Internships", "sleep"]


def test_merge_people_and_alias_chains():
    _clean()
    db.execute("DELETE FROM settings WHERE key='name_aliases'")
    _dump("p1", "A", "x", people=["Bela"]); _dump("p2", "B", "x", people=["Bella", "Bela"])
    graph.merge_names("person", ["Bela"], "Bella")
    assert _names("p1", "people") == ["Bella"] and _names("p2", "people") == ["Bella"]
    graph.merge_names("person", ["Bella"], "Isabella")                     # merge again: old aliases follow the new target
    assert graph.apply_aliases("person", ["Bela"]) == ["Isabella"]
    assert _names("p2", "people") == ["Isabella"]


def test_merge_rejects_nonsense_and_suggests_duplicates():
    _clean()
    _dump("s1", "A", "x", concepts=["internships", "home lab"]); _dump("s2", "B", "x", concepts=["internship applications", "garden"])
    c = TestClient(create_app())
    assert c.post("/api/merge", json={"kind": "thing", "sources": ["a"], "target": "b"}).status_code == 400
    assert c.post("/api/merge", json={"kind": "concept", "sources": [], "target": "b"}).status_code == 400
    assert c.post("/api/merge", json={"kind": "concept", "sources": ["a"], "target": "  "}).status_code == 400
    groups = c.get("/api/merge/suggestions?kind=concept").json()
    assert any({e["name"] for e in g} == {"internships", "internship applications"} for g in groups)
