"""'will' the verb is not 'Will' the person: context rules for names that are also everyday words."""
import json

import pytest

from app import ai, db, name_context, pipeline
from app.main import create_app
from app.name_context import filter_people, is_ambiguous, mentioned, mentions


# (name, text) pairs that must NOT count as a person ---------------------------------------------------------
NOT_PERSON = [
    # Will as a modal / noun
    ("Will", "I will do this"), ("Will", "it will work"), ("Will", "we will see, they will go"),
    ("Will", "Will you help me?"), ("Will", "Will it rain tomorrow"), ("Will", "Will not be late"),
    ("Will", "Will be there at 5"), ("Will", "I Will go"), ("Will", "That Will be great"),
    ("Will", "who will win"), ("Will", "the Last Will and Testament"), ("Will", "Will 2 come?"),
    ("Will", "Will"), ("Will", "WILL YOU HELP"), ("Will", "Will-be tenant"),
    # Mark
    ("Mark", "please mark the date"), ("Mark", "Please Mark the date"), ("Mark", "Mark the date on the calendar"),
    ("Mark", "I mark it done"), ("Mark", "to Mark the occasion"), ("Mark", "the Mark-up"),
    # Rose / Bill / Grace / Hope / Art / Max / Don / Rob / Page / Miles / Sue / Pat
    ("Rose", "the sun rose"), ("Rose", "the sun Rose over the hills"), ("Rose", "Rose to the occasion"),
    ("Rose", "the Rose garden"),
    ("Bill", "the bill is due"), ("Bill", "Bill me later"), ("Bill", "I paid the Bill"),
    ("Grace", "say grace before dinner"), ("Hope", "I hope so"), ("Hope", "Hope so."),
    ("Art", "the Art of war"), ("Art", "Art, music and drama"), ("Max", "Max out the card"),
    ("Don", "Don't do it"), ("Rob", "Rob the bank"), ("Page", "Page 5"), ("Page", "turn the page"),
    ("Miles", "5 Miles"), ("Sue", "Sue the company"), ("Pat", "Pat the dog"), ("Frank", "to be Frank"),
    ("Jack", "Jack up the price"), ("Bob", "Bob up and down"), ("Drew", "she Drew a picture"),
    # months / seasons
    ("May", "I may go"), ("May", "May I ask a question?"), ("May", "we met in May."), ("May", "May 5th"),
    ("June", "June 5"), ("June", "by June"), ("Summer", "in Summer"), ("Summer", "last Summer"),
]

# ... and these MUST count -----------------------------------------------------------------------------------
PERSON = [
    ("Will", "I talked with Will today"), ("Will", "Told Will about it"), ("Will", "ask Will"),
    ("Will", "Will's idea"), ("Will", "Will said he would call"), ("Will", "Will and I went out"),
    ("Will", "Thanks, Will."), ("Will", "Hey, Will, can you help?"), ("Will", "Will texted me"),
    ("Will", "Will is coming"), ("Will", "Will was late"), ("Will", "Will wants pizza"),
    ("Will", "Will Smith came by"), ("Will", "Sam and Will went home"), ("Will", "I think Will is right"),
    ("Will", "Will, can you help"), ("Will", "Dr. Will Smith"), ("Will", "Will asked me"),
    ("Will", "I said I will, and Will said he will too"), ("Will", "See [[Will]]"),
    ("Mark", "Mark said hi"), ("Mark", "with Mark"), ("Mark", "call Mark"), ("Mark", "Mark's car"),
    ("Mark", "Mark Twain"), ("Rose", "Rose said no"), ("Rose", "dinner with Rose"),
    ("Bill", "Bill said hi"), ("Bill", "call Bill tomorrow"), ("Grace", "Grace called"), ("Grace", "with Grace"),
    ("Hope", "Hope is a good friend"), ("Art", "Art said hi"), ("Don", "Don said no"), ("Rob", "Rob came by"),
    ("Drew", "Drew said"), ("Page", "Page said hi"), ("Max", "with Max"), ("Miles", "Miles said so"),
    ("Frank", "Frank said so"), ("Jack", "Jack wanted pizza"), ("Sue", "Sue said hello"), ("Pat", "Pat said"),
    ("Bob", "Bob and Sam left"), ("Faith", "Faith and Hope"), ("Summer", "with Summer"),
    ("Summer", "Summer called"), ("June", "June texted"), ("May", "Told May about it"), ("May", "May said hi"),
]


@pytest.mark.parametrize("name,text", NOT_PERSON)
def test_ordinary_word_is_not_a_person(name, text):
    assert not mentioned(name, text), (name, text)


@pytest.mark.parametrize("name,text", PERSON)
def test_named_person_is_recognised(name, text):
    assert mentioned(name, text), (name, text)


def test_will_in_a_mixed_sentence_only_counts_the_person():
    text = "Mom said Will is coming Friday and I will bring the cake"
    assert mentions("Will", text) == [(9, 13)]
    assert mentions("Will", "I will bring cake, we will see") == []


@pytest.mark.parametrize("name,text", [
    ("Sam", "with sam"), ("Sam", "Sam"), ("Sam", "I like sam."), ("Mom", "call mom"), ("Jackson", "jackson said hi"),
    ("Dr. Kim", "dr. kim said"), ("Alex", "alex"), ("William", "william will go"),
])
def test_unambiguous_names_keep_old_behaviour(name, text):
    assert not is_ambiguous(name)
    assert mentioned(name, text)


def test_unambiguous_name_still_needs_whole_word():
    assert not mentioned("Sam", "the samurai")
    assert not mentioned("Will", "willing to help")
    assert not mentioned("Mark", "marking time")


def test_ambiguous_set_and_extensibility():
    for n in ("will", "mark", "bill", "grace", "hope", "rose", "art", "frank", "rich", "max", "pat", "may", "june",
              "dawn", "faith", "joy", "summer", "ray", "sue", "jack", "bob", "don", "rob", "wade", "drew", "bear",
              "page", "case", "miles"):
        assert is_ambiguous(n) and is_ambiguous(n.upper())
    assert not is_ambiguous("Sam") and not is_ambiguous("Will Smith")
    try:
        name_context.AMBIGUOUS = name_context.AMBIGUOUS | {"hunter"}
        assert is_ambiguous("Hunter") and not mentioned("Hunter", "I saw a hunter")
        assert mentioned("Hunter", "with Hunter")
    finally:
        name_context.AMBIGUOUS = name_context.AMBIGUOUS - {"hunter"}


def test_wikilink_always_counts():
    assert mentioned("Will", "The [[Will]] is on the table. I will sign.")
    assert mentioned("Rose", "[[Rose]]")
    assert mentioned("Will", "[[will]] then")      # the link marks it; case of the link text is the user's choice


def test_filter_people_drops_only_ambiguous_words():
    names = ["Will", "Sam", "Mark", "Rose"]
    text = "I will call Sam and mark the date; the sun rose. Mark said hi."
    assert filter_people(names, text) == ["Sam", "Mark"]
    # wikilinked names are exempt even when the surrounding words look like a verb
    assert filter_people(["Will"], "I will go", exempt=["will"]) == ["Will"]
    assert filter_people(["Will"], "I will go") == []
    assert filter_people([], "anything") == []


def test_curly_apostrophes():
    assert mentioned("Will", "Will’s idea")
    assert not mentioned("Don", "Don’t do it")


# ── pipeline integration ─────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def ai_people(monkeypatch):
    """A fake model whose people list is set per test via box['people']."""
    create_app()
    box = {"people": []}
    monkeypatch.setattr(ai, "available", lambda: True)
    monkeypatch.setattr(ai, "config", lambda: {"provider": "openai", "api_key": "x", "base_url": "", "model": "m", "embed_model": ""})
    monkeypatch.setattr(ai, "chat", lambda system, user, **kw: user)    # cleanup keeps the text
    monkeypatch.setattr(ai, "chat_json", lambda system, user, **kw: {
        "title": "t", "summary": ["• s"], "items": [], "tone": None, "people": list(box["people"]), "concepts": []})
    monkeypatch.setattr(ai, "embed", lambda text: None)
    yield box
    for t in ("items", "items_fts", "dumps_fts", "runs"):
        db.execute(f"DELETE FROM {t}")
    db.execute("DELETE FROM dumps")


def _dump(text, people=None):
    did = db.new_id()
    db.execute("INSERT INTO dumps (id, created_at, mode, raw_text, status, people) VALUES (?,?,?,?,'ready', ?)",
               (did, db.now_iso(), "freeform", text, json.dumps(people) if people is not None else None))
    return did


def _people(did):
    return json.loads(db.query_one("SELECT people FROM dumps WHERE id=?", (did,))["people"])


def test_add_mentioned_people_does_not_re_add_known_will_for_the_verb():
    known = ["Will", "Sam"]
    assert pipeline._add_mentioned_people("I will do this and it will work", [], known) == []
    assert pipeline._add_mentioned_people("Will you help me?", [], known) == []
    assert pipeline._add_mentioned_people("I will ask Will tomorrow", [], known) == ["Will"]
    assert pipeline._add_mentioned_people("Will said hi to sam", [], known) == ["Will", "Sam"]
    assert pipeline._add_mentioned_people("see [[Will]] later, I will go", [], known) == ["Will"]
    assert pipeline._add_mentioned_people("I will tell sam", [], known) == ["Sam"]


def test_pipeline_known_will_not_added_for_verb(ai_people):
    _dump("Will came over yesterday", ["Will"])           # makes Will a known person
    did = _dump("I will do this and it will work out")
    pipeline.run_pipeline(did)
    assert _people(did) == []


def test_pipeline_drops_will_the_model_invented(ai_people):
    ai_people["people"] = ["Will", "Sam"]
    did = _dump("I will call Sam tomorrow and it will be fine")
    pipeline.run_pipeline(did)
    assert _people(did) == ["Sam"]


def test_pipeline_keeps_will_when_text_names_him(ai_people):
    ai_people["people"] = ["Will"]
    did = _dump("I will call Will tomorrow about the plan")
    pipeline.run_pipeline(did)
    assert _people(did) == ["Will"]


def test_pipeline_wikilink_will_wins_even_when_model_misses_it(ai_people):
    _dump("Will came over yesterday", ["Will"])
    did = _dump("I will bring [[Will]] the cake")
    pipeline.run_pipeline(did)
    assert _people(did) == ["Will"]


def test_pipeline_wikilink_exempts_model_will(ai_people):
    ai_people["people"] = ["Will"]
    did = _dump("[[Will]] and also I will go")
    pipeline.run_pipeline(did)
    assert "Will" in _people(did)


def test_pipeline_unambiguous_people_untouched(ai_people):
    ai_people["people"] = ["Sam", "Jackson"]
    did = _dump("lunch with sam and jackson, I will pay")
    pipeline.run_pipeline(did)
    assert _people(did) == ["Sam", "Jackson"]


def test_classify_prompt_warns_about_name_words():
    prompt = pipeline._classify_system()
    assert "will" in prompt and "NOT people" in prompt
