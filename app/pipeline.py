"""AI pipeline: cleanup → classify → expand → embed → link.

Runs in a background thread after a dump is created. Every stage degrades
gracefully — with no AI provider configured the dump is still saved, indexed
for keyword search, and split into rough items heuristically.
"""
from __future__ import annotations

import json
import re
import traceback
from datetime import datetime, timedelta

from . import ai, db, item_types

# Small models (esp. 3B) love inventing due dates — dating every task, often
# one-per-day down the lookup table. As a deterministic backstop to the prompt,
# we keep a model-assigned date ONLY when the item's own text actually contains
# a time reference. No time word in the item → the date was invented → drop it.
_TEMPORAL_RE = re.compile(r"""
    \b(
        today|tonight|tomorrow|tmrw|yesterday|asap|noon|midnight|
        morning|afternoon|evening|
        (mon|tues?|wednes|thurs?|fri|satur|sun)day | mon|tue|wed|thu|fri|sat|sun |
        (next|this|last)\s+(week|month|year|weekend) | weekend |
        (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(uary|ruary|ch|il|e|y|ust|tember|ober|ember)? |
        deadline|due|o'?clock |
        end\s+of\s+(the\s+)?(day|week|month|year) | eod|eom |
        in\s+\d+\s+(day|week|month|hour)s? |
        \d{1,2}\s*(am|pm) | \d{1,2}:\d{2} |
        \d{1,2}(st|nd|rd|th) | \d{4}-\d{2}-\d{2} | \d{1,2}/\d{1,2}
    )\b
""", re.IGNORECASE | re.VERBOSE)


def _has_time_ref(text: str) -> bool:
    return bool(_TEMPORAL_RE.search(text or ""))

_CLEANUP_SYSTEM = """
You are a transcript cleaning assistant. The user voice-dictated or typed raw thoughts.
Fix speech disfluencies, repeated words, filler words (um, uh, like), and obvious errors.

Rules:
- NEVER add, remove, or change any ideas, facts, or meaning.
- Preserve the user's vocabulary and tone.
- Return ONLY the cleaned transcript. No preamble, no commentary.
""".strip()

_CLASSIFY_TEMPLATE = """
You are a cognitive assistant parsing raw thought transcripts into structured data.
Extract EVERY distinct thought and classify it.

Respond with valid JSON matching this exact schema — no markdown, no extra keys:
{
  "title": "3-5 word memorable phrase capturing this dump's essence (e.g. 'Career pivot anxiety', 'Side project momentum')",
  "summary": ["array of 3-5 JSON strings, each one bullet starting with •, covering every key action, decision, or emotion. First person. Be all-inclusive — miss nothing."],
  "items": [
    {
      "type": "{TYPE_ENUM}",
      "content": "clear, complete statement — first person where natural",
      "priority": 1-5 or null,
      "due_date_iso": "YYYY-MM-DD" or null,
      "first_tiny_step": "smallest possible first action" or null
    }
  ],
  "emotional_tone": "anxious|excited|neutral|frustrated|hopeful|overwhelmed|reflective",
  "people": ["first names or full names of people mentioned by name"],
  "concepts": ["key topics, projects, domains, or recurring named themes — NO generic words like want/need/feel/think/time/thing/work/life"]
}

Item type rules:
{TYPE_RULES}

Priority (tasks only): 5=today, 4=this week, 3=moderate, 2=nice-to-have, 1=someday

Deadlines (due_date_iso): DEFAULT TO null. MOST TASKS HAVE NO DEADLINE. Only set a date
when the text EXPLICITLY states a time reference for THAT specific task (e.g. "by Friday",
"tomorrow", "August 12", "end of the month", "next week"). If a task has no time word of
its own, its due_date_iso MUST be null. NEVER invent a date, NEVER assign sequential dates,
NEVER spread tasks across consecutive days, NEVER use "today" as a default. Resolve a real,
stated reference to a concrete date using the lookup table; prefer the EARLIER date when
ambiguous. A task with a genuine stated deadline gets priority >= 4.

People extraction: include only proper names of actual people ("Jackson", "Mom",
"Dr. Kim"). Exclude company names, product names, place names.

Concepts: max 8, must be specific and meaningful. Good: "burnout", "startup idea",
"workout routine". Bad: "feel", "want", "time", "thing", "people", "day", "back".

Return ONLY the JSON object.
""".strip()

# Strict schema for local/built-in models: llama.cpp turns this into a grammar
# that forces valid, correctly-shaped JSON (see ai.chat's schema path). Only
# title/summary/items are required; the rest are optional so a weak model that
# omits them still validates. Keys mirror _CLASSIFY_TEMPLATE exactly; the type enum is replaced per run.
_CLASSIFY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "array", "items": {"type": "string"}},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "type": {"type": "string",
                             "enum": ["task", "goal", "idea", "concern", "event", "note"]},
                    "content": {"type": "string"},
                    "priority": {"type": ["integer", "null"]},
                    "due_date_iso": {"type": ["string", "null"]},
                    "first_tiny_step": {"type": ["string", "null"]},
                },
                "required": ["type", "content"],
            },
        },
        "emotional_tone": {"type": "string"},
        "people": {"type": "array", "items": {"type": "string"}},
        "concepts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "items"],
}

# One expand call per dump (not per item — that's a cost decision for API users).
_EXPAND_SYSTEMS = {
    "brainstorm": """
You are a creative thinking partner supercharging a brainstorm. For the 1-2 most
promising ideas in this dump:
1. Push each somewhere unexpected — a weird angle, an analogy from a completely different domain
2. Identify what assumption is baked in and flip it
3. Suggest one concrete experiment (under 30 mins) to test it

Be genuinely surprising. Avoid the obvious. Under 120 words, tight.
""".strip(),
    "therapy": """
You are a skilled, warm therapist reading a raw thought dump. In under 120 words:
1. Name the feeling underneath it (not just the surface emotion)
2. Offer one compassionate reframe — not toxic positivity, a genuine alternative lens
3. Ask one Socratic question that invites deeper self-understanding

Be warm and direct, not clinical. Address the person as "you".
""".strip(),
    "execution": """
You are a ruthless execution coach reading a task dump. In under 120 words:
1. Identify the single bottleneck that will make or break this set of tasks
2. Name the most common way people stall on exactly this kind of work
3. Give the specific first physical action to take in the next 10 minutes — include any tool or app needed

No motivational fluff. Concrete nouns, verbs, and tools only.
""".strip(),
    "freeform": """
You are a thoughtful thinking partner reading a raw dump. In under 80 words:
- Add one piece of useful context or a connection to something related
- Flag anything that might be more important than it seems
- End with one short follow-up question
""".strip(),
}


def _classify_system() -> str:
    """The classify prompt with the CURRENT enabled item types baked in."""
    return (_CLASSIFY_TEMPLATE
            .replace("{TYPE_ENUM}", "|".join(item_types.enum()))
            .replace("{TYPE_RULES}", item_types.prompt_rules()))


def _classify_schema() -> dict:
    schema = json.loads(json.dumps(_CLASSIFY_SCHEMA))
    schema["properties"]["items"]["items"]["properties"]["type"]["enum"] = item_types.enum()
    return schema


def _date_table() -> str:
    # LOCAL time, not UTC — UTC rolls to the wrong weekday every evening.
    # Small models are unreliable at date arithmetic; hand them a literal
    # weekday→date table so deadline resolution is a lookup, not a calculation.
    now = datetime.now().astimezone()
    rows = []
    for i in range(14):
        d = now + timedelta(days=i)
        name = ("Today" if i == 0 else "Tomorrow" if i == 1
                else ("This " if i < 7 else "Next ") + d.strftime("%A"))
        rows.append(f"  {name} ({d.strftime('%A')}) = {d.strftime('%Y-%m-%d')}")
    return (f"Current date/time: {now.strftime('%A, %B %d, %Y at %I:%M %p')}\n"
            "Date lookup table:\n" + "\n".join(rows))


def _set(dump_id: str, **fields) -> None:
    cols = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE dumps SET {cols} WHERE id=?", (*fields.values(), dump_id))


def _fallback_items(text: str) -> list[dict]:
    """No-AI heuristic: one item per non-empty line; action-ish phrasing → task."""
    chunks = [c.strip(" -•\t") for c in text.splitlines() if c.strip()] or [text.strip()]
    if len(chunks) > 12:  # prose, not a list — keep it as one note
        chunks = [text.strip()]
    action = re.compile(r"\b(need to|have to|must|remember to|todo|don't forget|should)\b", re.I)
    return [
        {"kind": "task" if action.search(c) else "note", "content": c[:500],
         "detail": None, "priority": None, "due_date": None}
        for c in chunks
    ]


def _parse_items(data: dict) -> list[dict]:
    out = []
    for it in data.get("items") or []:
        content = (it.get("content") or "").strip()
        if not content:
            continue
        kind = it.get("type") if it.get("type") in item_types.enum() else "note"
        prio = it.get("priority")
        prio = int(prio) if isinstance(prio, (int, float)) and 1 <= prio <= 5 else None
        due = it.get("due_date_iso")
        due = due if isinstance(due, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", due) else None
        detail = (it.get("first_tiny_step") or None)
        # Guardrail: drop dates the model invented for tasks with no time word.
        # Events are inherently scheduled, so trust those.
        if due and kind != "event" and not _has_time_ref(f"{content} {detail or ''}"):
            due = None
        out.append({"kind": kind, "content": content[:500],
                    "detail": detail, "priority": prio, "due_date": due})
    return out


def _parse_names(data: dict, key: str, limit: int) -> list[str]:
    out, seen = [], set()
    for n in (data.get(key) or [])[:limit]:
        n = str(n).strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n[:60])
    return out


def _fts_terms(text: str, n: int = 8) -> list[str]:
    words = re.findall(r"[a-zA-Z]{4,}", text.lower())
    seen, out = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= n:
            break
    return out


def _link(dump_id: str, emb: list[float] | None, title: str, text: str) -> None:
    db.execute("DELETE FROM links WHERE dump_id=?", (dump_id,))
    if emb:
        rows = db.query(
            "SELECT id, embedding FROM dumps WHERE id != ? AND embedding IS NOT NULL", (dump_id,))
        scored = sorted(
            ((r["id"], ai.cosine(emb, json.loads(r["embedding"]))) for r in rows),
            key=lambda t: -t[1])
        for rid, score in scored[:3]:
            if score >= 0.55:
                db.execute("INSERT OR REPLACE INTO links VALUES (?,?,?)", (dump_id, rid, round(score, 3)))
        if any(s >= 0.55 for _, s in scored[:3]):
            return
    # Keyword fallback (also used when embeddings found nothing)
    terms = _fts_terms(f"{title} {text}")
    if not terms:
        return
    match = " OR ".join(f'"{t}"' for t in terms)
    try:
        rows = db.query(
            "SELECT id FROM dumps_fts WHERE dumps_fts MATCH ? AND id != ? "
            "ORDER BY bm25(dumps_fts) LIMIT 3", (match, dump_id))
        for r in rows:
            db.execute("INSERT OR REPLACE INTO links VALUES (?,?,?)", (dump_id, r["id"], 0.5))
    except Exception:
        pass  # FTS syntax edge case — links are a nice-to-have


def run_pipeline(dump_id: str) -> None:
    row = db.query_one("SELECT * FROM dumps WHERE id=?", (dump_id,))
    if not row:
        return
    raw, mode = row["raw_text"], row["mode"]
    use_ai = ai.available()
    try:
        # 1 · cleanup ---------------------------------------------------------
        _set(dump_id, status="processing", stage="cleanup", error=None)
        clean = raw
        if use_ai:
            try:
                clean = ai.chat(_CLEANUP_SYSTEM, raw,
                                max_tokens=len(raw) // 2 + 500, temperature=0.1)
            except ai.AIError as e:
                print(f"[pipeline] cleanup fell back to raw text: {e}", flush=True)
                clean = raw
        _set(dump_id, clean_text=clean, stage="classify")

        # 2 · classify --------------------------------------------------------
        title = " ".join(clean.split()[:6])[:60] or "Untitled dump"
        summary = "• " + clean[:220].replace("\n", " ")
        items = _fallback_items(clean)
        people, concepts = [], []
        if use_ai:
            try:
                data = ai.chat_json(_classify_system() + "\n\n" + _date_table(), clean,
                                    schema=_classify_schema())
                title = (str(data.get("title") or title)).strip()[:80]
                summ = data.get("summary")
                if isinstance(summ, list):  # some models return the bullets as an array
                    summ = "\n".join(str(x) for x in summ)
                summary = str(summ or summary).strip()
                parsed = _parse_items(data)
                if parsed:
                    items = parsed
                people = _parse_names(data, "people", 10)
                concepts = _parse_names(data, "concepts", 8)
            except ai.AIError as e:
                print(f"[pipeline] classify fell back to heuristics: {e}", flush=True)
        db.execute("DELETE FROM items WHERE dump_id=?", (dump_id,))
        for it in items:
            db.execute(
                "INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at) "
                "VALUES (?,?,?,?,?,?,?, 'suggested', 0, ?)",
                (db.new_id(), dump_id, it["kind"], it["content"], it["detail"],
                 it["priority"], it["due_date"], db.now_iso()))
        _set(dump_id, title=title, summary=summary,
             people=json.dumps(people), concepts=json.dumps(concepts), stage="expand")

        # 3 · expand ----------------------------------------------------------
        reflection = None
        if use_ai:
            try:
                reflection = ai.chat(
                    _EXPAND_SYSTEMS.get(mode, _EXPAND_SYSTEMS["freeform"]),
                    clean, max_tokens=700, temperature=0.7)
            except ai.AIError as e:
                print(f"[pipeline] expand skipped: {e}", flush=True)
        _set(dump_id, reflection=reflection, stage="embed")

        # 4 · embed -----------------------------------------------------------
        emb = ai.embed(f"{title}\n{summary}\n{clean}") if use_ai else None
        _set(dump_id, embedding=json.dumps(emb) if emb else None, stage="link")

        # 5 · index + link ----------------------------------------------------
        db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
        db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)",
                   (dump_id, f"{title}\n{summary}\n{clean}"))
        _link(dump_id, emb, title, clean)

        _set(dump_id, status="ready", stage=None)
    except Exception as e:
        traceback.print_exc()
        _set(dump_id, status="failed", error=str(e)[:500])
