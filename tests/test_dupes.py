import json

import pytest

from app import ai, db, dupes
from app.main import create_app


def _dump(did, concepts=(), people=()):
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, title, status, concepts, people) VALUES (?,?,?,?,?,'ready',?,?)",
               (did, db.now_iso(), "freeform", "text", "t " + did, json.dumps(list(concepts)), json.dumps(list(people))))


@pytest.fixture
def data(monkeypatch):
    create_app()
    monkeypatch.setattr(ai, "available", lambda: False)
    _dump("d1", concepts=["excercise plan", "internships"], people=["Bela", "Liz", "Sam", "Samuel"])   # Sam + Samuel together
    _dump("d2", concepts=["exercise plan", "internship applications"], people=["Bella", "Elizabeth", "Marlon"])
    _dump("d3", people=["Marlon Funaki"])
    yield
    for d in ("d1", "d2", "d3"):
        db.execute("DELETE FROM dumps WHERE id=?", (d,))
    db.execute("DELETE FROM settings WHERE key=?", (dupes.DISMISS_KEY,))


def _sets(r):
    return [{m["name"].lower() for m in g["members"]} for g in r["groups"]]


def test_pair_signals():
    s = dupes._score_pair
    assert s("person", "Liz", "Elizabeth")[1] == "nickname"
    assert s("person", "J. Smith", "John Smith")
    assert s("concept", "gym routine", "routine gym")
    assert s("concept", "ML", "machine learning")[1] == "abbreviation"
    assert s("person", "Sam", "Dan") is None
    assert s("concept", "cooking", "sleep") is None


def test_people_scan(data):
    found = _sets(dupes.scan("person"))
    assert {"bela", "bella"} in found
    assert {"liz", "elizabeth"} in found
    assert {"marlon", "marlon funaki"} in found


def test_names_in_the_same_dump_are_not_merged(data):
    # "Sam" and "Samuel" are both in d1: probably two people, so the scan leaves them alone
    assert not any({"sam", "samuel"} <= g for g in _sets(dupes.scan("person")))


def test_concept_scan_and_dismiss(data):
    r = dupes.scan("concept")
    assert {"excercise plan", "exercise plan"} in _sets(r) or {"exercise plan", "excercise plan"} in _sets(r)
    assert {"internships", "internship applications"} in _sets(r)
    dupes.dismiss("concept", ["internships", "internship applications"])
    assert {"internships", "internship applications"} not in _sets(dupes.scan("concept"))


def test_ai_review_filters_candidates(data, monkeypatch):
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "embed", lambda t: None)
    seen = {}

    def fake(system, user, **kw):
        pay = json.loads(user)
        seen["n"] = len(pay)
        return {"verdicts": [{"id": p["id"], "same": False, "reason": "different"} for p in pay]}

    monkeypatch.setattr(ai, "chat_json", fake)
    r = dupes.scan("concept")
    assert seen["n"] >= 1 and r["groups"] == [] and r["ai_reviewed"]


def test_without_ai_a_note_explains(data):
    assert any("No AI model" in n for n in dupes.scan("concept")["notes"])
