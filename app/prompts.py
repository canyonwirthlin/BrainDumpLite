"""Journal prompts for the Capture screen (0.20): one question, different every time.

Two sources, no model involved (a small model asked for "a deep prompt" gives greeting-card
filler, so these are hand-written):
  * a bank of questions that point at something a person usually avoids looking at;
  * questions built from YOUR vault — a task that keeps not happening, a topic or person you
    keep coming back to, a stretch of heavy dumps — which land harder than any generic one.
The recent ones are remembered so nothing repeats until the whole bank has been used.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from datetime import datetime, timezone

from . import db, graph

BANK = [
    "What are you pretending not to know?",
    "What did you want to say today that you swallowed — and to whom?",
    "Which of your current commitments would you not choose again if you were starting fresh today?",
    "When did you last feel fully awake to your own life? What was different about that day?",
    "What are you doing out of fear of disappointing someone — and would they even notice if you stopped?",
    "What's something you believe about yourself that you've never actually tested?",
    "Whose approval are you still working for?",
    "What would you do this week if you knew nobody would ever see it or judge it?",
    "What have you outgrown but haven't let go of?",
    "What's the most honest sentence you could say about how you spent yesterday?",
    "What do you keep postponing, and what does the postponing protect you from?",
    "Think of someone you envy. What exactly do they have — and is it that you want, or what you think it would give you?",
    "Where in your life are you being polite when you should be honest?",
    "What are you tolerating that is slowly costing you more than it seems?",
    "Describe your ideal ordinary Tuesday. How far is it from your actual Tuesday, and what's the first thing in the way?",
    "What did you need to hear as a kid that nobody said? Say it to yourself now.",
    "What are you most afraid will happen if you really try? And what if the opposite happened?",
    "What's the smallest lie you told yourself today?",
    "What do you do to avoid being alone with your thoughts — and what do you think would surface if you stopped?",
    "Which relationship in your life is running on habit rather than genuine want?",
    "What would you attempt if failing in front of everyone cost you nothing?",
    "Which part of your day do you most want to get through rather than live?",
    "What have you been calling “busy” that might really be avoidance?",
    "What decision have you already made but haven't admitted to yourself?",
    "Who do you become around certain people — and do you like that person?",
    "What do you know you should forgive, in yourself or someone else, and what is keeping it in place?",
    "What would you regret not having said or done a year from now?",
    "What are you good at that you've stopped valuing because it comes easily?",
    "If someone read your calendar and bank statement, what would they say you care about most? Would you agree with them?",
    "When did you last change your mind about something that mattered? What changed it?",
    "What are you waiting for permission to do — and who, specifically, would be giving it?",
    "What kind of tired are you: body, mind, or something else? What would actually rest that?",
    "What's a story you tell about your past that might not be the whole truth?",
    "What are you holding onto for the sake of who you used to be?",
    "What's something small that bothered you today more than it should have? What was it really touching?",
    "What are you carrying that isn't yours?",
    "Where's the gap between who you are at work and who you are everywhere else?",
    "What could you drop this month that would make everything else lighter?",
    "What's a fear you've had so long that you've stopped noticing it makes your choices for you?",
    "What are you rehearsing for a conversation that may never happen?",
    "What do you need less of, and what do you need more of? Be specific to the point of discomfort.",
    "What are you proud of that you haven't told anyone?",
    "Which of your habits is really a way of comforting yourself — and what discomfort is it covering?",
    "What advice would you give a friend in your exact situation? Why can't you take it?",
    "What question about your own life have you been avoiding asking?",
    "What did you almost do today and talk yourself out of?",
    "What did you love doing before you got good at it, or before it became a “should”?",
    "What are you not letting yourself want?",
    "Where did your energy go this week? Did the things that took it deserve it?",
    "What's the truest sentence you could write about right now?",
    "What would someone who loved you say you're avoiding?",
    "What part of who you are have you been editing to be easier for other people?",
    "What's the difference between what you're tired of and what you're actually ready to change?",
    "What would you do with a completely free afternoon that you're not letting yourself have?",
    "What did the person you were five years ago hope for that you quietly stopped hoping for?",
    "What are you most likely to say “I'll deal with that later” about, and how long has later been?",
    "What would it cost you to be honest with the person you're least honest with?",
]

# Words in a task or goal that make a "why hasn't this happened?" question ring false.
_TONE_HEAVY = {"anxious", "frustrated", "overwhelmed", "low"}
KEEP_SEEN = 90


def enabled() -> bool:
    return bool(db.get_setting("journal_prompt_enabled", True))


def _pid(kind: str, text: str) -> str:
    return kind + ":" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def _days_old(iso: str) -> int:
    try:
        d = datetime.fromisoformat(iso)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - d).days
    except (ValueError, TypeError):
        return 0


def personal() -> list[dict]:
    """Questions built from the vault. Each names something the person actually wrote."""
    out: list[dict] = []
    # A task that keeps not happening — the most honest question an old list can ask
    for r in db.query(
            "SELECT i.content, i.created_at FROM items i JOIN dumps d ON d.id = i.dump_id "
            "WHERE i.kind='task' AND i.done=0 AND i.status != 'rejected' AND d.deleted_at IS NULL AND d.status IN ('ready','manual') "
            "ORDER BY i.created_at ASC LIMIT 40"):
        age = _days_old(r["created_at"])
        if age >= 6:
            t = r["content"].strip().rstrip(".")
            out.append({"kind": "task", "text": f"“{t}” has been on your list for {age} days. What's the real reason it hasn't happened?"})
    for r in db.query(
            "SELECT i.content, i.created_at FROM items i JOIN dumps d ON d.id = i.dump_id "
            "WHERE i.kind='goal' AND i.done=0 AND i.status != 'rejected' AND d.deleted_at IS NULL AND d.status='ready' ORDER BY i.created_at ASC LIMIT 40"):
        if _days_old(r["created_at"]) >= 3:
            g = r["content"].strip().rstrip(".")
            out.append({"kind": "goal", "text": f"You said: “{g}” What would you have to stop doing to make honest room for it?"})
    for c in graph.concepts():
        if c["count"] >= 3:
            out.append({"kind": "concept",
                        "text": f"You've come back to “{c['name']}” in {c['count']} of your dumps. What are you circling that you haven't said plainly yet?"})
    for p in graph.people():
        if p["count"] >= 2:
            out.append({"kind": "person",
                        "text": f"{p['name']} has come up in {p['count']} of your dumps. What do you want from that relationship that you haven't asked for?"})
    tones = []
    for r in db.query("SELECT tone FROM dumps WHERE status='ready' AND deleted_at IS NULL AND tone IS NOT NULL ORDER BY created_at DESC LIMIT 5"):
        try:
            tones.append((json.loads(r["tone"]) or {}).get("label"))
        except (ValueError, TypeError):
            pass
    heavy = [t for t in tones if t in _TONE_HEAVY]
    if len(heavy) >= 3:
        label = max(set(heavy), key=heavy.count)
        out.append({"kind": "tone", "text": f"Your last few dumps have read {label}. If that feeling could speak for a minute, what would it say it needs?"})
    for o in out:
        o["id"] = _pid(o["kind"], re.sub(r"[0-9]+", "", o["text"]))   # day counts change; the subject is the identity
    return out


def next_prompt(rng: random.Random | None = None) -> dict:
    """A prompt not shown recently. Roughly a third of the time it's one from your own vault (when
    there is one to ask). Returns {"id", "text", "personal"}."""
    rng = rng or random
    seen = db.get_setting("journal_prompts_seen", []) or []
    seen_set = set(seen)
    bank = [{"id": f"b{i}", "text": t, "kind": "bank"} for i, t in enumerate(BANK)]
    fresh_bank = [b for b in bank if b["id"] not in seen_set]
    if not fresh_bank:                      # whole bank used: start over, but keep the newest few out
        seen = seen[-5:]
        seen_set = set(seen)
        fresh_bank = [b for b in bank if b["id"] not in seen_set]
    mine = [p for p in personal() if p["id"] not in seen_set]
    pick = rng.choice(mine) if mine and (rng.random() < 0.34 or not fresh_bank) else rng.choice(fresh_bank)
    db.set_setting("journal_prompts_seen", (seen + [pick["id"]])[-KEEP_SEEN:])
    return {"id": pick["id"], "text": pick["text"], "personal": pick["kind"] != "bank"}
