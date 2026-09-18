"""Obsidian-compatible markdown export (Phase 6). One file per dump with YAML
frontmatter; concepts/people become [[wikilinks]] when enabled."""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import db

_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _local(iso: str) -> datetime:
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return datetime.now()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def _safe_title(title: str) -> str:
    t = _BAD.sub("", title or "Untitled").strip().rstrip(".")
    return (t or "Untitled")[:60]


def _names(raw) -> list[str]:
    try:
        return [str(n) for n in json.loads(raw or "[]")]
    except (ValueError, TypeError):
        return []


def _link(name: str, wikilinks: bool) -> str:
    return f"[[{name}]]" if wikilinks else name


def _yaml_list(names: list[str], wikilinks: bool) -> str:
    if not names:
        return "[]"
    return "[" + ", ".join(f'"{_link(n, wikilinks)}"' for n in names) + "]"


def dump_markdown(dump_id: str, wikilinks: bool = True) -> tuple[str, str]:
    d = db.query_one("SELECT * FROM dumps WHERE id=?", (dump_id,))
    if not d:
        raise ValueError("unknown dump")
    items = db.query("SELECT * FROM items WHERE dump_id=? AND status != 'rejected' ORDER BY created_at", (dump_id,))
    dt = _local(d["created_at"])
    concepts, people = _names(d["concepts"]), _names(d["people"])
    tone = None
    try:
        tone = json.loads(d["tone"]) if d["tone"] else None
    except (ValueError, TypeError):
        pass
    title = d["title"] or "Untitled"
    fm = ["---", f"id: {d['id']}", f"created: {dt.isoformat(timespec='minutes')}", f"mode: {d['mode']}", "source: braindump-lite"]
    if tone:
        fm.append(f"tone: {tone.get('label')} (valence {tone.get('valence', 0)}, energy {tone.get('energy', 1)})")
    if d["provider"]:
        fm.append(f"provider: {d['provider']}")
    fm.append(f"concepts: {_yaml_list(concepts, wikilinks)}")
    fm.append(f"people: {_yaml_list(people, wikilinks)}")
    fm.append("---")
    lines = fm + ["", f"# {title}", ""]
    if d["summary"]:
        lines += [d["summary"].strip(), ""]
    if items:
        lines.append("## Items")
        for it in items:
            extra = []
            if it["est_minutes"]:
                extra.append(f"~{it['est_minutes']}m")
            if it["urgency"]:
                extra.append(f"urgency {it['urgency']}")
            if it["due_date"]:
                extra.append(f"due {it['due_date']}")
            suffix = f" ({', '.join(extra)})" if extra else ""
            if it["kind"] in ("task", "goal"):
                lines.append(f"- [{'x' if it['done'] else ' '}] {it['content']}{suffix}")
            else:
                lines.append(f"- **{it['kind']}:** {it['content']}{suffix}")
            if it["detail"]:
                lines.append(f"  - {it['detail']}")
        lines.append("")
    if concepts or people:
        lines.append("## Links")
        lines.append(" · ".join(_link(n, wikilinks) for n in concepts + people))
        lines.append("")
    if d["reflection"]:
        lines += ["## Reflection", d["reflection"].strip(), ""]
    lines += ["## Text", (d["clean_text"] or d["raw_text"] or "").strip(), ""]
    filename = f"{dt.strftime('%Y-%m-%d %H%M')} {_safe_title(title)}.md"
    return filename, "\n".join(lines)


def all_ready_ids() -> list[str]:
    return [r["id"] for r in db.query("SELECT id FROM dumps WHERE status='ready' ORDER BY created_at")]


def vault_markdown_zip(wikilinks: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        used: set[str] = set()
        for did in all_ready_ids():
            name, text = dump_markdown(did, wikilinks)
            if name in used:
                name = name[:-3] + f" {did[:6]}.md"
            used.add(name)
            z.writestr("dumps/" + name, text)
    return buf.getvalue()


def write_all(folder: str | Path, wikilinks: bool = True) -> int:
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    n = 0
    for did in all_ready_ids():
        name, text = dump_markdown(did, wikilinks)
        (folder / name).write_text(text, encoding="utf-8")
        n += 1
    return n
