"""Does a name in running text refer to a PERSON?

Many first names are also everyday words (Will, Mark, Bill, Grace, Hope, Rose, May...). Matching a known
person "Will" case-insensitively makes every "I will do this" look like a mention of Will, and a language
model can make the same mistake when it extracts people. This module decides, occurrence by occurrence,
whether an ambiguous name is used as a name.

* Names that are NOT in AMBIGUOUS keep the old behaviour: any whole-word, case-insensitive match counts.
* An ambiguous name only counts when the occurrence is capitalised AND the surrounding words say it is a
  person ("told Will", "with Mark", "Rose said", "Grace's", "Sam and Will went", "Thanks, Bill.").
  A sentence-initial capital alone is not enough ("Will you help me?" is a modal question).
* When unsure we say NO: a missed mention costs less than a bogus node on the Brain map.
* A [[wikilink]] always counts. Aliases/merges chosen by the user are applied by the pipeline AFTER this
  check, so a user's own mapping is never filtered here.

Pure Python, no dependencies. To make another word ambiguous, add it to AMBIGUOUS (and to TIME_NAMES if it
is a month/season word).
"""
from __future__ import annotations

import re

# Names that double as ordinary words (verbs, modals, nouns, adjectives). Lowercase. Extend freely.
AMBIGUOUS = frozenset("""
will may june april august dawn summer autumn
mark bill rob bob don jack sue ray pat max wade drew
grace hope faith joy rose art frank rich page case bear miles
""".split())

# Month / season words: "in May", "since June" are dates, so only strong person cues count for these.
TIME_NAMES = frozenset({"may", "june", "april", "august", "dawn", "summer", "autumn"})

# Names that can also be a modal verb (so "Will you...", "May I...", "it will" are never people).
MODAL_NAMES = frozenset({"will", "may"})


def is_ambiguous(name: str) -> bool:
    """True for a single-word name that is also a common word."""
    return (name or "").strip().lower() in AMBIGUOUS


# Words directly BEFORE the name -------------------------------------------------------------------------
_DETERMINERS = frozenset({"the", "a", "an", "last", "another", "any", "some", "no", "every", "each", "such",
                          "whose", "much", "more", "less", "many", "few", "own", })
# Subject pronouns / light subjects: "I will", "he rose", "we mark", "it may". A name is never right here.
_SUBJECTS = frozenset({"i", "you", "we", "they", "he", "she", "it", "who", "there", "what", "which", "one",
                       "someone", "everyone", "anyone", "nobody", "everybody", "somebody", "i'll", "you'll"})
# Extra words that make a modal reading of Will/May certain ("that will be", "this may help").
_MODAL_SUBJECTS = frozenset({"that", "this", "these", "those", "where", "how", "why", "when", "then", "here"})
# Strong cues: the next word is a person ("told Will", "with Mark", "Dear Hope", "Dr. Rose").
_STRONG = frozenset({
    "with", "ask", "asked", "asking", "asks", "tell", "told", "telling", "tells", "call", "called", "calling",
    "calls", "text", "texted", "texting", "texts", "email", "emailed", "emailing", "message", "messaged",
    "ping", "pinged", "thank", "thanks", "thanked", "remind", "reminded", "meet", "met", "meeting",
    "visit", "visited", "visiting", "invite", "invited", "inviting", "dear", "hi", "hey", "hello", "hiya",
    "mr", "mrs", "ms", "mx", "dr", "prof", "professor", "uncle", "aunt", "auntie", "cousin", "coach", "named",
    "name", "hug", "hugged", "kiss", "kissed",
})
# Extra cues for ordinary names only (too loose for month/season words like May, June, Summer).
_STRONG_PERSON_ONLY = frozenset({
    "is", "was", "are", "were", "it's", "that's", "who's", "he's", "she's", "see", "saw", "seeing", "love",
    "loved", "hate", "hated", "like", "liked", "miss", "missed", "help", "helped", "join", "joined", "hire",
    "hired", "fire", "fired", "bring", "brought", "pick", "picked", "give", "gave", "send", "sent", "show",
    "showed", "pay", "paid", "teach", "taught", "owe", "owed", "behind", "between", "without", "towards",
    "beside", "near", "beat", "follow", "followed",
})
# Plain prepositions: "to Will", "for Grace". Count for ordinary names only.
_PREP_CUES = frozenset({"to", "for", "from", "by", "at", "about", "after", "before", "than"})
_TITLES = frozenset({"mr", "mrs", "ms", "mx", "dr", "prof", "st"})

# Words directly AFTER the name -----------------------------------------------------------------------------
# After "Will"/"Mark" these say the name is the SUBJECT of a normal sentence (3rd person / past tense).
_PERSON_VERBS = frozenset({
    "said", "says", "told", "tells", "called", "calls", "texted", "texts", "emailed", "emails", "messaged",
    "asked", "asks", "came", "comes", "went", "goes", "wants", "wanted", "is", "was", "has", "had", "does",
    "did", "got", "gets", "thinks", "thought", "knows", "knew", "mentioned", "mentions", "suggested", "suggests",
    "replied", "replies", "wrote", "writes", "left", "leaves", "arrived", "arrives", "loves", "loved", "likes",
    "liked", "needs", "needed", "works", "worked", "lives", "lived", "sent", "sends", "offered", "offers",
    "wasn't", "isn't", "hasn't", "hadn't", "doesn't", "didn't", "can", "could", "would", "should", "might",
    "must", "can't", "cannot", "couldn't", "wouldn't", "shouldn't", "won't", "took", "takes", "gave", "gives",
    "made", "makes", "saw", "sees", "ran", "runs", "met", "meets", "felt", "feels", "found", "finds", "brought",
    "brings", "bought", "buys", "taught", "teaches", "heard", "hears", "stopped", "started", "starts", "called",
    "seems", "seemed", "looks", "looked", "sounds", "sounded",
})
# Words that follow a MODAL/verb reading: "Will you", "May I", "Mark the date", "Bill me", "Rose to".
_NOT_PERSON_NEXT = frozenset({
    "you", "i", "we", "they", "he", "she", "it", "there", "this", "that", "these", "those", "not", "be", "have",
    "the", "a", "an", "my", "your", "his", "her", "our", "their", "its", "me", "us", "him", "them", "to", "up",
    "down", "off", "out", "over", "on", "in", "into", "go", "do", "come", "get", "take", "make", "see", "let",
    "someone", "anyone", "everyone", "nobody", "somebody", "probably", "definitely", "maybe", "perhaps", "soon",
    "of", "for", "at", "by", "with", "from", "as", "if", "so", "then", "than", "or", "but",
})
# Capitalised words that are NOT a surname after the name ("Will It Work", "Mark I Think").
_FUNCTION_CAPS = _NOT_PERSON_NEXT | frozenset({"is", "are", "was", "were", "am", "does", "did", "can", "could",
                                               "would", "should", "might", "must", "what", "when", "where", "why",
                                               "how", "who", "which", "all", "any", "some", "no", "yes", "okay",
                                               "ok", "and", "also", "just", "now", "today", "tomorrow", "testament"})
# After a comma ("Rose, can you..."): the sentence is addressed to the name.
_VOCATIVE_FOLLOW = frozenset({"you", "i", "we", "can", "could", "would", "will", "please", "are", "do", "did",
                              "what", "how", "why", "when", "where", "thanks", "thank", "let", "let's", "don't",
                              "have", "is", "should", "hey", "sorry", "stop", "wait", "listen", "look"})
_ED_DENY = frozenset({"need", "feed", "speed", "seed", "breed", "bleed", "weed", "deed", "heed", "indeed",
                      "proceed", "succeed", "exceed", "hundred", "shed", "sled", "sacred", "naked", "wicked",
                      "red", "bed", "wed", "fed", "led", "shred", "ahead", "instead", "bread", "thread",
                      "spread", "dead", "head", "read", "lead"})
# "to Mark the occasion", "to Rose up": the name is a verb when the next word is one of these.
_INF_OBJECT = frozenset({"the", "a", "an", "this", "that", "these", "those", "it", "them", "him", "her", "me",
                         "us", "off", "up", "down", "out", "my", "your", "his", "our", "their", "its", "as",
                         "all", "sure", "each", "every", "any", "some", "one"})

_WORD = re.compile(r"[A-Za-z][A-Za-z']*")
_SENT_END = ".!?:;\n\r"
_OPENERS = "\"“‘([{*_"
_BULLETS = "-*•>#"


def _word_re(name: str):
    return re.compile(r"(?<![\w])" + re.escape(name.strip()) + r"(?![\w])", re.IGNORECASE)


def _prev_context(norm: str, start: int):
    """(kind, word): kind is 'start' (sentence/line start), 'comma', 'word', 'digit' or 'other'."""
    pre = norm[:start].rstrip(" \t")
    while pre and pre[-1] in _OPENERS:
        pre = pre[:-1].rstrip(" \t")
    if not pre:
        return "start", ""
    c = pre[-1]
    if c in "\n\r":
        return "start", ""
    if c in "-•>#" and (len(pre) == 1 or pre[-2] in "\n\r "):   # list bullet / heading marker
        return "start", ""
    if c == ",":
        return "comma", ""
    if c in "!?:;":
        return "start", ""
    if c == ".":
        m = re.search(r"([A-Za-z]+)\.$", pre)
        if m and m.group(1).lower() in _TITLES:     # "Dr. Will Smith"
            return "word", m.group(1).lower()
        return "start", ""
    if c.isdigit():
        return "digit", ""
    m = re.search(r"([A-Za-z][A-Za-z']*)$", pre)
    if m:
        return "word", m.group(1).lower()
    return "other", ""


def _next_context(norm: str, end: int):
    """(possessive, contraction, hyphen, digit, comma, ended, word, after_and, raw_next_word)."""
    suf = norm[end:]
    possessive = bool(re.match(r"'s(?![A-Za-z])", suf))
    contraction = bool(re.match(r"'[A-Za-z]", suf)) and not re.match(r"'s(?![A-Za-z])", suf)
    hyphen = bool(re.match(r"-[A-Za-z]", suf))
    if possessive:
        return dict(possessive=True, contraction=False, hyphen=False, digit=False, comma=False, ended=False,
                    word="", raw="", after_and="")
    rest = suf.lstrip(" \t")
    first = rest[:1]
    digit = first.isdigit()
    comma = first == ","
    ended = (not rest) or first in ".!?;:)]}\"”’\n\r" or (suf[:1] in "\n\r")
    probe = rest[1:].lstrip(" \t") if comma else rest
    m = _WORD.match(probe) if not ended or comma else None
    raw = m.group(0) if m else ""
    word = raw.lower()
    after_and = ""
    if word in ("and", "&") or (probe.startswith("&")):
        m2 = _WORD.match(probe[3:].lstrip(" \t") if word == "and" else probe[1:].lstrip(" \t"))
        after_and = m2.group(0) if m2 else ""
    return dict(possessive=False, contraction=contraction, hyphen=hyphen, digit=digit, comma=comma, ended=ended,
                word=word, raw=raw, after_and=after_and)


def _looks_past(word: str) -> bool:
    return len(word) >= 4 and word.endswith("ed") and word not in _ED_DENY and not word.endswith("eed")


def _next_signals_person(nx: dict) -> bool:
    w, raw = nx["word"], nx["raw"]
    if w in _PERSON_VERBS or _looks_past(w):
        return True
    if w == "and" and nx["after_and"] and (nx["after_and"][0].isupper() or nx["after_and"].lower() in ("me", "my")) \
            and nx["after_and"].lower() != "testament":
        return True
    if raw and raw[0].isupper() and w not in _FUNCTION_CAPS and len(raw) >= 2 and not raw.isupper():
        return True    # "Will Smith", "Rose Garcia"
    return False


def occurrence_is_person(text: str, start: int, end: int, name: str = "") -> bool:
    """Judge ONE occurrence text[start:end] of an ambiguous name."""
    norm = text.replace("’", "'").replace("‘", "'")     # length-preserving
    word = norm[start:end]
    key = (name or word).strip().lower()
    if norm[max(0, start - 2):start] == "[[":           # explicit wikilink
        return True
    nx = _next_context(norm, end)
    if nx["contraction"] or nx["hyphen"] or nx["digit"]:     # "Don't", "Mark-up", "May 5"
        return False
    if norm[max(0, start - 1):start] == "-" and start >= 2 and norm[start - 2].isalpha():   # "co-Will"
        return False
    if not word[:1].isupper():
        return False
    kind, pl = _prev_context(norm, start)
    if kind == "digit":
        return False
    modal = key in MODAL_NAMES
    time_name = key in TIME_NAMES
    if pl in _DETERMINERS:
        return False
    if pl in _SUBJECTS or (modal and pl in _MODAL_SUBJECTS):
        return False
    if nx["possessive"]:
        return True
    if pl in _STRONG or (pl in _STRONG_PERSON_ONLY and not time_name):
        return True
    if pl in _PREP_CUES and not time_name:
        return not (pl == "to" and nx["word"] in _INF_OBJECT)     # "to Mark the occasion" is a verb
    # No decisive word before it: look at what follows.
    if nx["comma"]:
        if kind in ("word", "comma"):
            return True
        if nx["word"] in _VOCATIVE_FOLLOW:
            return True
        return bool(nx["raw"]) and nx["raw"][0].isupper() and nx["word"] not in _FUNCTION_CAPS and nx["raw"] != "I"
    if kind == "comma" and nx["ended"]:
        return True
    if nx["word"] in _NOT_PERSON_NEXT and nx["word"] not in _PERSON_VERBS:
        return False
    return _next_signals_person(nx)


def mentions(name: str, text: str) -> list[tuple[int, int]]:
    """Spans of `name` in `text` that refer to a person."""
    name = (name or "").strip()
    if not name or not text:
        return []
    spans = [m.span() for m in _word_re(name).finditer(text)]
    if not is_ambiguous(name):
        return spans
    return [(s, e) for s, e in spans if occurrence_is_person(text, s, e, name)]


def mentioned(name: str, text: str) -> bool:
    """True if `name` appears in `text` as a person (any case for ordinary names; context-checked for the
    ambiguous ones)."""
    name = (name or "").strip()
    if not name or not text:
        return False
    if not is_ambiguous(name):
        return bool(_word_re(name).search(text))
    return any(occurrence_is_person(text, m.start(), m.end(), name) for m in _word_re(name).finditer(text))


def filter_people(names: list[str], text: str, exempt=()) -> list[str]:
    """Drop ambiguous names that the text only uses as ordinary words. Order kept. `exempt` (e.g. the
    [[wikilinked]] names) always stays; non-ambiguous names are never touched."""
    keep = {str(e).strip().lower() for e in exempt}
    out = []
    for n in names:
        if not is_ambiguous(n) or str(n).strip().lower() in keep or mentioned(n, text):
            out.append(n)
    return out
