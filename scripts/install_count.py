"""Approximate install count from GitHub's own public release stats.

No telemetry, no code in the app, nothing to opt into — this just reads the
download_count GitHub already publishes for every release asset, which is
data about the repo, not about any individual. Run anytime:

    python scripts/install_count.py

Two numbers come out, and they're both approximations:
  - Installer downloads: download_count on each *-setup.exe. The closest
    thing to "how many times has someone gotten the app", but a person who
    reinstalls, or downloads on a second PC, counts twice.
  - Update-check pings: download_count on each latest.json. Every installed
    copy fetches this on launch to check for updates (see native.js's
    checkForUpdates), so it's a rough recurring-usage signal — but one
    person who opens the app 50 times shows up as 50, not 1. Only the
    LATEST release's latest.json is actually being polled by installs
    running today; older ones are historical.

Neither number is a unique-user count — nothing in this app tracks that
individually, on purpose.
"""
from __future__ import annotations

import json
import sys
import urllib.request

REPO = "canyonwirthlin/BrainDumpLite"


def releases() -> list[dict]:
    out, page = [], 1
    while True:
        url = f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}"
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            batch = json.load(r)
        if not batch:
            break
        out.extend(batch)
        page += 1
    return out


def main() -> None:
    try:
        rels = releases()
    except Exception as e:
        sys.exit(f"Couldn't reach the GitHub API: {e}")
    installs = updates = 0
    rows = []
    for rel in rels:
        for asset in rel.get("assets", []):
            name = asset["name"]
            if name.endswith("-setup.exe"):
                installs += asset["download_count"]
                rows.append((rel["tag_name"], name, asset["download_count"]))
            elif name == "latest.json":
                updates += asset["download_count"]
    print(f"{REPO}: {len(rels)} release(s)\n")
    for tag, name, n in rows:
        print(f"  {tag:>10}  {name:<40} {n:>5} download(s)")
    print(f"\nInstaller downloads (total, all releases): {installs}")
    print(f"Update-check pings   (total, all releases): {updates}")


if __name__ == "__main__":
    main()
