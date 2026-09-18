"""[[wikilink]] syntax in dump text (Phase 6). Explicit links are honoured by
the pipeline (added to concepts/people) and rendered by the markdown export."""
from __future__ import annotations

import re

WIKI = re.compile(r"\[\[([^\]\|#\n]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]")


def extract(text: str) -> list[str]:
    out, seen = [], set()
    for m in WIKI.finditer(text or ""):
        name = m.group(1).strip()[:60]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


def merge(raw_text: str, people: list[str], concepts: list[str], known_people: set[str]) -> tuple[list[str], list[str]]:
    """Add explicit [[links]] to the extracted lists: a link that matches a known
    person (case-insensitive) is a person, anything else is a concept."""
    people, concepts = list(people), list(concepts)
    have_p = {p.lower() for p in people}
    have_c = {c.lower() for c in concepts}
    for name in extract(raw_text):
        k = name.lower()
        if k in known_people or k in have_p:
            if k not in have_p:
                people.append(name); have_p.add(k)
        elif k not in have_c:
            concepts.append(name); have_c.add(k)
    return people[:12], concepts[:12]
