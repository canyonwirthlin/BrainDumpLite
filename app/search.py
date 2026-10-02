"""Search (0.20): keyword + meaning + names, forgiving of typos and word endings.

What "smarter" means here, all deterministic except the optional embedding pass:
  * stemming ("run" finds "running") and prefix matching ("dent" finds "dentist"),
    via the porter FTS index (see db._upgrade_fts);
  * every word must match first (AND); dumps matching only some words come after (OR);
  * typo tolerance: a word that isn't in your vault is corrected against the words you
    actually use ("dentst" -> "dentist");
  * people and concepts count: searching "Bella" also surfaces every dump she's in,
    and the matching names are returned so the UI can jump straight to them;
  * items (tasks, ideas...) match too, and say which one matched;
  * semantic similarity when an embedding model is available.
Results are scored, not just concatenated, so a dump that matches several ways floats up.
"""
from __future__ import annotations

import difflib
import json
import re

from . import ai, db, graph

STOP = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "my", "is", "it", "i",
        "me", "about", "that", "this", "was", "were", "be", "what", "when", "did", "do", "how", "where"}
MAX_RESULTS = 25


def terms(q: str) -> list[str]:
    words = re.findall(r"\w+", q.lower())
    kept = [w for w in words if w not in STOP]
    return kept or words


def _vocab() -> set[str]:
    """Every distinctive word in the vault (titles, names, concepts, item text) — the typo dictionary."""
    words: set[str] = set()
    for r in db.query(f"SELECT title, people, concepts FROM dumps WHERE status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}"):
        for chunk in [r["title"] or ""] + graph._names(r["people"]) + graph._names(r["concepts"]):
            words.update(w for w in re.findall(r"\w+", chunk.lower()) if len(w) >= 4)
    for r in db.query(f"SELECT content FROM items WHERE status != 'rejected' AND dump_id NOT IN (SELECT id FROM dumps WHERE deleted_at IS NOT NULL) AND {db.PRIVATE_ITEM_SQL} LIMIT 3000"):
        words.update(w for w in re.findall(r"\w+", (r["content"] or "").lower()) if len(w) >= 4)
    return words


def correct(term: str, vocab: set[str]) -> str | None:
    """A close word from the vault when `term` isn't one itself (None = keep as typed)."""
    if len(term) < 4 or any(w.startswith(term) for w in vocab):
        return None
    m = difflib.get_close_matches(term, vocab, n=1, cutoff=0.78)
    return m[0] if m else None


def _fts_query(ts: list[str], fixes: dict[str, str], op: str) -> str:
    parts = []
    for t in ts:
        alts = [f'"{t}"*'] + ([f'"{fixes[t]}"*'] if t in fixes else [])
        parts.append("(" + " OR ".join(alts) + ")" if len(alts) > 1 else alts[0])
    return f" {op} ".join(parts)


def _entity_hits(ts: list[str], fixes: dict[str, str]) -> list[dict]:
    """People / concepts whose name matches every search word (prefix, stem or typo)."""
    if not ts:
        return []
    out = []
    for kind, rows in (("person", graph.people()), ("concept", graph.concepts())):
        for e in rows:
            toks = re.findall(r"\w+", e["name"].lower())

            def hit(t: str) -> bool:
                cands = [t] + ([fixes[t]] if t in fixes else [])
                return any(tok.startswith(c) or graph._stem(tok) == graph._stem(c) for c in cands for tok in toks)

            if toks and all(hit(t) for t in ts):
                out.append({"type": kind, "name": e["name"], "count": e["count"]})
    out.sort(key=lambda e: (-e["count"], e["name"].lower()))
    return out[:8]


def search(q: str) -> dict:
    q = q.strip()
    ts = terms(q)
    if not ts:
        return {"query": q, "results": [], "entities": [], "corrected": {}}

    vocab = _vocab()
    fixes = {t: c for t in ts if (c := correct(t, vocab))}
    res: dict[str, dict] = {}

    def entry(did: str, title, created_at, snippet: str = "") -> dict:
        e = res.setdefault(did, {"id": did, "title": title, "created_at": created_at, "snippet": snippet,
                                 "score": 0.0, "via": set(), "matched_items": [], "matched_names": []})
        e["snippet"] = e["snippet"] or snippet
        return e

    # 1 · keyword: all words first, then any word
    seen: set[str] = set()
    for op, base in (("AND", 4.0), ("OR", 1.5)):
        if op == "OR" and len(ts) == 1:
            break
        try:
            rows = db.query(
                "SELECT d.id, d.title, d.created_at, snippet(dumps_fts, 1, '「', '」', '…', 14) AS snip "
                "FROM dumps_fts JOIN dumps d ON d.id = dumps_fts.id "
                f"WHERE dumps_fts MATCH ? AND d.deleted_at IS NULL AND d.status='ready' AND {db.PRIVATE_SQL} ORDER BY bm25(dumps_fts) LIMIT 30",
                (_fts_query(ts, fixes, op),))
        except Exception:
            rows = []
        for rank, r in enumerate(rows):
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            e = entry(r["id"], r["title"], r["created_at"])
            e["snippet"] = r["snip"] or e["snippet"]      # the highlighted excerpt wins
            e["score"] += base + 1.0 / (1 + rank)
            e["via"].add("keyword")
        if op == "AND" and len(rows) >= 10:
            break

    # 2 · items: a task / idea / … whose own text matches surfaces its dump and says which item
    try:
        rows = db.query(
            "SELECT f.item_id, f.dump_id, i.kind, i.content, i.done, d.title, d.created_at, d.summary "
            "FROM items_fts f JOIN items i ON i.id = f.item_id JOIN dumps d ON d.id = f.dump_id "
            f"WHERE items_fts MATCH ? AND d.deleted_at IS NULL AND d.status='ready' AND {db.PRIVATE_SQL} AND i.status != 'rejected' "
            "ORDER BY bm25(items_fts) LIMIT 40", (_fts_query(ts, fixes, "AND" if len(ts) > 1 else "OR"),))
        for r in rows:
            e = entry(r["dump_id"], r["title"], r["created_at"], (r["summary"] or "")[:160])
            if len(e["matched_items"]) < 4:
                e["matched_items"].append({"id": r["item_id"], "kind": r["kind"], "content": r["content"][:160], "done": bool(r["done"])})
                e["score"] += 1.5 if len(e["matched_items"]) == 1 else 0.4
            e["via"].add("items")
    except Exception:
        pass

    # 3 · names: searching "Bella" finds every dump Bella is in
    entities = _entity_hits(ts, fixes)
    for ent in entities[:3]:
        for d in graph._for_name("people" if ent["type"] == "person" else "concepts", ent["name"]):
            e = entry(d["id"], d["title"], d["created_at"], d["raw_text"])
            e["score"] += 3.0 if ent["type"] == "person" else 2.0
            e["via"].add(ent["type"])
            e["matched_names"].append(ent["name"])

    # 4 · meaning (only with an embedding model)
    emb = ai.embed(q) if ai.available() else None
    if emb:
        rows = db.query(f"SELECT id, title, created_at, summary, embedding FROM dumps WHERE embedding IS NOT NULL AND status='ready' AND deleted_at IS NULL AND {db.PRIVATE_SQL}")
        scored = sorted(((r, ai.cosine(emb, json.loads(r["embedding"]))) for r in rows), key=lambda t: -t[1])
        for r, sc in scored[:8]:
            if sc < 0.45:
                break
            e = entry(r["id"], r["title"], r["created_at"], (r["summary"] or "")[:160])
            e["score"] += sc * 3
            e["via"].add("semantic")

    # A word in the title is a strong signal; newest first inside a tie
    for e in res.values():
        title = (e["title"] or "").lower()
        e["score"] += sum(1 for t in ts if t in title)
    ranked = sorted(res.values(), key=lambda e: (round(e["score"], 2), e["created_at"] or ""), reverse=True)
    out = []
    for e in ranked[:MAX_RESULTS]:
        v = e["via"]
        via = ("both" if {"keyword", "semantic"} <= v else "items" if v == {"items"} else
               "semantic" if v == {"semantic"} else "name" if v <= {"person", "concept"} else "keyword")
        out.append({"id": e["id"], "title": e["title"], "created_at": e["created_at"], "snippet": e["snippet"],
                    "via": via, "matched_items": e["matched_items"], "matched_names": sorted(set(e["matched_names"]))})
    return {"query": q, "results": out, "entities": entities, "corrected": fixes}
