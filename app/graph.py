"""Knowledge-graph queries (Phase 5): node types, nodes/edges, concept and
people browsers, backlinks, and "on this day" resurfacing.
Everything is computed from existing tables; nothing is stored except the
per-day resurface choice (settings key "resurface:<date>")."""
from __future__ import annotations

import json
import random
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from . import db, item_types

BASE_TYPES = [
    {"id": "dump", "label": "Dumps", "color": "accent", "icon": "", "builtin": True},
    {"id": "concept", "label": "Concepts", "color": "amber", "icon": "", "builtin": True},
    {"id": "person", "label": "People", "color": "blue", "icon": "", "builtin": True},
]


BASE_KEY = "graph_base_types"   # settings: {"dump": {"label": ..., "color": ...}, ...} user renames/recolors


def _overrides() -> dict:
    d = db.get_setting(BASE_KEY, {})
    return d if isinstance(d, dict) else {}


def types() -> list[dict]:
    ov = _overrides()
    base = [{**b, **{k: v for k, v in (ov.get(b["id"]) or {}).items() if k in ("label", "color") and v}} for b in BASE_TYPES]
    return base + [{"id": t["id"], "label": t["label"], "color": t["color"], "icon": t["icon"], "builtin": False}
                   for t in item_types.enabled()]


def update_base_type(type_id: str, label: str | None = None, color: str | None = None) -> dict:
    """Rename / recolor one of the fixed node kinds (dumps, concepts, people)."""
    if type_id not in {b["id"] for b in BASE_TYPES}:
        raise ValueError(f"'{type_id}' isn't a built-in node kind")
    cur = dict(_overrides().get(type_id) or {})
    if label is not None:
        label = label.strip()
        if not 1 <= len(label) <= 30:
            raise ValueError("label must be 1-30 characters")
        cur["label"] = label
    if color is not None:
        cur["color"] = item_types._check_color(color)
    ov = _overrides()
    ov[type_id] = cur
    db.set_setting(BASE_KEY, ov)
    return next(t for t in types() if t["id"] == type_id)


def reset_base_type(type_id: str) -> dict:
    if type_id not in {b["id"] for b in BASE_TYPES}:
        raise ValueError(f"'{type_id}' isn't a built-in node kind")
    ov = _overrides()
    ov.pop(type_id, None)
    db.set_setting(BASE_KEY, ov)
    return next(t for t in types() if t["id"] == type_id)


def _names(raw) -> list[str]:
    try:
        return [str(n).strip() for n in json.loads(raw or "[]") if str(n).strip()]
    except (ValueError, TypeError):
        return []


# ── Concept spelling variants ────────────────────────────────────────────────
# "Internship", "internships" and "Internships" are one concept, not three graph nodes.
# Only spelling variants merge (case, plural, word order). Anything that needs judgement
# ("home" vs "home lab", "internships" vs "internship applications") stays separate: no word
# rule can tell those apart from "home" vs "home lab", and a wrong merge silently rewrites
# what the user sees. Related-but-different concepts are connected through the dumps that mention both
# (pipeline._link_shared_topics). People stay exact — "Sam" and "Samuel" may differ.
_STOP_TOK = {"a", "an", "the", "and", "of", "for", "to", "in", "on", "at", "my", "with", "your", "our"}


def _stem(tok: str) -> str:
    if len(tok) > 4 and tok.endswith("ies"):
        return tok[:-3] + "y"
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok


def _tokset(name: str) -> frozenset:
    return frozenset(_stem(t) for t in re.findall(r"[a-z0-9]+", name.lower()) if t not in _STOP_TOK)


def topic_words(names) -> set[str]:
    """Distinctive stemmed words (4+ letters) across a dump's concept names."""
    return {w for n in names for w in _tokset(str(n)) if len(w) >= 4}


def canonical_map(column: str = "concepts") -> dict[str, str]:
    """{lowercased name as stored: display name of its spelling-variant group} across all ready dumps."""
    freq: Counter = Counter()
    display: dict[str, str] = {}
    for r in db.query(f"SELECT {column} FROM dumps WHERE status='ready'"):
        for name in {n.lower(): n for n in _names(r[column])}.values():
            k = name.lower()
            freq[k] += 1
            display.setdefault(k, name)
    if column != "concepts":
        return dict(display)
    groups: dict[frozenset, list[str]] = {}
    for k in freq:
        groups.setdefault(_tokset(k) or frozenset([k]), []).append(k)
    out = {}
    for members in groups.values():
        best = min(members, key=lambda m: (-freq[m], len(m), m))
        for m in members:
            out[m] = display[best]
    return out


def _group_key(name: str, cmap: dict[str, str]) -> str:
    return cmap.get(name.lower(), name).lower()


def build(items: bool = False) -> dict:
    """Nodes: dumps + concepts + people (+ items). Edges: mention / similar / in."""
    rows = db.query("SELECT id, title, created_at, people, concepts FROM dumps WHERE status='ready'")
    nodes: list[dict] = []
    edges: list[dict] = []
    slots: dict[str, str] = {}
    cmap = canonical_map("concepts")

    def slot(name: str, kind: str) -> str:
        if kind == "concept":
            name = cmap.get(name.lower(), name)
        key = f"{kind}:{name.lower()}"
        if key not in slots:
            slots[key] = key
            nodes.append({"id": key, "label": name, "type": kind})
        return key

    for r in rows:
        nodes.append({"id": r["id"], "label": r["title"] or "Untitled", "type": "dump", "created_at": r["created_at"]})
        seen_c = set()
        for name in _names(r["concepts"]):
            tgt = slot(name, "concept")
            if tgt not in seen_c:
                seen_c.add(tgt)
                edges.append({"source": r["id"], "target": tgt, "type": "mention"})
        for name in _names(r["people"]):
            edges.append({"source": r["id"], "target": slot(name, "person"), "type": "mention"})
    for r in db.query("SELECT dump_id, related_id, score FROM links"):
        edges.append({"source": r["dump_id"], "target": r["related_id"], "type": "similar", "score": r["score"]})
    if items:
        ready = {n["id"] for n in nodes if n["type"] == "dump"}
        for r in db.query("SELECT id, dump_id, kind, content FROM items WHERE status != 'rejected'"):
            if r["dump_id"] not in ready:
                continue
            nodes.append({"id": "item:" + r["id"], "label": r["content"][:40], "type": r["kind"], "dump": r["dump_id"]})
            edges.append({"source": "item:" + r["id"], "target": r["dump_id"], "type": "in"})
    return {"nodes": nodes, "edges": edges}


def _dump_brief(r) -> dict:
    tone = None
    try:
        tone = json.loads(r["tone"]) if r["tone"] else None
    except (ValueError, TypeError):
        pass
    return {"id": r["id"], "title": r["title"] or "Untitled", "created_at": r["created_at"], "mode": r["mode"],
            "tone": tone, "provider": r["provider"], "item_count": r["item_count"],
            "raw_text": (r["clean_text"] or r["raw_text"] or "")[:160]}


_BRIEF_SQL = ("SELECT d.id, d.title, d.created_at, d.mode, d.tone, d.provider, d.clean_text, d.raw_text, d.people, d.concepts, "
              "(SELECT COUNT(*) FROM items i WHERE i.dump_id = d.id) AS item_count FROM dumps d WHERE d.status='ready'")


def _tally(column: str) -> list[dict]:
    cmap = canonical_map(column)
    counts: dict[str, dict] = {}
    for r in db.query(f"SELECT {column}, created_at FROM dumps WHERE status='ready'"):
        for k in {_group_key(n, cmap) for n in _names(r[column])}:
            e = counts.setdefault(k, {"name": cmap.get(k, k), "count": 0, "last_at": r["created_at"]})
            e["count"] += 1
            if r["created_at"] > e["last_at"]:
                e["last_at"] = r["created_at"]
    return sorted(counts.values(), key=lambda e: (-e["count"], e["name"].lower()))


def concepts() -> list[dict]:
    return _tally("concepts")


def people() -> list[dict]:
    return _tally("people")


def _for_name(column: str, name: str) -> list[dict]:
    cmap = canonical_map(column)
    want = _group_key(name.strip(), cmap)
    out = []
    for r in db.query(_BRIEF_SQL + " ORDER BY d.created_at DESC"):
        if want in {_group_key(n, cmap) for n in _names(r[column])}:
            out.append(_dump_brief(r))
    return out


def for_concept(name: str) -> list[dict]:
    return _for_name("concepts", name)


def for_person(name: str) -> list[dict]:
    return _for_name("people", name)


def backlinks(dump_id: str) -> dict:
    me = db.query_one("SELECT people, concepts FROM dumps WHERE id=?", (dump_id,))
    if not me:
        return {"similar": [], "via_concepts": [], "via_people": []}
    similar_ids = {r["related_id"] if r["dump_id"] == dump_id else r["dump_id"]
                   for r in db.query("SELECT dump_id, related_id FROM links WHERE dump_id=? OR related_id=?", (dump_id, dump_id))}
    briefs = {r["id"]: _dump_brief(r) for r in db.query(_BRIEF_SQL)}
    all_rows = {r["id"]: r for r in db.query("SELECT id, people, concepts FROM dumps WHERE status='ready' AND id != ?", (dump_id,))}

    def via(column: str) -> list[dict]:
        cmap = canonical_map(column)
        out, seen = [], set()
        for name in _names(me[column]):
            key = _group_key(name, cmap)
            if key in seen:
                continue
            seen.add(key)
            hits = [briefs[i] for i, r in all_rows.items() if key in {_group_key(n, cmap) for n in _names(r[column])} and i in briefs]
            if hits:
                out.append({"name": cmap.get(name.lower(), name), "dumps": hits[:8]})
        return out

    return {"similar": [briefs[i] for i in similar_ids if i in briefs],
            "via_concepts": via("concepts"), "via_people": via("people")}


def _local_day(created_at: str) -> str:
    try:
        dt = datetime.fromisoformat(created_at)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().date().isoformat()
    except ValueError:
        return created_at[:10]


def today(day: str | None = None) -> dict:
    day = day or date.today().isoformat()
    dumps = []
    for r in db.query(_BRIEF_SQL + " ORDER BY d.created_at ASC"):
        if _local_day(r["created_at"]) == day:
            d = _dump_brief(r)
            d["items"] = [dict(i) for i in db.query(
                "SELECT id, kind, content, detail, due_date, status, done, est_minutes, urgency FROM items WHERE dump_id=? AND status != 'rejected'", (r["id"],))]
            dumps.append(d)
    pending = db.query_one("SELECT COUNT(*) AS n FROM dumps WHERE status IN ('pending','processing')")["n"]
    return {"date": day, "dumps": dumps, "processing": pending}


def resurface() -> dict | None:
    """One older dump per day: same calendar day in an earlier month/year if
    possible, else a random one older than 14 days. Cached per local date."""
    key = "resurface:" + date.today().isoformat()
    cached = db.get_setting(key)
    if cached:
        r = db.query_one(_BRIEF_SQL + " AND d.id=?", (cached["id"],))
        if r:
            return {"dump": _dump_brief(r), "reason": cached["reason"]}
    now = datetime.now().astimezone()
    rows = db.query(_BRIEF_SQL)
    same_day, older = [], []
    for r in rows:
        try:
            dt = datetime.fromisoformat(r["created_at"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt = dt.astimezone()
        except ValueError:
            continue
        age = now - dt
        if age < timedelta(days=14):
            continue
        older.append(r)
        if dt.day == now.day and (dt.month, dt.year) != (now.month, now.year):
            months = (now.year - dt.year) * 12 + now.month - dt.month
            same_day.append((r, f"on this day, {months} month{'s' if months != 1 else ''} ago"))
    if same_day:
        r, reason = random.choice(same_day)
    elif older:
        r, reason = random.choice(older), "from a while ago"
    else:
        return None
    db.set_setting(key, {"id": r["id"], "reason": reason})
    return {"dump": _dump_brief(r), "reason": reason}


# ── Browse by type (Search tab) ──────────────────────────────────────────────

def browse() -> list[dict]:
    """Every node type with how many entries it has: people/concepts count distinct
    names (each carries its own mention count); item types count live items."""
    ov = {t["id"]: t for t in types()}
    out = [
        {"id": "person", "label": ov["person"]["label"], "color": ov["person"]["color"], "icon": "", "entries": "names",
         "count": len(people())},
        {"id": "concept", "label": ov["concept"]["label"], "color": ov["concept"]["color"], "icon": "", "entries": "names",
         "count": len(concepts())},
    ]
    counts = {r["kind"]: r["n"] for r in db.query(
        "SELECT i.kind, COUNT(*) AS n FROM items i JOIN dumps d ON d.id = i.dump_id "
        "WHERE i.status != 'rejected' AND d.status IN ('ready','manual') GROUP BY i.kind")}
    for t in item_types.enabled():
        out.append({"id": t["id"], "label": t["label"], "color": t["color"], "icon": t["icon"], "entries": "items",
                    "count": counts.get(t["id"], 0)})
    return out


def items_of_kind(kind: str) -> list[dict]:
    """Live items of one type, newest first, each with the dump it came from."""
    rows = db.query(
        "SELECT i.id, i.kind, i.content, i.detail, i.done, i.due_date, i.created_at, i.dump_id, d.title AS dump_title, d.status AS dump_status "
        "FROM items i JOIN dumps d ON d.id = i.dump_id "
        "WHERE i.kind=? AND i.status != 'rejected' AND d.status IN ('ready','manual') ORDER BY i.created_at DESC", (kind,))
    return [{**dict(r), "dump_id": None if r["dump_status"] == "manual" else r["dump_id"], "dump_title": None if r["dump_status"] == "manual" else r["dump_title"]}
            for r in rows]


# ── Merging nodes (0.20.4) ───────────────────────────────────────────────────
# "internships" and "internship applications" are two nodes but one thing to the user. A merge
# rewrites the name in every dump that has it, and remembers the old spellings as aliases so the
# next dump that says "internship applications" lands on the merged node instead of splitting again.

ALIAS_KEY = "name_aliases"          # settings: {"concept": {"old name lowercased": "Target"}, "person": {...}}
_COLUMN = {"person": "people", "concept": "concepts"}


def _aliases() -> dict:
    d = db.get_setting(ALIAS_KEY, {})
    return d if isinstance(d, dict) else {}


def _clean_name(n: str) -> str:
    return " ".join(str(n).replace("[[", "").replace("]]", "").split()).lstrip("@")[:60]


def apply_aliases(kind: str, names: list[str]) -> list[str]:
    """Rewrite freshly extracted names through the merge aliases (order kept, duplicates dropped)."""
    al = _aliases().get(kind) or {}
    out, seen = [], set()
    for n in names:
        n = al.get(str(n).strip().lower(), n)
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def merge_names(kind: str, sources: list[str], target: str) -> dict:
    """Fold every name in `sources` (and the spelling variants that go with them) into `target`."""
    col = _COLUMN.get(kind)
    if not col:
        raise ValueError("kind must be person or concept")
    target = _clean_name(target)
    sources = [_clean_name(s) for s in sources if _clean_name(s)]
    if not target:
        raise ValueError("The merged node needs a name")
    if not sources:
        raise ValueError("Pick at least one node to merge")
    with db.lock():
        cmap = canonical_map(col)
        keys = {_group_key(s, cmap) for s in sources} | {_group_key(target, cmap)}
        if len(keys) < 2 and target.lower() in {s.lower() for s in sources} and len(sources) == 1:
            raise ValueError("Nothing to merge — that's already one node")
        changed = 0
        for r in db.query(f"SELECT id, {col} FROM dumps WHERE {col} IS NOT NULL"):
            names = _names(r[col])
            if not any(_group_key(n, cmap) in keys or n.lower() == target.lower() for n in names):
                continue
            out, seen = [], set()
            for n in names:
                if _group_key(n, cmap) in keys:
                    n = target
                if n.lower() not in seen:
                    seen.add(n.lower())
                    out.append(n)
            if out != names:
                db.execute(f"UPDATE dumps SET {col}=? WHERE id=?", (json.dumps(out), r["id"]))
                changed += 1
        # Remember every stored spelling in the merged groups so future dumps follow along.
        al = _aliases()
        mine = al.setdefault(kind, {})
        old = [k for k, v in cmap.items() if v.lower() in keys or k in {s.lower() for s in sources}]
        for k in old:
            if k != target.lower():
                mine[k] = target
        for k, v in list(mine.items()):
            if v.lower() in {s.lower() for s in sources} or v.lower() in keys:
                mine[k] = target
        mine.pop(target.lower(), None)
        db.set_setting(ALIAS_KEY, al)
    return {"merged_dumps": changed, "name": target}


def duplicate_groups(kind: str, limit: int = 6) -> list[list[dict]]:
    """Names that probably are the same thing: spelling/typo neighbours ("Bela"/"Bella") or one
    name's words fully inside another's ("internships" / "internship applications"). Suggestions
    only — nothing merges until the user says so."""
    import difflib
    rows = people() if kind == "person" else concepts()
    toks = {e["name"]: _tokset(e["name"]) for e in rows}
    parent = {e["name"]: e["name"] for e in rows}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    names = [e["name"] for e in rows]
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ta, tb = toks[a], toks[b]
            close = difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio() >= 0.86
            subset = bool(ta and tb) and (ta < tb or tb < ta) and min(len(ta), len(tb)) >= 1 and kind == "concept"
            if close or subset:
                parent[find(a)] = find(b)
    groups: dict[str, list[dict]] = {}
    for e in rows:
        groups.setdefault(find(e["name"]), []).append({"name": e["name"], "count": e["count"]})
    out = [g for g in groups.values() if 2 <= len(g) <= 4]
    out.sort(key=lambda g: -sum(x["count"] for x in g))
    return out[:limit]
