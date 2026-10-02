"""AI follow-up question: after a dump is ready the AI may ask ONE short, gentle question.

State lives in the (otherwise unused) `dumps.reflection` column as JSON:
  {"q": "...", "state": "open" | "answered" | "dismissed" | "none", "a": "...", "at": iso}
No schema change. The question is generated lazily the first time the dump's result screen asks for it
(never in the pipeline, so saving and reprocessing are never slowed or blocked). Answering appends a
clearly marked "Follow-up" block to the transcript, re-indexes search, refreshes the embedding, and can
optionally pull new items out of the answer.
"""
from __future__ import annotations

import json
import threading

from . import ai, db, instrument

MARK = "Follow-up"
MIN_CHARS = 60
_lock = threading.Lock()

_SYSTEM = """
You read someone's private journal entry. Decide if ONE short, gentle follow-up question would help them
say something they left vague: an unclear decision, an unnamed feeling, a half-mentioned plan or person.

Rules:
- Exactly one question, under 25 words, specific to THEIR text, warm and non-judgmental.
- No advice, no therapy-speak, no yes/no questions, no preamble.
- If the entry is clear and complete, or nothing deserves a question, reply with exactly: NONE
Return ONLY the question (or NONE).
""".strip()


def enabled() -> bool:
    """The user switch (default on) AND a working AI provider."""
    return bool(db.get_setting("followup_enabled", True)) and ai.available()


def _load(dump_id: str):
    return db.query_one("SELECT * FROM dumps WHERE id=? AND deleted_at IS NULL", (dump_id,))


def _state(row) -> dict:
    try:
        v = json.loads(row["reflection"] or "")
        return v if isinstance(v, dict) and "state" in v else {}
    except (ValueError, TypeError):
        return {}


def _save(dump_id: str, st: dict) -> None:
    db.execute("UPDATE dumps SET reflection=? WHERE id=?", (json.dumps(st), dump_id))


def _clean_question(text: str) -> str | None:
    q = " ".join((text or "").strip().strip('"').split())
    if not q or q.upper().startswith("NONE") or len(q) > 220 or "?" not in q:
        return None
    return q


def _view(st: dict) -> dict:
    if st.get("state") == "open":
        return {"state": "open", "question": st.get("q")}
    return {"state": st.get("state", "none")}


def get(dump_id: str) -> dict:
    """The current follow-up for a dump: {"state": "open", "question": ...} or {"state": "none"}.
    Generates the question on first call when allowed; failure just means no question."""
    row = _load(dump_id)
    if not row or row["status"] != "ready" or row["is_private"]:
        return {"state": "none"}   # private dumps never get an AI-generated question
    st = _state(row)
    if st:
        return _view(st)
    if not enabled():
        return {"state": "none"}  # not stored: turning AI/the switch on later can still ask
    text = (row["clean_text"] or row["raw_text"] or "").strip()
    if len(text) < MIN_CHARS:
        return {"state": "none"}
    with _lock:
        row = _load(dump_id)
        if not row:
            return {"state": "none"}
        st = _state(row)
        if st:
            return _view(st)
        try:
            with instrument.timed(dump_id, "followup"):
                q = _clean_question(ai.chat(_SYSTEM, text[:6000], max_tokens=80, temperature=0.5))
        except ai.AIError:
            return {"state": "none"}  # transient: try again next time
        st = {"q": q, "state": "open" if q else "none", "at": db.now_iso()}
        _save(dump_id, st)
    return _view(st)


def dismiss(dump_id: str) -> bool:
    row = _load(dump_id)
    if not row:
        return False
    st = _state(row)
    st["state"] = "dismissed"
    _save(dump_id, st)
    return True


def _extract_items(dump_id: str, question: str, answer: str) -> int:
    """Pull any new tasks/ideas out of the answer; they are added as suggestions, nothing is replaced."""
    from . import pipeline
    try:
        data = ai.chat_json(pipeline._classify_system() + "\n\n" + pipeline._date_table(),
                            f"(In answer to: {question})\n{answer}", schema=pipeline._classify_schema())
    except ai.AIError:
        return 0
    n = 0
    for it in pipeline._parse_items(data):
        iid = db.new_id()
        db.execute(
            "INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at, "
            "est_minutes, urgency, time_hint) VALUES (?,?,?,?,?,?,?, 'suggested', 0, ?, ?, ?, ?)",
            (iid, dump_id, it["kind"], it["content"], it["detail"], it["priority"], it["due_date"],
             db.now_iso(), it.get("est_minutes"), it.get("urgency"), it.get("time_hint")))
        db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)",
                   (iid, dump_id, f"{it['content']} {it['detail'] or ''}"))
        n += 1
    return n


def answer(dump_id: str, text: str, extract: bool = False) -> dict | None:
    """Append the answer to the dump. Returns {"items_added": n} or None if the dump is gone."""
    row = _load(dump_id)
    if not row:
        return None
    text = text.strip()
    st = _state(row)
    q = st.get("q") or "Follow-up"
    block = f"{MARK}: {q}\n{text}"
    col = "clean_text" if row["clean_text"] else "raw_text"
    db.execute(f"UPDATE dumps SET {col}=? WHERE id=?", (f"{(row[col] or '').rstrip()}\n\n{block}", dump_id))
    st.update({"state": "answered", "a": text, "q": q})
    _save(dump_id, st)
    d = _load(dump_id)
    body = "\n".join([d["title"] or "", d["summary"] or "", d["clean_text"] or d["raw_text"] or ""])
    db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
    if d["status"] == "ready":
        db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)", (dump_id, body))
    added = 0
    if ai.available():
        try:
            emb = ai.embed(body)
            if emb:
                db.execute("UPDATE dumps SET embedding=? WHERE id=?", (json.dumps(emb), dump_id))
        except Exception:
            pass
        if extract:
            added = _extract_items(dump_id, q, text)
    return {"items_added": added}
