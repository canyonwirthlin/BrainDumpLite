"""Seed a throwaway vault with a realistic brain map, for developing / screenshotting the graph view.

    BRAINDUMP_LITE_DATA=<dir> python scripts/seed_graph_demo.py [--dumps 140] [--force] [--seed 7]

Safety: refuses to run unless BRAINDUMP_LITE_DATA is set (so it can never fall back to the real vault),
and refuses a vault that already holds dumps unless --force (which wipes dumps/items/links first).

What you get (deterministic for a given --seed and --dumps):
  * ~8 topic clusters, each with its own concepts and people, written across ~18 months
  * concept spelling variants ("Internship" / "internships" / "Internships") that graph.canonical_map merges
  * cross-cluster "bridge" concepts (Burnout, Sleep, Budgeting ...) and a few people who span clusters
  * `links` rows (the "similar" edges) with scores between 0.55 and 0.97
  * items of every built-in kind; tasks have due dates (some overdue) and done flags
  * a few lonely dumps with no concepts, people or links
  * two concepts that rise sharply in the last ~2 months and two that fade out after month ~8
  * one TRASHED dump (id seed-trashed) and one PRIVATE dump (id seed-private), each with a unique concept
    (TrashedOnlyConcept / PrivateOnlyConcept) so exclusion rules can be asserted
  * settings: onboarded=true so the app opens straight onto whatever page you point it at
No embeddings are created (not needed by the graph).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TRASHED_ID = "seed-trashed"
PRIVATE_ID = "seed-private"

# Each cluster: name, weight, burst centre (0 = oldest, 1 = today), people, concept specs, title/body templates.
# A concept spec is (variants, weight, trend). trend: flat | rising | fading.
CLUSTERS = [
    {"name": "Job search", "w": 1.3, "burst": 0.25,
     "people": ["Maya Chen", "Dr. Alvarez", "Priya"],
     "concepts": [
         (["Resume", "resume", "Resumes"], 3, "flat"), (["Internship", "internships", "Internships"], 3, "fading"),
         (["Interview prep", "interview prep", "Interview preparation"], 2.5, "fading"), (["Cover letter", "cover letters"], 2, "flat"),
         (["Networking"], 2, "flat"), (["LinkedIn"], 1.5, "flat"), (["Portfolio"], 2, "flat"),
         (["Salary negotiation"], 1, "flat"), (["Career change"], 1.5, "flat"), (["Recruiter"], 1, "flat"), (["Referral"], 0.8, "flat"),
     ],
     "titles": ["{c} follow-ups", "Thoughts on {c}", "Next steps for {c}", "{c} is stressing me out", "Making progress on {c}", "Rework my {c}"],
     "bodies": ["Spent the evening on {c}. I keep going back and forth, but {c2} feels like the real lever.",
                "Need to finish {c} before the week ends. {p} offered to look it over.",
                "Honestly {c} and {c2} are the two things I should be doing every day, and I am not."],
     "tasks": ["Email the recruiter about {c}", "Update {c} with the new project", "Book a mock session for {c}", "Send {c} to {p}"]},
    {"name": "Fitness", "w": 1.1, "burst": 0.6,
     "people": ["Coach Dan", "Jordan", "Sam"],
     "concepts": [
         (["Running"], 3, "flat"), (["Strength training", "strength training"], 2.5, "flat"), (["Half marathon"], 2, "rising"),
         (["Stretching"], 1.5, "flat"), (["Meal prep", "meal prep", "Meal-prep"], 2, "flat"), (["Protein"], 1.2, "flat"),
         (["Rest day", "rest days"], 1.4, "flat"), (["Gym membership"], 0.8, "fading"), (["Knee pain"], 1.2, "flat"), (["Training plan"], 2, "flat"),
     ],
     "titles": ["{c} this week", "Back at {c}", "{c} update", "Skipped {c} again", "New PR with {c}", "Plan for {c}"],
     "bodies": ["Did {c} this morning. It went better than expected, and {p} said my form on {c2} looks good.",
                "I keep telling myself {c} starts Monday. {c2} is the thing that actually holds me back.",
                "Legs are fried from {c}. Need to be smarter about {c2}."],
     "tasks": ["Schedule {c} for Saturday", "Buy shoes for {c}", "Ask {p} about {c}", "Log this week's {c}"]},
    {"name": "Home renovation", "w": 0.9, "burst": 0.45,
     "people": ["Contractor Mike", "Aunt Rosa", "Jordan"],
     "concepts": [
         (["Kitchen remodel", "kitchen remodel"], 3, "flat"), (["Permits"], 1.5, "flat"), (["Paint colors", "paint colour"], 2, "flat"),
         (["Contractor quotes", "contractor quote"], 2, "flat"), (["Flooring"], 2, "flat"), (["Budget overrun"], 1.2, "flat"),
         (["Lighting"], 1.3, "flat"), (["Cabinets"], 2, "flat"), (["Backyard deck", "deck"], 1.2, "flat"), (["Plumbing"], 1, "fading"),
     ],
     "titles": ["{c} decisions", "Quote for {c}", "{c} is taking forever", "Ideas for {c}", "Walkthrough: {c}"],
     "bodies": ["Met with {p} about {c}. We still have not settled {c2}.",
                "The {c} estimate came in higher than I hoped, which makes {c2} harder to justify.",
                "Looked at samples for {c} all afternoon. {c2} will have to wait."],
     "tasks": ["Call {p} about {c}", "Compare three options for {c}", "Measure the room for {c}", "Pay deposit for {c}"]},
    {"name": "Side project", "w": 1.4, "burst": 0.8,
     "people": ["Theo", "Nadia", "Priya"],
     "concepts": [
         (["Landing page", "landing pages"], 2.5, "flat"), (["Launch plan"], 2, "rising"), (["Beta testers", "beta tester"], 2, "rising"),
         (["Pricing"], 2, "flat"), (["Bug triage"], 1.5, "flat"), (["User feedback"], 2.5, "flat"), (["Onboarding flow", "onboarding"], 2, "flat"),
         (["Analytics"], 1.3, "flat"), (["Roadmap"], 2, "flat"), (["Open source"], 1, "flat"), (["Refactor"], 1.3, "flat"),
     ],
     "titles": ["{c} thoughts", "Shipping {c}", "{c}: what now?", "Where {c} stands", "Idea: rethink {c}", "{c} blockers"],
     "bodies": ["Worked on {c} after dinner. {p} had a good point about {c2}.",
                "If I get {c} right, {c2} mostly takes care of itself. I think.",
                "Too many things at once: {c}, {c2}, and everything else. I should pick one."],
     "tasks": ["Draft the copy for {c}", "Ask {p} to review {c}", "Fix the top issue in {c}", "Write down the plan for {c}"]},
    {"name": "Family", "w": 0.9, "burst": 0.35,
     "people": ["Mom", "Dad", "Aunt Rosa", "Sam", "Grandpa Joe"],
     "concepts": [
         (["Sunday dinner", "sunday dinners"], 2.5, "flat"), (["Mom's birthday"], 1.2, "flat"), (["Holiday plans", "holiday plan"], 2, "flat"),
         (["Visiting Grandpa"], 1.5, "flat"), (["Family group chat"], 1, "flat"), (["Road trip"], 1.5, "flat"), (["Reunion"], 1, "fading"),
         (["Gift ideas", "gift idea"], 1.8, "flat"), (["Caregiving"], 1.2, "rising"), (["Moving back home"], 0.8, "fading"),
     ],
     "titles": ["Call with {p}", "{c} planning", "About {c}", "{c} and family stuff", "Thinking about {c}"],
     "bodies": ["Talked to {p} about {c}. It brought up {c2} again.",
                "I want to be around more for {c}. {c2} keeps slipping.",
                "{p} mentioned {c}, and I realized I haven't thought about {c2} in weeks."],
     "tasks": ["Call {p} this weekend", "Order something for {c}", "Book tickets for {c}", "Reply to the group about {c}"]},
    {"name": "Finances", "w": 0.8, "burst": 0.55,
     "people": ["Accountant Lee", "Jordan"],
     "concepts": [
         (["Budgeting", "budget"], 3, "flat"), (["Emergency fund"], 2, "flat"), (["Taxes"], 2, "flat"), (["Student loans", "student loan"], 2, "fading"),
         (["Index funds"], 1.5, "flat"), (["Subscriptions", "subscription"], 1.8, "flat"), (["Credit card"], 1.2, "flat"),
         (["Rent"], 1.5, "flat"), (["Side income"], 1.4, "rising"), (["Savings rate"], 1.4, "flat"),
     ],
     "titles": ["{c} review", "Money check-in: {c}", "Fix my {c}", "{c} anxiety", "{c} plan"],
     "bodies": ["Went through the numbers on {c}. {c2} is worse than I assumed.",
                "{p} suggested a simpler approach to {c}, but {c2} complicates it.",
                "Every month I swear I will sort out {c}. This time I wrote it down."],
     "tasks": ["Cancel unused {c}", "Move money for {c}", "Gather paperwork for {c}", "Ask {p} about {c}"]},
    {"name": "Learning Spanish", "w": 0.7, "burst": 0.15,
     "people": ["Lucia", "Tutor Marco"],
     "concepts": [
         (["Spanish vocabulary", "spanish vocab"], 3, "fading"), (["Duolingo streak", "duolingo"], 2, "fading"), (["Conversation practice"], 2.5, "fading"),
         (["Subjunctive"], 1.5, "fading"), (["Trip to Mexico City"], 1.5, "flat"), (["Podcasts"], 1.2, "flat"), (["Flashcards", "flashcard"], 1.5, "fading"),
         (["Language exchange"], 1.2, "flat"),
     ],
     "titles": ["{c} session", "Stuck on {c}", "{c} progress", "Notes from {c}", "Why is {c} so hard"],
     "bodies": ["Practiced {c} for twenty minutes. {p} corrected my {c2}.",
                "{c} feels slow but {c2} is finally clicking.",
                "Skipped {c} again this week. {c2} is the part I actually enjoy."],
     "tasks": ["Review {c} before bed", "Schedule time with {p} for {c}", "Find a good resource for {c}", "Write ten sentences using {c}"]},
    {"name": "Health & mind", "w": 1.2, "burst": 0.7,
     "people": ["Dr. Alvarez", "Therapist Ines", "Jordan"],
     "concepts": [
         (["Anxiety"], 3, "flat"), (["Meditation"], 2, "flat"), (["Journaling"], 2.5, "flat"), (["Therapy"], 2, "flat"),
         (["Morning routine", "morning routines"], 2, "flat"), (["Screen time"], 1.5, "flat"), (["Doctor appointment", "doctor appointments"], 1.4, "flat"),
         (["Caffeine"], 1.3, "flat"), (["Gratitude"], 1.2, "flat"), (["Overthinking"], 2, "flat"), (["Sunlight"], 0.9, "flat"),
     ],
     "titles": ["{c} check-in", "Trying to understand {c}", "{c} today", "On {c}", "Small win: {c}"],
     "bodies": ["Noticed how much {c} shapes my day. {c2} seems tied to it.",
                "{p} asked about {c} and I did not have a good answer. Maybe {c2} is the key.",
                "Evening note: {c} was rough today, but {c2} helped a little."],
     "tasks": ["Book an appointment about {c}", "Try {c} for five minutes", "Write down what triggers {c}", "Ask {p} about {c}"]},
]

# Bridge concepts: appear across several clusters, so the map has cross-cluster tissue.
BRIDGES = [
    (["Burnout"], 3, "flat"), (["Sleep"], 3.5, "flat"), (["Time management", "time-management"], 3, "flat"),
    (["Procrastination"], 2.5, "flat"), (["Motivation"], 2.5, "flat"), (["Work-life balance"], 2, "flat"),
    (["Habits", "habit"], 2.5, "flat"), (["Weekly review"], 2, "flat"), (["Energy levels"], 1.8, "flat"),
    (["Priorities"], 2.2, "flat"), (["Deadlines"], 1.8, "rising"), (["Focus"], 2, "flat"),
]
LONELY_TITLES = ["Random thought", "Note to self", "Shower idea", "Grocery list brain dump", "Just venting", "Quiet evening",
                 "Dream I remember", "Song stuck in my head"]
LONELY_TEXT = ["Not sure why I'm writing this down. It just felt important for a second.",
               "Mostly noise today. Maybe it'll make sense later.",
               "Nothing particular to say. Writing it out helps anyway."]

TONE_MAP = {  # label -> (valence, energy), shaped like pipeline._parse_tone output
    "calm": (1, 0), "hopeful": (1, 1), "excited": (2, 2), "neutral": (0, 1), "reflective": (0, 0),
    "anxious": (-1, 2), "frustrated": (-1, 2), "overwhelmed": (-2, 2), "low": (-2, 0),
}
KIND_WEIGHTS = [("task", 5), ("idea", 2), ("goal", 1.5), ("concern", 1.5), ("event", 1), ("note", 1.2)]
MODES = [("freeform", 8), ("brainstorm", 1), ("therapy", 1), ("execution", 1.5)]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _pick(rng: random.Random, weighted):
    items, weights = zip(*weighted)
    return rng.choices(items, weights=weights, k=1)[0]


def _trend(kind: str, t: float) -> float:
    if kind == "rising":
        return 0.05 + t ** 4 * 4          # near zero until the last third, then climbs
    if kind == "fading":
        return 0.05 + (1 - t) ** 3 * 2.5  # gone by roughly month 10
    return 1.0


def _pick_concepts(rng, pool, t: float, k: int):
    """k distinct concepts (by first variant) from pool, weighted by trend at time t."""
    pool = list(pool)
    out = []
    for _ in range(min(k, len(pool))):
        weights = [spec[1] * _trend(spec[2], t) for spec in pool]
        spec = rng.choices(pool, weights=weights, k=1)[0]
        pool.remove(spec)
        out.append(spec)
    return out


def _variant(rng, spec) -> str:
    variants = spec[0]
    return variants[0] if len(variants) == 1 or rng.random() < 0.55 else rng.choice(variants)


def _bare_vault(db) -> bool:
    return db.query_one("SELECT COUNT(*) AS n FROM dumps WHERE id != ?", (db.MANUAL_DUMP_ID,))["n"] == 0


def seed(n_dumps: int = 140, force: bool = False, rng_seed: int = 7) -> dict:
    """Seed the vault at $BRAINDUMP_LITE_DATA. Returns counts. Refuses without the env var (or a non-empty vault)."""
    if not os.environ.get("BRAINDUMP_LITE_DATA"):
        raise SystemExit("Refusing to run: BRAINDUMP_LITE_DATA is not set (this script must never touch your real vault).")
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from app import db, item_types  # noqa: E402  (after the env check on purpose)

    db.init_db()
    item_types.seed()
    if not _bare_vault(db):
        if not force:
            raise SystemExit("Refusing to run: the vault already has dumps. Pass --force to wipe it first.")
        with db.lock():
            c = db.conn()
            for table in ("dumps_fts", "items_fts", "links", "items", "dump_merges", "dumps"):
                c.execute(f"DELETE FROM {table}")
            c.commit()
    n_dumps = max(3, int(n_dumps))
    rng = random.Random(rng_seed)
    now = _now()
    span_days = 548   # ~18 months
    today = now.date()

    # People who span clusters keep the same spelling everywhere (people never merge).
    # --- build the dump list -------------------------------------------------------------------
    n_lonely = min(max(2, n_dumps // 28), len(LONELY_TITLES))
    n_main = max(1, n_dumps - n_lonely - 2)   # -2 for the trashed + private dump
    # Spread timestamps over the span with a mild recency bias (people dump more once the habit sticks).
    fracs = sorted(rng.random() ** 0.8 for _ in range(n_main))
    dumps, items, links, fts_d, fts_i = [], [], [], [], []

    def rid() -> str:
        return f"{rng.getrandbits(128):032x}"

    def stamp(frac: float) -> str:
        dt = now - timedelta(days=span_days * (1 - frac))
        dt = dt.replace(hour=rng.choice([7, 8, 9, 12, 13, 18, 19, 21, 22, 23]), minute=rng.randint(0, 59),
                        second=rng.randint(0, 59), microsecond=rng.randint(0, 999999))
        if dt > now:
            dt = now - timedelta(minutes=rng.randint(1, 600))
        return dt.isoformat()

    def make_items(dump_id: str, created: str, cl, c_name: str, person: str, count: int, done_bias: float):
        for _ in range(count):
            kind = _pick(rng, KIND_WEIGHTS)
            if kind == "task":
                text = rng.choice(cl["tasks"]).format(c=c_name, p=person or "someone")
            elif kind == "goal":
                text = f"Get consistent with {c_name}"
            elif kind == "idea":
                text = f"What if {c_name} got its own weekly slot?"
            elif kind == "concern":
                text = f"Worried {c_name} is slipping"
            elif kind == "event":
                text = f"{c_name} meeting on the calendar"
            else:
                text = f"Remember: {c_name} details are in the shared doc"
            due = None
            prio = rng.randint(1, 5)
            if kind in ("task", "event") and rng.random() < 0.65:
                due = (today + timedelta(days=rng.randint(-45, 40))).isoformat()
            age_days = (now - datetime.fromisoformat(created)).days
            is_done = 1 if kind == "task" and rng.random() < (0.15 + done_bias * min(1.0, age_days / 40)) else 0
            status = "rejected" if rng.random() < 0.03 else ("approved" if (is_done or rng.random() < 0.45) else "suggested")
            iid = rid()
            items.append((iid, dump_id, kind, text, None, prio, due, status, is_done, created,
                          rng.choice([5, 15, 30, 60, 120]), rng.randint(1, 5) if kind == "task" else None, None))
            fts_i.append((iid, dump_id, text))

    all_bridge = BRIDGES
    by_cluster_ids: dict[str, list[tuple[str, float]]] = {c["name"]: [] for c in CLUSTERS}
    for frac in fracs:
        weights = [c["w"] * (0.35 + math.exp(-((frac - c["burst"]) ** 2) / 0.05)) for c in CLUSTERS]
        cl = rng.choices(CLUSTERS, weights=weights, k=1)[0]
        created = stamp(frac)
        k = rng.choice([2, 2, 3, 3, 4, 5])
        picks = _pick_concepts(rng, cl["concepts"], frac, k)
        if rng.random() < 0.38:   # a bridge concept, sometimes two
            picks += _pick_concepts(rng, all_bridge, frac, 1 if rng.random() < 0.8 else 2)
        names, seen = [], set()
        for spec in picks:
            nm = _variant(rng, spec)
            if spec[0][0].lower() not in seen:
                seen.add(spec[0][0].lower())
                names.append(nm)
        people = rng.sample(cl["people"], rng.choice([0, 1, 1, 2]) if len(cl["people"]) > 1 else 1)
        if rng.random() < 0.06:
            people.append(rng.choice(["Jordan", "Sam", "Priya", "Mom"]))
        people = list(dict.fromkeys(people))
        c1 = names[0]
        c2 = names[1] if len(names) > 1 else names[0]
        p = people[0] if people else "a friend"
        title = rng.choice(cl["titles"]).format(c=c1, p=p)
        body = " ".join(rng.choice(cl["bodies"]).format(c=c1, c2=c2, p=p) for _ in range(rng.randint(1, 3)))
        label = _pick(rng, [(t, 1) for t in TONE_MAP])
        valence, energy = TONE_MAP[label]
        did = rid()
        summary = "• " + body[:200]
        mode = _pick(rng, MODES)
        dumps.append((did, created, mode, body, body, title, summary, None, "ready", None, None,
                      json.dumps(people), json.dumps(names), json.dumps({"label": label, "valence": valence, "energy": energy}),
                      "seed", created, 0, None))
        fts_d.append((did, f"{title}\n{summary}\n{body}"))
        make_items(did, created, cl, c1, p if people else "", rng.choice([0, 1, 1, 2, 2, 3, 4]), done_bias=0.7)
        by_cluster_ids[cl["name"]].append((did, frac))

    # "similar" links: the nearest few same-cluster dumps in time, plus a rare cross-cluster one.
    pairs = set()
    for ids in by_cluster_ids.values():
        for i, (a, _) in enumerate(ids):
            if rng.random() < 0.45 and len(ids) > 1:
                b = ids[min(len(ids) - 1, max(0, i + rng.choice([-3, -2, -1, 1, 2, 3])))][0]
                if a != b and (b, a) not in pairs:
                    pairs.add((a, b))
    allids = [d[0] for d in dumps]
    for _ in range(len(allids) // 25):
        a, b = rng.sample(allids, 2) if len(allids) > 1 else (allids[0], allids[0])
        if a != b and (b, a) not in pairs:
            pairs.add((a, b))
    for a, b in sorted(pairs):
        links.append((a, b, round(rng.uniform(0.55, 0.97), 2)))

    # lonely dumps: no concepts, people or links
    for i in range(n_lonely):
        created = stamp(rng.random())
        did = rid()
        title, body = LONELY_TITLES[i], rng.choice(LONELY_TEXT)
        dumps.append((did, created, "freeform", body, body, title, "• " + body, None, "ready", None, None, "[]", "[]",
                      json.dumps({"label": "neutral", "valence": 0, "energy": 1}), "seed", created, 0, None))
        fts_d.append((did, f"{title}\n• {body}\n{body}"))

    # the trashed + private dumps (must never reach the graph, search, exports ...)
    deleted_at = (now - timedelta(days=3)).isoformat()
    for did, title, concept, flags in ((TRASHED_ID, "Trashed dump", "TrashedOnlyConcept", {"deleted": deleted_at}),
                                        (PRIVATE_ID, "Private dump", "PrivateOnlyConcept", {"private": 1})):
        created = stamp(0.9)
        body = f"This dump is excluded from the map. It mentions {concept}."
        dumps.append((did, created, "freeform", body, body, title, "• " + body, None, "ready", None, None,
                      json.dumps(["Jordan"]), json.dumps([concept, "Sleep"]), json.dumps({"label": "calm", "valence": 1, "energy": 0}),
                      "seed", created, flags.get("private", 0), flags.get("deleted")))
        iid = rid()
        items.append((iid, did, "task", f"Excluded task about {concept}", None, 3, None, "approved", 0, created, 15, 2, None))
        fts_i.append((iid, did, f"Excluded task about {concept}"))

    with db.lock():
        c = db.conn()
        c.executemany("INSERT INTO dumps (id, created_at, mode, raw_text, clean_text, title, summary, reflection, status, stage, error,"
                      " people, concepts, tone, provider, captured_local, is_private, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dumps)
        c.executemany("INSERT INTO items (id, dump_id, kind, content, detail, priority, due_date, status, done, created_at,"
                      " est_minutes, urgency, time_hint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", items)
        c.executemany("INSERT OR REPLACE INTO links (dump_id, related_id, score) VALUES (?,?,?)", links)
        c.executemany("INSERT INTO dumps_fts (id, body) VALUES (?,?)", fts_d)
        c.executemany("INSERT INTO items_fts (item_id, dump_id, body) VALUES (?,?,?)", fts_i)
        c.commit()
    db.set_setting("onboarded", True)
    db.set_setting("auto_links_removed", True)
    return {"dumps": len(dumps), "items": len(items), "links": len(links), "lonely": n_lonely,
            "trashed": TRASHED_ID, "private": PRIVATE_ID}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dumps", type=int, default=140, help="how many dumps to create (default 140; 2500 works too)")
    ap.add_argument("--force", action="store_true", help="wipe an existing vault's dumps/items/links first")
    ap.add_argument("--seed", type=int, default=7, help="random seed (default 7)")
    a = ap.parse_args(argv)
    out = seed(a.dumps, a.force, a.seed)
    print(f"seeded {out['dumps']} dumps, {out['items']} items, {out['links']} links into {os.environ['BRAINDUMP_LITE_DATA']}")


if __name__ == "__main__":
    main()
