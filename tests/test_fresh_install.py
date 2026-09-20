"""A fresh install must start with an empty history: no dumps, items, links,
conversations, suggestions or reflections seeded by the app or left over from the build."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USER_TABLES = ("dumps", "items", "links", "sessions", "session_items", "suggestions", "reflections", "runs")


def test_new_data_dir_has_no_user_content():
    with tempfile.TemporaryDirectory(prefix="bdl-fresh-") as data:
        code = (
            "from app.main import create_app; create_app()\n"
            "from app import db\n"
            f"for t in {USER_TABLES!r}:\n"
            "    print(t, db.query_one(f'SELECT COUNT(*) AS n FROM {t}')['n'])\n"
        )
        r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True,
                           env={**os.environ, "BRAINDUMP_LITE_DATA": data}, timeout=120)
        assert r.returncode == 0, r.stderr
        counts = dict(line.split() for line in r.stdout.strip().splitlines() if line.split()[0] in USER_TABLES)
        assert counts == {t: "0" for t in USER_TABLES}


def test_no_database_files_are_tracked_or_bundled():
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    assert not [f for f in tracked if f.lower().endswith((".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm"))]
    # what PyInstaller bundles (build-backend.ps1 / braindump-backend.spec): code + static assets, never tests or data
    spec = (ROOT / "braindump-backend.spec")
    if spec.exists():
        text = spec.read_text(encoding="utf-8")
        assert "'tests'" not in text and ".db" not in text
