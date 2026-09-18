"""CHANGELOG.md → structured entries for the in-app "What's New" panel.

The file is hand-written (see its header). Also runnable:
    python -m app.changelog 0.5.0    # prints that section; exit 1 if absent
which release.ps1 and CI use to turn the section into release notes.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_HEADING = re.compile(r"^##\s+v?(\d+\.\d+\.\d+)\s*(?:[-—–]+\s*(.*?))?\s*$")


def changelog_path() -> Path:
    # Dev: repo root. Frozen (PyInstaller onedir): _internal/ (sys._MEIPASS),
    # where build-backend.ps1 puts it via --add-data.
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "CHANGELOG.md"


def parse(text: str) -> list[dict]:
    entries: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        m = _HEADING.match(line)
        if m:
            cur = {"version": m.group(1), "date": (m.group(2) or "").strip(), "body": ""}
            entries.append(cur)
        elif cur is not None:
            cur["body"] += line + "\n"
    for e in entries:
        e["body"] = e["body"].strip()
    return entries


def load() -> list[dict]:
    try:
        return parse(changelog_path().read_text(encoding="utf-8"))
    except OSError:
        return []


def section(version: str) -> str:
    for e in load():
        if e["version"] == version:
            return e["body"]
    return ""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.changelog X.Y.Z")
    body = section(sys.argv[1])
    if not body:
        sys.exit(f"CHANGELOG.md has no '## {sys.argv[1]}' section")
    print(body)
