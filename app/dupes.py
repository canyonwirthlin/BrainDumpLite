"""Smarter duplicate scan for concepts and people (Search -> Browse -> "Scan for duplicates").

graph.duplicate_groups() is the quick, always-on check (spelling + word subset). This is the deeper,
on-demand one. Every pair of names is scored from several independent signals:

  spelling / typo        "Bela" ~ "Bella", "Work out" ~ "Workout"
  word order / fuzzy     "gym routine" ~ "routine gym", "excercise plan" ~ "exercise plan"
  containment            "internships" inside "internship applications"          (concepts)
  nickname / first name  "Liz" ~ "Elizabeth", "Marlon" ~ "Marlon Funaki", "Bell" ~ "Bella"   (people)
  initials / acronym     "J. Smith" ~ "John Smith", "ML" ~ "machine learning"
  meaning                the embedding model says the two names mean the same thing (when one is available)

and then adjusted by how the names are used: two names that keep turning up in the SAME dump are
probably two different things ("Sam" and "Samuel" in one breath), while names that never meet and
share the same surroundings are probably one thing said two ways. If an AI provider is configured,
the candidate groups get a final yes/no review from it. Nothing merges here - the user decides.
"""
from __future__ import annotations

import difflib
import json
import re
import time

from . import ai, db, graph

DISMISS_KEY = "dupe_dismissed"    # settings: ["a|b", ...] lowercased, sorted name pairs the user said are NOT the same
THRESHOLD = 0.6
MAX_NAMES_EMBED = 160
EMBED_BUDGET_S = 25

NICKNAMES = [
    {"mom", "mother", "mama", "mum", "mommy", "mummy"}, {"dad", "father", "papa", "daddy", "pops"},
    {"grandma", "grandmother", "nana", "granny", "gran"}, {"grandpa", "grandfather", "granddad", "pawpaw"},
    {"liz", "lizzy", "beth", "betty", "elizabeth", "eliza"}, {"mike", "mikey", "michael"},
    {"matt", "matthew"}, {"chris", "christopher", "christian", "christine", "christina"},
    {"alex", "alexander", "alexandra", "alexis"}, {"sam", "samuel", "samantha"},
    {"jake", "jacob"}, {"josh", "joshua"}, {"dan", "danny", "daniel"}, {"nick", "nicholas", "nico"},
    {"tom", "tommy", "thomas"}, {"will", "william", "bill", "billy", "liam"}, {"rob", "bob", "robert", "bobby", "robbie"},
    {"jim", "james", "jimmy", "jamie"}, {"joe", "joseph", "joey"}, {"ben", "benjamin", "benny"},
    {"andy", "andrew", "drew"}, {"tony", "anthony"}, {"steve", "steven", "stephen"}, {"kate", "katie", "katherine", "catherine", "kathy"},
    {"jen", "jenny", "jennifer"}, {"becky", "rebecca"}, {"abby", "abigail"}, {"maggie", "margaret", "meg"},
    {"sophie", "sophia"}, {"izzy", "izzie", "isabel", "isabella", "isabelle", "bella", "belle"},
    {"ally", "allie", "allison", "alison"}, {"nate", "nathan", "nathaniel"}, {"zach", "zachary", "zack"},
    {"ed", "eddie", "edward", "ted"}, {"charlie", "charles", "chuck"}, {"hannah", "hanna"}, {"emma", "emily", "em"},
]
_NICK = {}
for _i, _g in enumerate(NICKNAMES):
    for _n in _g:
        _NICK.setdefault(_n, set()).add(_i)


def _words(name: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", name.lower())


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def _nick_match(a: str, b: str) -> bool:
    return bool(_NICK.get(a) and _NICK.get(b) and (_NICK[a] & _NICK[b])) and a != b


# ── pairwise signals: each returns (score 0-1, short reason) or None ─────────────────────────────

def _spelling(a: str, b: str):
    r = _ratio(a.lower(), b.lower())
    return (0.55 + 0.45 * r if r >= 0.86 else None, "spelling variant")


def _fuzzy_words(a: str, b: str):
    wa, wb = _words(a), _words(b)
    if len(wa) < 2 or len(wa) != len(wb):
        return None
    left = list(wb)
    for w in wa:
        best = max(left, key=lambda x: _ratio(w, x))
        if _ratio(w, best) < 0.8:
            return None
        left.remove(best)
    return 0.86, "same words (reordered or misspelled)"


def _containment(a: str, b: str):
    ta, tb = graph._tokset(a), graph._tokset(b)
    if ta and tb and (ta < tb or tb < ta):
        small, big = (ta, tb) if len(ta) < len(tb) else (tb, ta)
        return (0.78 if len(small) >= 2 or len(big) <= 2 else 0.68), "one name is part of the other"
    return None


def _acronym(a: str, b: str):
    for short, long_ in ((a, b), (b, a)):
        s = re.sub(r"[^a-z0-9]", "", short.lower())
        w = [x for x in _words(long_) if x not in graph._STOP_TOK] or _words(long_)
        if len(s) >= 2 and len(w) >= 2 and len(s) == len(w) and s == "".join(x[0] for x in w) and " " not in short.strip():
            return 0.8, "abbreviation"
    return None


def _person(a: str, b: str):
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return None
    # one-word name vs. a fuller name that starts with it ("Marlon" / "Marlon Funaki")
    for s, l in ((wa, wb), (wb, wa)):
        if len(s) == 1 and len(l) > 1 and (s[0] == l[0] or _nick_match(s[0], l[0]) or _ratio(s[0], l[0]) >= 0.85):
            return 0.72, "first name of the fuller name"
    if len(wa) == len(wb) == 1:
        x, y = wa[0], wb[0]
        if _nick_match(x, y):
            return 0.82, "nickname"
        s, l = sorted((x, y), key=len)
        if len(s) >= 3 and l.startswith(s) and len(l) - len(s) <= 4:
            return 0.66, "short form of the name"
    if len(wa) >= 2 and len(wa) == len(wb) and wa[-1] == wb[-1]:   # same surname, first names match loosely
        f, g = wa[0], wb[0]
        if (len(f) == 1 and g.startswith(f)) or (len(g) == 1 and f.startswith(g)):
            return 0.78, "initial + surname"
        if _nick_match(f, g) or (len(min(f, g, key=len)) >= 3 and max(f, g, key=len).startswith(min(f, g, key=len))):
            return 0.8, "nickname + same surname"
    return None


_GENERIC = {"day", "time", "work", "life", "plan", "plans", "planning", "thing", "things", "stuff", "issue", "issues", "feeling",
            "feelings", "people", "social", "personal", "general", "online", "session", "routine", "habit", "habits", "new", "way",
            "app", "out", "get", "one", "big", "end", "off"}


def _shared_word(a: str, b: str):
    """Two concepts built on the same distinctive word ("smoking break" / "smoking cessation"). Related, maybe
    the same - only a candidate for the AI review, never shown on its own."""
    sa = {w for w in graph._tokset(a) if len(w) >= 3 and w not in _GENERIC}
    sb = {w for w in graph._tokset(b) if len(w) >= 3 and w not in _GENERIC}
    return (0.5, "shares the word '" + sorted(sa & sb)[0] + "'") if sa & sb else None


def _score_pair(kind: str, a: str, b: str, candidates: bool = False):
    sigs = [_spelling(a, b), _fuzzy_words(a, b)]
    if kind == "person":
        sigs.append(_person(a, b))
    else:
        sigs += [_containment(a, b), _acronym(a, b)]
        if candidates:
            sigs.append(_shared_word(a, b))
    sigs = [s for s in sigs if s and s[0]]
    return max(sigs, key=lambda s: s[0]) if sigs else None


# ── scan ─────────────────────────────────────────────────────────────────────────────────────────

def _usage(kind: str):
    """({name: set(dump ids)}, {dump id: title}) for every name in ready dumps, spelling variants already folded."""
    col = "people" if kind == "person" else "concepts"
    cmap = graph.canonical_map(col)
    uses: dict[str, set] = {}
    titles: dict[str, str] = {}
    for r in db.query(f"SELECT id, title, {col} FROM dumps WHERE status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}"):
        titles[r["id"]] = r["title"] or "Untitled"
        for k in {graph._group_key(n, cmap) for n in graph._names(r[col])}:
            uses.setdefault(cmap.get(k, k), set()).add(r["id"])
    return uses, titles


def _neighbours(kind: str) -> dict[str, set]:
    """For each name, the OTHER kind of names it shares dumps with (a rough 'what it's about' fingerprint)."""
    other = "concepts" if kind == "person" else "people"
    ocmap = graph.canonical_map(other)
    col = "people" if kind == "person" else "concepts"
    cmap = graph.canonical_map(col)
    ctx: dict[str, set] = {}
    for r in db.query(f"SELECT {col}, {other} FROM dumps WHERE status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}"):
        around = {graph._group_key(n, ocmap) for n in graph._names(r[other])}
        for k in {graph._group_key(n, cmap) for n in graph._names(r[col])}:
            ctx.setdefault(cmap.get(k, k), set()).update(around)
    return ctx


def _dismissed() -> set:
    d = db.get_setting(DISMISS_KEY, [])
    return set(d) if isinstance(d, list) else set()


def _pair_key(a: str, b: str) -> str:
    return "|".join(sorted((a.lower(), b.lower())))


def dismiss(kind: str, names: list[str]) -> int:
    """Remember 'these are different things' so the scan stops suggesting them."""
    d = _dismissed()
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            d.add(f"{kind}:{_pair_key(a, b)}")
    db.set_setting(DISMISS_KEY, sorted(d))
    return len(d)


def _semantic(kind: str, names: list[str], notes: list[str]) -> dict[tuple, float]:
    """cosine(name embeddings) for pairs that look alike in meaning. Empty when no embedder is configured."""
    if kind != "concept" or not ai.available() or len(names) < 2:
        return {}
    vecs: dict[str, list[float]] = {}
    t0 = time.time()
    for n in names[:MAX_NAMES_EMBED]:
        if time.time() - t0 > EMBED_BUDGET_S:
            notes.append("meaning check stopped early (taking too long)")
            break
        try:
            v = ai.embed(n)
        except Exception:
            v = None
        if not v:
            if not vecs:
                return {}   # provider can't embed at all
            continue
        vecs[n] = v
    out = {}
    keys = list(vecs)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            c = ai.cosine(vecs[a], vecs[b])
            if c >= 0.80:
                out[(a, b)] = c
    return out


def _ai_review(kind: str, groups: list[dict], titles: dict, notes: list[str]) -> list[dict]:
    if not groups or not ai.available():
        return groups
    payload = [{"id": i, "names": [{"name": m["name"], "mentioned_in_dumps": m["count"]} for m in g["members"]],
                "why_flagged": g["reason"]} for i, g in enumerate(groups[:30])]
    system = (
        f"You review a personal notes app's list of possible duplicate {kind} names. For each candidate group decide whether "
        "ALL the names clearly refer to the SAME " + ("person" if kind == "person" else "topic/concept") + ", so that merging them "
        "into one is correct. Be conservative: names that are related but different (e.g. 'home' vs 'home lab', 'Sam' vs 'Samuel' "
        "when they could be two people, a parent topic vs a sub-topic) are NOT the same. "
        'Return {"verdicts":[{"id":<number>,"same":true|false,"keep":"<best name to keep>","reason":"<short>"}]}')
    try:
        data = ai.chat_json(system, json.dumps(payload), max_tokens=1500)
    except Exception as e:
        notes.append(f"AI review skipped ({str(e)[:80]})")
        return groups
    verdicts = {v.get("id"): v for v in data.get("verdicts", []) if isinstance(v, dict)}
    kept = []
    for i, g in enumerate(groups):
        v = verdicts.get(i)
        if v is None:
            kept.append(g)
        elif v.get("same") is True:
            g["ai"] = "confirmed"
            if v.get("reason"):
                g["reason"] = str(v["reason"])[:90]
            names = [m["name"] for m in g["members"]]
            if v.get("keep") in names:
                g["suggested"] = v["keep"]
            kept.append(g)
    notes.append(f"AI review dropped {len(groups[:30]) - sum(1 for g in kept if g.get('ai') == 'confirmed')} of {len(groups[:30])} candidates")
    return kept


def scan(kind: str, use_ai: bool = True) -> dict:
    if kind not in ("person", "concept"):
        raise ValueError("kind must be person or concept")
    uses, titles = _usage(kind)
    around = _neighbours(kind)
    names = sorted(uses, key=lambda n: -len(uses[n]))
    skip = _dismissed()
    notes: list[str] = []
    ai_on = bool(use_ai and ai.available())
    sem = _semantic(kind, names, notes) if ai_on else {}
    if use_ai and not ai_on:
        notes.append("No AI model is on, so only spelling-level matches were checked. Turn one on in Settings → AI to also catch same-meaning names.")
    sem_pairs = {tuple(sorted(k)): v for k, v in sem.items()}

    edges: list[tuple[str, str, float, str]] = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if f"{kind}:{_pair_key(a, b)}" in skip:
                continue
            hit = _score_pair(kind, a, b, candidates=ai_on)
            score, reason = hit if hit else (0.0, "")
            c = sem_pairs.get(tuple(sorted((a, b))))
            if c is not None and (not hit or c >= 0.9):
                s = 0.5 + (c - 0.8) * 2.2          # 0.80 -> 0.50, 0.90 -> 0.72, 1.0 -> 0.94
                if s > score:
                    score, reason = s, "same meaning"
            if score < 0.5:
                continue
            together = len(uses[a] & uses[b])
            if together:                              # said in the same dump: probably two different things
                score -= 0.4 if kind == "person" else 0.2
                if score < THRESHOLD:
                    continue
            else:
                score += 0.06                         # never mentioned together: consistent with one thing said two ways
            ca, cb = around.get(a, set()), around.get(b, set())
            if ca and cb and len(ca & cb) / len(ca | cb) >= 0.3:
                score += 0.08                         # shows up alongside the same things
                reason += ", same surroundings"
            only_candidate = reason.startswith("shares the word")
            if only_candidate:
                score = 0.62                         # passes to the AI review, which decides; never shown unreviewed
            if score >= THRESHOLD:
                edges.append((a, b, min(score, 0.99), reason))

    parent = {n: n for n in names}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, *_ in edges:
        parent[find(a)] = find(b)
    comp: dict[str, list[str]] = {}
    for n in {x for e in edges for x in e[:2]}:
        comp.setdefault(find(n), []).append(n)
    groups = []
    for members in comp.values():
        members.sort(key=lambda n: -len(uses[n]))
        members = members[:5]
        es = [e for e in edges if e[0] in members and e[1] in members]
        if len(members) < 2 or not es:
            continue
        top = max(es, key=lambda e: e[2])
        groups.append({"members": [{"name": n, "count": len(uses[n])} for n in members],
                       "confidence": round(sum(e[2] for e in es) / len(es), 2), "reason": top[3],
                       "examples": [titles[d] for d in list(uses[members[-1]])[:2]]})
    groups.sort(key=lambda g: (-g["confidence"], -sum(m["count"] for m in g["members"])))
    groups = groups[:40]
    reviewed = False
    if not ai_on:   # unreviewed candidates (shared-word / meaning-only) stay out when nothing can judge them
        groups = [g for g in groups if not g["reason"].startswith(("shares the word", "same meaning"))]
    if ai_on and groups:
        n_before = len(groups)
        groups = _ai_review(kind, groups, titles, notes)
        reviewed = any(g.get("ai") for g in groups) or len(groups) != n_before
    return {"groups": groups, "checked": len(names), "ai_reviewed": reviewed, "notes": notes}
