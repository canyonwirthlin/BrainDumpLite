"""AI pipeline: cleanup → classify → embed → link.

Runs in a background thread after a dump is created. Every stage degrades
gracefully — with no AI provider configured the dump is still saved, indexed
for keyword search, and split into rough items heuristically.
"""
from __future__ import annotations

import json
import re
import traceback
from datetime import datetime, timedelta

from . import ai, db, instrument, item_types, wikilinks

TONES = ["calm", "hopeful", "excited", "neutral", "reflective", "anxious", "frustrated", "overwhelmed", "low"]
EST_BUCKETS = [5, 15, 30, 60, 120, 240]

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
      "first_tiny_step": "smallest possible first action" or null,
      "estimated_minutes": 5|15|30|60|120|240 or null,
      "urgency": 0|1|2|3,
      "time_hint": "the exact time phrase from the text, e.g. 'by Friday'" or null
    }
  ],
  "tone": {"label": "calm|hopeful|excited|neutral|reflective|anxious|frustrated|overwhelmed|low", "valence": -2..2, "energy": 0..2},
  "people": ["first names or full names of people mentioned by name"],
  "concepts": ["key topics, projects, domains, or recurring named themes — NO generic words like want/need/feel/think/time/thing/work/life"]
}

Item type rules:
{TYPE_RULES}

Priority (tasks only): 5=today, 4=this week, 3=moderate, 2=nice-to-have, 1=someday

Time relevance: estimated_minutes is how long the item would take (pick the closest
bucket, null if unknowable). urgency: 3 = must happen today or is overdue, 2 = this week
or a stated deadline, 1 = eventually matters, 0 = no time pressure. Use the capture time
and time of day below when judging "today"/"tonight". time_hint copies the user's own
time words verbatim (null if none).

Tone: one label for the whole dump, valence from -2 (very negative) to 2 (very positive),
energy from 0 (flat/tired) to 2 (charged/agitated).

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
                    "estimated_minutes": {"type": ["integer", "null"]},
                    "urgency": {"type": ["integer", "null"]},
                    "time_hint": {"type": ["string", "null"]},
                },
                "required": ["type", "content"],
            },
        },
        "tone": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "label": {"type": "string", "enum": TONES},
                "valence": {"type": "integer"},
                "energy": {"type": "integer"},
            },
            "required": ["label"],
        },
        "people": {"type": "array", "items": {"type": "string"}},
        "concepts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "items"],
}

# Capture modes. "therapy" and "brainstorm" also unlock a live conversational
# session (see personas.py); mode no longer changes how the pipeline itself runs.
VALID_MODES = ("freeform", "brainstorm", "therapy", "execution")


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
    h = now.hour
    tod = "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 17 else "evening" if 17 <= h < 22 else "night"
    return (f"Current date/time: {now.strftime('%A, %B %d, %Y at %I:%M %p')} ({tod})\n"
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
         "detail": None, "priority": None, "due_date": None, "est_minutes": None, "urgency": None, "time_hint": None}
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
        est = it.get("estimated_minutes")
        est = int(est) if isinstance(est, (int, float)) and int(est) in EST_BUCKETS else None
        urg = it.get("urgency")
        urg = max(0, min(3, int(urg))) if isinstance(urg, (int, float)) else None
        hint = it.get("time_hint")
        hint = str(hint).strip()[:60] or None if isinstance(hint, str) else None
        # Guardrail: drop dates the model invented for tasks with no time word
        # anywhere in its text or its quoted time_hint. Events are inherently
        # scheduled, so trust those.
        if due and kind != "event" and not _has_time_ref(f"{content} {detail or ''} {hint or ''}"):
            due = None
        out.append({"kind": kind, "content": content[:500], "detail": detail, "priority": prio,
                    "due_date": due, "est_minutes": est, "urgency": urg, "time_hint": hint})
    return out


def _parse_tone(data: dict) -> dict | None:
    t = data.get("tone")
    if not isinstance(t, dict) or t.get("label") not in TONES:
        return None
    def clamp(v, lo, hi, default):
        return max(lo, min(hi, int(v))) if isinstance(v, (int, float)) else default
    return {"label": t["label"], "valence": clamp(t.get("valence"), -2, 2, 0), "energy": clamp(t.get("energy"), 0, 2, 1)}


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


def _known_concepts_hint(dump_id: str, limit: int = 30) -> str:
    """The user's most-used concept names so far. Small models invent a fresh spelling every
    time ("internships" / "internship applications"), which fragments the knowledge graph;
    nudging them to reuse an existing name keeps recurring topics in one place."""
    counts: dict[str, list] = {}
    for r in db.query("SELECT concepts FROM dumps WHERE concepts IS NOT NULL AND status='ready' AND id != ?", (dump_id,)):
        try:
            names = json.loads(r["concepts"] or "[]")
        except (ValueError, TypeError):
            continue
        for n in names:
            n = str(n).strip()
            if n:
                counts.setdefault(n.lower(), [n, 0])[1] += 1
    if not counts:
        return ""
    top = [v[0] for v in sorted(counts.values(), key=lambda v: (-v[1], v[0].lower()))[:limit]]
    return ("\n\nConcepts this user already has: " + ", ".join(top) +
            ". When this dump is about one of these, use that exact name instead of a new variant "
            "(e.g. reuse \"internships\", don't write \"internship applications\"). Still add genuinely new concepts.")


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
    raw = row["raw_text"]
    use_ai = ai.available()
    provider = ai.config()["provider"] if use_ai else "off"
    try:
        # 1 · cleanup ---------------------------------------------------------
        _set(dump_id, status="processing", stage="cleanup", error=None, provider=provider,
             captured_local=row["captured_local"] or datetime.now().astimezone().isoformat(timespec="seconds"))
        clean = raw
        if use_ai:
            try:
                with instrument.timed(dump_id, "cleanup"):
                    clean = ai.chat(_CLEANUP_SYSTEM, raw,
                                    max_tokens=len(raw) // 2 + 500, temperature=0.1)
            except ai.AIError as e:
                print(f"[pipeline] cleanup fell back to raw text: {e}", flush=True)
                clean = raw
        _set(dump_id, clean_text=clean, stage="classify")

        # 2 · classify --------------------------------------------------------
        preset_title = row["title"]  # imported notes keep their heading
        title = preset_title or " ".join(clean.split()[:6])[:60] or "Untitled dump"
        summary = "• " + clean[:220].replace("\n", " ")
        items = _fallback_items(clean)
        people, concepts, tone = [], [], None
        if use_ai:
            try:
                with instrument.timed(dump_id, "classify"):
                    data = ai.chat_json(_classify_system() + _known_concepts_hint(dump_id) + "\n\n" + _date_table(), clean,
                                        schema=_classify_schema())
                tone = _parse_tone(data)
                title = preset_title or (str(data.get("title") or title)).strip()[:80]
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
        # Explicit [[wikilinks]] in the text always count (Phase 6).
        known = {n.lower() for r in db.query("SELECT people FROM dumps WHERE people IS NOT NULL AND id != ?", (dump_id,))
                 for n in (json.loads(r["people"] or "[]") if r["people"] else [])}
        people, concepts = wikilinks.merge(raw, people, concepts, known)
        db.execute("DELETE FROM items WHERE dump_id=?", (dump_id,))
        db.execute("DELETE FROM items_fts WHERE dump_id=?", (dump_id,))
        for it in items:
            iid = db.new_id()
            db.execute(
                "INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at, "
                "est_minutes, urgency, time_hint) VALUES (?,?,?,?,?,?,?, 'suggested', 0, ?, ?, ?, ?)",
                (iid, dump_id, it["kind"], it["content"], it["detail"], it["priority"], it["due_date"],
                 db.now_iso(), it.get("est_minutes"), it.get("urgency"), it.get("time_hint")))
            db.execute("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)",
                       (iid, dump_id, f"{it['content']} {it['detail'] or ''}"))
        _set(dump_id, title=title, summary=summary, tone=json.dumps(tone) if tone else None,
             people=json.dumps(people), concepts=json.dumps(concepts), stage="embed")

        # 3 · embed -----------------------------------------------------------
        emb = None
        if use_ai:
            with instrument.timed(dump_id, "embed"):
                emb = ai.embed(f"{title}\n{summary}\n{clean}")
        _set(dump_id, embedding=json.dumps(emb) if emb else None, stage="link")

        # 4 · index + link ----------------------------------------------------
        db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
        db.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)",
                   (dump_id, f"{title}\n{summary}\n{clean}"))
        _link(dump_id, emb, title, clean)

        _set(dump_id, status="ready", stage=None)

        # 5 · propose pushes to connected integrations (never auto-executes) ----
        try:
            from . import plugins, suggestions
            suggestions.from_dump(dump_id)
            plugins.on_dump(dump_id)
        except Exception:
            traceback.print_exc()
    except Exception as e:
        traceback.print_exc()
        _set(dump_id, status="failed", error=str(e)[:500])
