"""Brain map insight overlays: the server-side numbers behind "Lonely dumps", "Open loops" and "Suggested links".

Everything here is read-only over dumps/items/links except the two small lists of user choices kept in
settings (`graph_manual_links` accepted by the user, `graph_dismissed_links` the user said are not related).
No dump content is ever changed. Trashed dumps and private dumps (and their items) are never read.

  lonely()           dumps nothing else on the map connects to, each with up to 3 nearest candidate dumps
  loops()            per-dump counts of open (undone) tasks, overdue ones flagged, with a few task titles
  suggested_links()  concept pairs that never share a dump but keep appearing in the same surroundings
  manual_links() / accept_link() / remove_link() / dismiss_link() / reset_dismissed()
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from datetime import date

from . import ai, db, graph

MANUAL_KEY = "graph_manual_links"          # settings: [{"a": node id, "b": node id, "at": iso}]
DISMISS_KEY = "graph_dismissed_links"      # settings: ["a|b", ...] sorted node-id pairs
MANUAL_CAP = 500
SUGGEST_CAP = 25

_LIVE = f"status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}"


# ── shared helpers ───────────────────────────────────────────────────────────────────────────

def _live_rows(columns: str = "id, title, created_at, people, concepts"):
    return db.query(f"SELECT {columns} FROM dumps WHERE {_LIVE}")


def _label_keys(raw, cmap: dict[str, str] | None) -> dict[str, str]:
    """{node key: display name} for one dump's JSON name list. Concepts go through the spelling-variant map."""
    out: dict[str, str] = {}
    for name in graph._names(raw):
        disp = cmap.get(name.lower(), name) if cmap is not None else name
        out.setdefault(disp.lower(), disp)
    return out


def _pair_key(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def _cid(key: str) -> str:
    return "concept:" + key


# ── open loops ───────────────────────────────────────────────────────────────────────────────

def loops(today: str | None = None) -> dict:
    """{"today", "total_open", "total_overdue", "dumps": {dump_id: {"open", "overdue", "tasks": [up to 5]}}}.
    Open = a task that is not done and not rejected, on a dump that is neither trashed nor private."""
    today = today or date.today().isoformat()
    rows = db.query(
        "SELECT i.id, i.dump_id, i.content, i.due_date, i.priority FROM items i JOIN dumps d ON d.id = i.dump_id "
        f"WHERE i.kind='task' AND i.done=0 AND i.status != 'rejected' AND d.status='ready' AND d.deleted_at IS NULL AND {db.PRIVATE_SQL.replace('is_private', 'd.is_private')} "
        "ORDER BY i.created_at")
    per: dict[str, dict] = {}
    total_open = total_overdue = 0
    for r in rows:
        due = (r["due_date"] or "")[:10] or None
        late = bool(due and due < today)
        e = per.setdefault(r["dump_id"], {"open": 0, "overdue": 0, "tasks": []})
        e["open"] += 1
        e["overdue"] += late
        e["tasks"].append({"id": r["id"], "title": (r["content"] or "").strip()[:120], "due": due, "overdue": late})
        total_open += 1
        total_overdue += late
    for e in per.values():
        e["tasks"].sort(key=lambda t: (not t["overdue"], t["due"] or "9999-99-99"))
        e["tasks"] = e["tasks"][:5]
    return {"today": today, "total_open": total_open, "total_overdue": total_overdue, "dumps": per}


# ── lonely dumps ─────────────────────────────────────────────────────────────────────────────

LONELY_MAX_LINKED = 1       # a dump sharing a name with at most this many other dumps still counts as lonely
LONELY_LIST_CAP = 400
CAND_PER_DUMP = 3
EMBED_RERANK_DUMPS = 60     # embedding re-rank is pure python, so it is limited to the newest N lonely dumps

_STOP = set("""a about above after again all also am an and any are as at be because been before being between both but by can
could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is
it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that
the their them then there these they this those through to too under until up very was we were what when where which while who
whom why will with would you your yours really thing things got get going went one two like still even much many make made
felt feel feeling today yesterday tomorrow maybe""".split())


def _words(text: str) -> list[str]:
    toks = (graph._stem(t) for t in re.findall(r"[^\W\d_]{3,}", (text or "").lower()))
    return [t for t in toks if t not in _STOP]


def _connections(rows, cmap, pmap) -> dict[str, set]:
    """dump id -> ids of other dumps sharing at least one concept or person with it."""
    by_name: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        keys = {"c:" + k for k in _label_keys(r["concepts"], cmap)} | {"p:" + k for k in _label_keys(r["people"], pmap)}
        for k in keys:
            by_name[k].append(r["id"])
    conn: dict[str, set] = {r["id"]: set() for r in rows}
    for ids in by_name.values():
        if len(ids) < 2:
            continue
        for i in ids:
            conn[i].update(ids)
    for i, s in conn.items():
        s.discard(i)
    return conn


def _word_candidates(lonely_ids: list[str], texts: dict[str, list[str]]) -> dict[str, list[tuple[str, float, int]]]:
    """TF-IDF cosine over binary word sets via an inverted index: id -> [(other id, score, shared words)] best first (a shortlist)."""
    n = max(1, len(texts))
    df: Counter = Counter()
    for ws in texts.values():
        df.update(set(ws))
    idf = {w: math.log(1 + n / c) for w, c in df.items()}
    limit = max(8, int(n * 0.25))       # words in a quarter of all dumps tell us nothing
    sets = {i: {w for w in ws if df[w] <= limit} for i, ws in texts.items()}
    norm = {i: math.sqrt(sum(idf[w] ** 2 for w in s)) or 1.0 for i, s in sets.items()}
    index: dict[str, list[str]] = defaultdict(list)
    for i, s in sets.items():
        for w in s:
            index[w].append(i)
    out: dict[str, list[tuple[str, float]]] = {}
    for i in lonely_ids:
        acc: dict[str, float] = defaultdict(float)
        shared: dict[str, int] = defaultdict(int)
        for w in sets.get(i, ()):
            for j in index[w]:
                if j != i:
                    acc[j] += idf[w] ** 2
                    shared[j] += 1
        scored = [(j, s / (norm[i] * norm[j]), shared[j]) for j, s in acc.items()]
        scored.sort(key=lambda t: -t[1])
        out[i] = scored[:25]
    return out


def _embed_rerank(lonely_ids: list[str], shortlist: dict[str, list[tuple[str, float, int]]]) -> dict[str, list[tuple[str, float]]]:
    """For lonely dumps that have an embedding, re-rank their shortlist by cosine similarity. Dumps without one keep
    their word-overlap order. Returns id -> [(other id, cosine)] only for the ones that were re-ranked."""
    want = lonely_ids[:EMBED_RERANK_DUMPS]
    if not want:
        return {}
    need = set(want)
    for i in want:
        need.update(t[0] for t in shortlist.get(i, ()))
    vecs: dict[str, list[float]] = {}
    ids = list(need)
    for k in range(0, len(ids), 400):
        chunk = ids[k:k + 400]
        for r in db.query(f"SELECT id, embedding FROM dumps WHERE embedding IS NOT NULL AND id IN ({','.join('?' * len(chunk))})", tuple(chunk)):
            try:
                v = json.loads(r["embedding"])
            except (ValueError, TypeError):
                continue
            if isinstance(v, list) and v:
                vecs[r["id"]] = v
    out = {}
    for i in want:
        if i not in vecs:
            continue
        ranked = sorted(((j, ai.cosine(vecs[i], vecs[j])) for j, *_ in shortlist.get(i, ()) if j in vecs), key=lambda t: -t[1])
        ranked = [t for t in ranked if t[1] >= 0.35]
        if ranked:
            out[i] = ranked
    return out


def lonely() -> dict:
    """Dumps that nothing else connects to: no similar link and at most one other dump sharing a concept or person.
    Each carries up to 3 nearest candidate dumps ("meaning" via embeddings when present, else shared words)."""
    rows = _live_rows("id, title, created_at, people, concepts")
    live = {r["id"]: r for r in rows}
    if not live:
        return {"count": 0, "total": 0, "dumps": []}
    cmap, pmap = graph.canonical_map("concepts"), graph.canonical_map("people")
    conn = _connections(rows, cmap, pmap)
    linked: set[str] = set()      # dumps with a "similar" link to another live dump (a trashed/private end has no node)
    for r in db.query("SELECT dump_id, related_id FROM links"):
        a, b = r["dump_id"], r["related_id"]
        if a in live and b in live and a != b:
            linked.update((a, b))
    lonely_ids = [i for i in live if i not in linked and len(conn[i]) <= LONELY_MAX_LINKED]
    lonely_ids.sort(key=lambda i: live[i]["created_at"], reverse=True)
    total = len(lonely_ids)
    lonely_ids = lonely_ids[:LONELY_LIST_CAP]
    if not lonely_ids:
        return {"count": 0, "total": len(live), "dumps": []}

    # Texts for the word-overlap lookup (title + the first part of the body).
    texts: dict[str, list[str]] = {}
    for r in db.query(f"SELECT id, title, summary, SUBSTR(COALESCE(clean_text, raw_text, ''), 1, 1500) AS body FROM dumps WHERE {_LIVE}"):
        texts[r["id"]] = _words(f"{r['title'] or ''} {r['title'] or ''} {r['summary'] or ''} {r['body'] or ''}")
    short = _word_candidates(lonely_ids, texts)
    by_meaning = _embed_rerank(lonely_ids, short)

    out = []
    for i in lonely_ids:
        if i in by_meaning:
            via, ranked = "meaning", by_meaning[i]
        else:   # words only: at least two shared (non-trivial) words and a visible overlap
            via, ranked = "words", [(j, s) for j, s, n in short.get(i, []) if n >= 2 and s >= 0.05]
        cands = []
        for j, s in ranked:
            if j == i or j not in live:
                continue
            cands.append({"id": j, "title": live[j]["title"] or "Untitled", "created_at": live[j]["created_at"],
                          "score": round(float(s), 3), "via": via})
            if len(cands) >= CAND_PER_DUMP:
                break
        r = live[i]
        out.append({"id": i, "title": r["title"] or "Untitled", "created_at": r["created_at"],
                    "connections": len(conn[i]), "candidates": cands})
    return {"count": total, "total": len(live), "dumps": out}


# ── manual + dismissed concept links ─────────────────────────────────────────────────────────

def _concept_universe() -> tuple[dict[str, str], dict[str, str]]:
    """({node id: label} for concepts, {node id: label} for people) across live dumps."""
    cmap, pmap = graph.canonical_map("concepts"), graph.canonical_map("people")
    concepts: dict[str, str] = {}
    people: dict[str, str] = {}
    for r in _live_rows("concepts, people"):
        for k, disp in _label_keys(r["concepts"], cmap).items():
            concepts[_cid(k)] = disp
        for k, disp in _label_keys(r["people"], pmap).items():
            people["person:" + k] = disp
    return concepts, people


def _read_manual() -> list[dict]:
    d = db.get_setting(MANUAL_KEY, [])
    return [x for x in d if isinstance(x, dict) and x.get("a") and x.get("b")] if isinstance(d, list) else []


def _read_dismissed() -> set:
    d = db.get_setting(DISMISS_KEY, [])
    return {x for x in d if isinstance(x, str)} if isinstance(d, list) else set()


def manual_links() -> list[dict]:
    """Links the user accepted, minus any whose nodes no longer exist (renamed/merged/trashed away)."""
    saved = _read_manual()
    if not saved:
        return []
    concepts, people = _concept_universe()
    ok = {**concepts, **people}
    return [{"a": x["a"], "b": x["b"], "a_label": ok[x["a"]], "b_label": ok[x["b"]], "at": x.get("at")}
            for x in saved if x["a"] in ok and x["b"] in ok]


def _checked_pair(a: str, b: str) -> tuple[str, str]:
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b or a == b:
        raise ValueError("Pick two different nodes")
    concepts, people = _concept_universe()
    known = {**concepts, **people}
    for x in (a, b):
        if x not in known:
            raise ValueError("One of those isn't on your map any more")
    return tuple(sorted((a, b)))  # type: ignore[return-value]


def accept_link(a: str, b: str) -> dict:
    """Remember a link between two concepts/people. Nothing about any dump changes."""
    a, b = _checked_pair(a, b)
    saved = _read_manual()
    if not any(_pair_key(x["a"], x["b"]) == _pair_key(a, b) for x in saved):
        if len(saved) >= MANUAL_CAP:
            raise ValueError("That's a lot of links already - remove a few first")
        saved.append({"a": a, "b": b, "at": db.now_iso()})
        db.set_setting(MANUAL_KEY, saved)
    return {"links": manual_links()}


def remove_link(a: str, b: str) -> dict:
    key = _pair_key(a, b)
    db.set_setting(MANUAL_KEY, [x for x in _read_manual() if _pair_key(x["a"], x["b"]) != key])
    return {"links": manual_links()}


def dismiss_link(a: str, b: str) -> dict:
    """'Not related': never suggest this pair again."""
    a, b = _checked_pair(a, b)
    d = _read_dismissed()
    d.add(_pair_key(a, b))
    db.set_setting(DISMISS_KEY, sorted(d))
    return {"dismissed": len(d)}


def reset_dismissed() -> dict:
    db.set_setting(DISMISS_KEY, [])
    return {"dismissed": 0}


# ── suggested links ──────────────────────────────────────────────────────────────────────────

HUB_CAP = 60            # a name seen alongside more than this many others is too generic to say anything
PAIR_BUDGET = 1_500_000
MIN_SUPPORT = 2         # both concepts must come up in at least this many dumps (the map hides one-off names by default)
PER_NODE_CAP = 3        # no concept appears in more than this many suggestions, so one busy concept can't take the list


def _centroids(wanted: dict[str, set[str]]) -> dict[str, list[float]]:
    """Mean embedding of the dumps that mention each concept (only those with embeddings, at least 2)."""
    dump_ids = set().union(*wanted.values()) if wanted else set()
    vecs: dict[str, list[float]] = {}
    ids = list(dump_ids)
    for k in range(0, len(ids), 400):
        chunk = ids[k:k + 400]
        for r in db.query(f"SELECT id, embedding FROM dumps WHERE embedding IS NOT NULL AND id IN ({','.join('?' * len(chunk))})", tuple(chunk)):
            try:
                v = json.loads(r["embedding"])
            except (ValueError, TypeError):
                continue
            if isinstance(v, list) and v:
                vecs[r["id"]] = v
    out = {}
    for key, dids in wanted.items():
        vs = [vecs[d] for d in dids if d in vecs]
        if len(vs) < 2:
            continue
        n = len(vs[0])
        vs = [v for v in vs if len(v) == n]
        if len(vs) >= 2:
            out[key] = [sum(col) / len(vs) for col in zip(*vs)]
    return out


def suggested_links(limit: int = SUGGEST_CAP) -> dict:
    """Concept pairs that never appear in the same dump but share surroundings. Signals, strongest first in the reason:
      * shared surroundings: they each come up next to the same other concepts/people (Adamic-Adar)
      * linked dumps: a dump about one is linked as "similar" to a dump about the other
      * meaning: the dumps that mention them read alike (embeddings, when the vault has them)
    Pairs the user accepted or dismissed are never returned."""
    rows = _live_rows("id, people, concepts")
    if len(rows) < 3:
        return {"links": []}
    cmap, pmap = graph.canonical_map("concepts"), graph.canonical_map("people")
    label: dict[str, str] = {}
    members: dict[str, set[str]] = defaultdict(set)          # node id -> dump ids
    dump_nodes: dict[str, set[str]] = {}
    for r in rows:
        keys = set()
        for k, disp in _label_keys(r["concepts"], cmap).items():
            keys.add(_cid(k)); label[_cid(k)] = disp
        for k, disp in _label_keys(r["people"], pmap).items():
            keys.add("person:" + k); label["person:" + k] = disp
        dump_nodes[r["id"]] = keys
        for k in keys:
            members[k].add(r["id"])
    # co-occurrence neighbours of every node
    nbr: dict[str, set[str]] = defaultdict(set)
    for keys in dump_nodes.values():
        for k in keys:
            nbr[k].update(keys)
    for k in nbr:
        nbr[k].discard(k)
    support = {k: len(v) for k, v in members.items()}
    cands = {k for k in members if k.startswith("concept:") and support[k] >= MIN_SUPPORT}
    if len(cands) < 2:
        return {"links": []}

    skip = _read_dismissed() | {_pair_key(x["a"], x["b"]) for x in _read_manual()}
    toks = {k: graph._tokset(label[k]) for k in cands}

    def eligible(a: str, b: str) -> bool:
        if b in nbr[a] or _pair_key(a, b) in skip:
            return False
        ta, tb = toks[a], toks[b]
        return not (ta and tb and (ta <= tb or tb <= ta))      # "internship" / "internship applications" is a merge, not a link

    # 1. shared surroundings (Adamic-Adar over co-occurrence neighbours)
    score: dict[tuple[str, str], float] = defaultdict(float)
    common: dict[tuple[str, str], list[str]] = defaultdict(list)
    budget = PAIR_BUDGET
    for w, ns in sorted(nbr.items(), key=lambda kv: len(kv[1])):
        targets = sorted(n for n in ns if n in cands)
        if len(targets) < 2 or len(ns) > HUB_CAP:
            continue
        pairs = len(targets) * (len(targets) - 1) // 2
        if pairs > budget:
            break
        budget -= pairs
        wt = 1.0 / math.log(2 + len(ns))
        for i, a in enumerate(targets):
            for b in targets[i + 1:]:
                if eligible(a, b):
                    score[(a, b)] += wt
                    common[(a, b)].append(w)

    # 2. dumps linked as "similar" (the user's own links)
    ev: dict[tuple[str, str], float] = defaultdict(float)
    live = dump_nodes
    for r in db.query("SELECT dump_id, related_id, score FROM links"):
        x, y = r["dump_id"], r["related_id"]
        if x not in live or y not in live or x == y:
            continue
        for a in live[x] & cands:
            for b in live[y] & cands:
                if a != b:
                    p = (a, b) if a < b else (b, a)
                    if eligible(*p):
                        ev[p] += float(r["score"] or 0.5)
    for p in ev:
        score.setdefault(p, 0.0)

    # keep a shortlist, then let embeddings (when they exist) add their opinion
    def base(p):
        return score[p] + 0.6 * min(ev.get(p, 0.0), 3.0) + 0.2 * len(common.get(p, ()))
    pool = [p for p in score if len(common.get(p, ())) >= 2 or ev.get(p, 0.0) > 0]
    pool.sort(key=base, reverse=True)
    pool = pool[:200]
    if not pool:
        return {"links": []}
    cent = _centroids({k: members[k] for k in {x for p in pool for x in p}})
    meaning: dict[tuple[str, str], float] = {}
    for a, b in pool:
        if a in cent and b in cent:
            c = ai.cosine(cent[a], cent[b])
            if c >= 0.6:
                meaning[(a, b)] = c

    def final(p):
        return base(p) + 2.0 * max(0.0, meaning.get(p, 0.0) - 0.6)
    pool.sort(key=final, reverse=True)

    picked, used = [], Counter()
    for p in pool:
        if used[p[0]] >= PER_NODE_CAP or used[p[1]] >= PER_NODE_CAP:
            continue
        picked.append(p)
        used.update(p)
        if len(picked) >= limit:
            break
    top = final(picked[0]) if picked else 1.0
    out = []
    for p in picked:
        a, b = p
        names = sorted(common.get(p, ()), key=lambda w: (not w.startswith("concept:"), len(nbr[w]), w))   # most specific surroundings first
        near = [label[w] for w in names[:3]]
        parts = []
        if near:
            parts.append(f"{_and(near)} come up next to both, but {label[a]} and {label[b]} have never been in the same dump.")
        if ev.get(p):
            parts.append(f"Dumps about {label[a]} are linked to dumps about {label[b]}.")
        if p in meaning:
            parts.append("The dumps that mention them read alike.")
        if not parts:
            parts.append("They keep turning up in the same surroundings.")
        out.append({"a": a, "b": b, "a_label": label[a], "b_label": label[b], "score": round(final(p) / top, 3),
                    "shared": near, "linked_dumps": bool(ev.get(p)), "similar_meaning": p in meaning, "reason": " ".join(parts)})
    return {"links": out}


def _and(xs: list[str]) -> str:
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]
