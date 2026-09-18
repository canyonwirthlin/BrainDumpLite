"""Process-level helpers for run.py, kept importable so they can be tested.

run.py is the PyInstaller entry point and stays dumb; anything with logic
lives here.
"""
from __future__ import annotations

import ctypes
import os
import shutil
import socket
import sys
import threading
from pathlib import Path
from typing import Callable, Mapping


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


def sidecar_mode(env: Mapping[str, str] = os.environ) -> bool:
    """True when the native shell launched us (no console, no browser)."""
    return env.get("BRAINDUMP_LITE_SIDECAR") == "1"


def pick_port(env: Mapping[str, str] = os.environ, start: int = 8756, span: int = 25) -> int:
    """The shell chooses the port (so it knows where to point the window);
    standalone mode scans the historical 8756-8780 range. 0 = let the OS pick."""
    forced = env.get("BRAINDUMP_LITE_PORT")
    if forced:
        return int(forced)
    for p in range(start, start + span):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def redirect_output(log_dir: Path) -> Path:
    """A sidecar has no console. Send stdout/stderr to <log_dir>/backend.log,
    keeping the previous run as backend.log.1 so a crash-on-boot is readable."""
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / "backend.log"
    try:
        if log.exists():
            log.replace(log_dir / "backend.log.1")
    except OSError:
        pass
    f = open(log, "a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = f
    sys.stderr = f
    return log


def watch_parent(pid: int, on_exit: Callable[[], None]) -> threading.Thread | None:
    """Call on_exit when the process that launched us dies, so a backend can
    never outlive the shell (e.g. shell crashed, or Task Manager killed it).
    Holding a real process HANDLE means PID reuse can't fool us."""
    if os.name != "nt":
        return None  # Windows-only v1; posix gets prctl(PR_SET_PDEATHSIG) later
    SYNCHRONIZE = 0x00100000
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(SYNCHRONIZE, False, int(pid))
    if not handle:
        return None

    def wait() -> None:
        k32.WaitForSingleObject(handle, 0xFFFFFFFF)  # INFINITE
        on_exit()

    t = threading.Thread(target=wait, daemon=True, name="parent-watchdog")
    t.start()
    return t
