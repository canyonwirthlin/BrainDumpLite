"""Process-level helpers for run.py, kept importable so they can be tested.

run.py is the PyInstaller entry point and stays dumb; anything with logic
lives here.
"""
from __future__ import annotations

import shutil
from pathlib import Path


def remove_legacy_bundles(data_dir: Path) -> None:
    """Pre-native-shell versions downloaded code bundles into <data>/code/<ver>
    and always booted the newest one. The native app ships whole builds, so
    those folders are dead weight — and dangerous, because an old loader would
    prefer them over the installed code. Delete them; never fail over it."""
    shutil.rmtree(data_dir / "code", ignore_errors=True)
    try:
        (data_dir / "update_ready.txt").unlink(missing_ok=True)
    except OSError:
        pass
