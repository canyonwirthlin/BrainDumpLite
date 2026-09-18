# Phase 1: Native Shell Migration (Tauri + Python sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship BrainDump Lite as a real Windows app: a Tauri window + tray icon wrapping the unchanged FastAPI backend as a sidecar, installed by an NSIS installer, updated by a provider-agnostic updater that shows a hand-written changelog as "What's New".

**Architecture:** The Python backend (FastAPI + SQLite + engine.py) is frozen with PyInstaller into `src-tauri/backend/` and bundled as a Tauri *resource*. On launch the Rust shell picks a free port, spawns `backend/braindump-backend.exe` with `BRAINDUMP_LITE_SIDECAR=1` + the port + its own PID, waits for the port to accept connections, then navigates the single WebView2 window to `http://127.0.0.1:<port>/`. The backend watches the shell's PID and exits when the shell dies; the shell kills the backend on Quit. Tauri's updater plugin polls a static `latest.json` (hosted on GitHub Releases for v1, but any static URL works) whose `notes` come from `CHANGELOG.md`; the SPA (which gets `window.__TAURI__` injected) drives the update UI in JS so the Rust surface stays boilerplate.

**Tech Stack:** Python 3.14 + PyInstaller 6 (existing), Tauri 2 (Rust stable, MSVC), `tauri-plugin-updater`, `tauri-plugin-process`, `tauri-plugin-opener`, NSIS bundler (auto-downloaded by Tauri), `@tauri-apps/cli` via npm, pytest, GitHub Actions + `tauri-apps/tauri-action`.

## Global Constraints

- **Windows only for v1.** Don't add Mac/Linux targets, but don't write Windows-only code where a `#[cfg(windows)]` guard is free.
- **Ship unsigned.** No Authenticode. (The updater's *minisign* signature is separate, free, and required by Tauri — that one we do use.)
- **Minimal Rust surface.** Rust files are boilerplate/config only: window, tray, sidecar spawn, plugin registration. Every Rust file gets a top comment explaining what it does. Anything with logic goes in Python or JS.
- **Keep the FastAPI backend, DB layer, `engine.py`, classify pipeline and vanilla JS frontend exactly as they are** apart from the additions in this plan.
- **System tray icon is in v1. Global-hotkey quick-capture is NOT.** Don't build it.
- **Updater is provider-agnostic and changelog-first.** Changelog entries are written by hand in `CHANGELOG.md`; the release script refuses to release without one. The app shows the entry as "What's New".
- **Data dir is unchanged:** `%LOCALAPPDATA%\BrainDumpLite` (`app/db.py:data_dir`). Friends' existing data must carry over into the installed app untouched.
- **Ports:** web app 8756-8780, llama chat 8790+, embed 8820. Keep clear.
- **Old OTA mechanism must be fully removed** (`app/updater.py`, `<data>/code/<version>` bundle loading in `run.py`): the old loader picks *any* disk bundle over the seed, which would make a Tauri-installed app boot stale legacy code.
- **Commit after every task.** Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Dev machine has Avast** (memory `canyon-machine-avast-and-gpu`): it quarantines unsigned exes on first run. Expect it to eat freshly-built `braindump-backend.exe` / `BrainDump Lite.exe`; the fix is an Avast exclusion for the repo folder and `%LOCALAPPDATA%\BrainDump Lite`.

## Decisions made while planning (flag to the user, don't re-litigate)

- **Resource folder + `std::process::Command`, not `tauri-plugin-shell` sidecars.** PyInstaller *onedir* needs its `_internal/` folder next to the exe; the shell plugin's sidecar feature moves a single exe around and would break that. Bundling the whole `backend/` folder as a resource and spawning it with std Rust is simpler and has one less plugin.
- **Close button hides to tray; tray → Quit exits.** Convention for tray apps, and it keeps the llama-server warm. Trade-off: a "closed" app still holds VRAM. Flip it by deleting the `on_window_event` handler in `src-tauri/src/lib.rs` (one block). Make it a setting in Phase 2.
- **Update UI lives in JS** (`window.__TAURI__.updater`), enabled by `withGlobalTauri` + a capability for the `http://127.0.0.1:*` origin. This keeps Rust free of async/error-handling code.
- **GitHub Releases hosts `latest.json` + installer for v1.** The updater config is a single URL; moving hosts later is a one-line change.
- **Python 3.14** in CI to match the local venv (av/ctranslate2 cp314 wheels are proven locally).

## File structure

```
CHANGELOG.md                     hand-written release notes (source of "What's New")
build-backend.ps1                PyInstaller -> src-tauri/backend/  (replaces build.ps1)
release.ps1                      bump versions, verify changelog, commit, tag, push
requirements-dev.txt             pytest
package.json / package-lock.json @tauri-apps/cli only
run.py                           backend entry: sidecar or standalone mode (rewritten, smaller)
app/launch.py                    NEW: sidecar helpers (port, log redirect, parent watchdog, legacy cleanup)
app/changelog.py                 NEW: CHANGELOG.md parser + `python -m app.changelog X.Y.Z`
app/routes.py                    + GET /api/changelog, - update_ready
static/app.js                    + native bridge (external links, updater UI, What's New, About)
static/index.html                update pill becomes the updater trigger
static/style.css                 + modal + progress styles
shell-ui/index.html              splash page shown while the backend boots
shell-ui/icon.svg                icon source (tauri icon generates src-tauri/icons/*)
src-tauri/Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json
src-tauri/src/main.rs            2 lines
src-tauri/src/lib.rs             builder: plugins, setup (spawn+navigate), close-to-tray, kill on exit
src-tauri/src/backend.rs         pick_port / exe_path / spawn / wait_ready / stop
src-tauri/src/tray.rs            tray icon + menu
.github/workflows/release.yml    tag push -> test, build backend, tauri-action release
tests/conftest.py, tests/test_launch.py, tests/test_changelog.py, tests/test_api.py
DELETED: app/updater.py, update_url.txt, push-update.bat, push-update.ps1, build.ps1, SHARING.md, update/
```

---

### Task 1: Toolchain + repo hygiene

**Files:**
- Modify: `.gitignore`
- Create: `requirements-dev.txt`, `tests/conftest.py`, `tests/test_smoke.py`
- Untrack (keep on disk): `BrainDumpLite-win64/`, `update/`

**Interfaces:**
- Produces: `pytest` runnable from repo root with `BRAINDUMP_LITE_DATA` pointed at a temp dir (all later Python tests rely on `tests/conftest.py`).

- [x] **Step 1: Install the Rust toolchain (one-time, user machine).** Rust on Windows needs the MSVC linker. None of `cargo`, `cl.exe`, or the Windows SDK are installed. Run in an elevated PowerShell (the user approves each download; both installers are Microsoft/Rust-signed):

```powershell
# 1) Visual Studio Build Tools with the C++ workload (~3 GB, 10-20 min)
Invoke-WebRequest https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile "$env:TEMP\vs_BuildTools.exe"
& "$env:TEMP\vs_BuildTools.exe" --passive --norestart --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
# 2) rustup (stable MSVC toolchain)
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable-x86_64-pc-windows-msvc
```

Open a NEW terminal afterwards (PATH changed). Verify:

```powershell
cargo --version; rustc --version
```
Expected: both print a version (1.8x+).

- [x] **Step 2: Add an Avast exclusion** (user does this in Avast UI: Menu → Settings → General → Exceptions → Add): the repo folder `C:\Users\canyo\Desktop\Home\Coding\BrainDumpLite` and `%LOCALAPPDATA%\BrainDump Lite`. Without this, Avast will quarantine `target\debug\braindump-lite.exe` and the PyInstaller exe on first run.

- [x] **Step 3: Stop tracking build artifacts and ignore new build dirs.** The 244 MB `BrainDumpLite-win64/` folder and `update/update.bin` are committed. Untrack them (files stay on disk):

```bash
git rm -r --cached BrainDumpLite-win64 update
```

Replace `.gitignore` with:

```gitignore
.venv/
dist/
build/
*.spec
__pycache__/
*.pyc
.pytest_cache/
BrainDumpLite-win64.zip
BrainDumpLite-win64/
update/
node_modules/
src-tauri/target/
src-tauri/backend/
src-tauri/gen/schemas/
*.log
```

- [x] **Step 4: Add pytest.** Create `requirements-dev.txt`:

```
pytest>=8
httpx>=0.27
```

Create `tests/conftest.py`:

```python
"""Every test gets its own empty data dir so nothing touches the real
%LOCALAPPDATA%\\BrainDumpLite. Must run before `app.db` is imported."""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="bdl-test-")
os.environ["BRAINDUMP_LITE_DATA"] = _TMP
os.environ.pop("BRAINDUMP_LITE_UPDATE_URL", None)
```

Create `tests/test_smoke.py`:

```python
from app.version import __version__


def test_version_is_semver():
    parts = __version__.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts)
```

- [x] **Step 5: Run the tests**

```bash
.venv/Scripts/python -m pip install -q -r requirements-dev.txt && .venv/Scripts/python -m pytest -q
```
Expected: `1 passed`.

- [x] **Step 6: Commit**

```bash
git add .gitignore requirements-dev.txt tests/
git commit -m "chore: untrack build artifacts, add pytest scaffold for native shell work

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Remove the legacy code-bundle OTA

**Files:**
- Delete: `app/updater.py`, `update_url.txt`, `push-update.bat`, `push-update.ps1`, `SHARING.md`
- Modify: `app/routes.py:15-16,53-64`, `static/app.js:210-222`, `static/index.html:26`, `build.ps1` (drop `-Bundle` + `update_url.txt`), `README.md` (drop OTA paragraphs)
- Create: `app/launch.py`, `tests/test_launch.py` (legacy-cleanup helper only; the rest of the module comes in Task 3)

**Interfaces:**
- Produces: `app.launch.remove_legacy_bundles(data_dir: Path) -> None`.
- Removes: `updater.ready_version()`, the `update_ready` key in `GET /api/status`.

- [x] **Step 1: Tag the last OTA-capable commit** so Task 12 can build one final legacy bundle from it:

```bash
git tag legacy-ota
```

- [x] **Step 2: Write the failing test** — `tests/test_launch.py`:

```python
from pathlib import Path

from app import launch


def test_remove_legacy_bundles_deletes_code_dir_and_marker(tmp_path: Path):
    (tmp_path / "code" / "0.4.4" / "app").mkdir(parents=True)
    (tmp_path / "code" / "0.4.4" / "app" / "__init__.py").write_text("")
    (tmp_path / "update_ready.txt").write_text("0.4.4")
    launch.remove_legacy_bundles(tmp_path)
    assert not (tmp_path / "code").exists()
    assert not (tmp_path / "update_ready.txt").exists()


def test_remove_legacy_bundles_is_noop_when_nothing_there(tmp_path: Path):
    launch.remove_legacy_bundles(tmp_path)  # must not raise
```

- [x] **Step 3: Run it to verify it fails**

```bash
.venv/Scripts/python -m pytest tests/test_launch.py -q
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.launch'`.

- [x] **Step 4: Create `app/launch.py`** (first piece; Task 3 extends it):

```python
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
```

- [x] **Step 5: Delete the OTA files**

```bash
git rm app/updater.py update_url.txt push-update.bat push-update.ps1 SHARING.md
```

- [x] **Step 6: Remove OTA references from the backend.** In `app/routes.py`:
  - line 15: `from . import ai, db, engine, pipeline, transcribe, updater` → `from . import ai, db, engine, pipeline, transcribe`
  - in `status()`: delete the line `"update_ready": updater.ready_version(),  # null, or "0.3.1" → restart to apply`

- [x] **Step 7: Remove OTA references from the frontend.** In `static/app.js` `refreshStatus()` delete the line `$("#update-pill").style.display = status.update_ready ? "" : "none";`. In `static/index.html` replace the `#update-pill` span with (Task 9 wires it up):

```html
  <span id="update-pill" class="pill update" style="display:none;cursor:pointer" title="Click to see what's new and install">⬆ update</span>
```

- [x] **Step 8: Trim `build.ps1`.** Delete the `-Bundle` branch (from `if ($Bundle) {` through its `exit 0 }`), the `param` `-Bundle` switch, the `update_url.txt` creation block, the `'--add-data', 'update_url.txt;.'` line, and the "Live-update flow" comment paragraph. (Task 5 replaces this script entirely; this step just keeps the tree consistent.) In `README.md` delete the sentence(s) about `push-update` / live updates under "Build & ship" and the `updater.py` line in the repo layout.

- [x] **Step 9: Run tests + a boot check**

```bash
.venv/Scripts/python -m pytest -q && grep -rn "updater\|update_url\|update_ready" app static run.py build.ps1 README.md ; echo "grep exit $? (1 = clean)"
```
Expected: `3 passed`; grep prints only `run.py` hits (run.py still has the old loader — Task 3 rewrites it) and nothing else.

- [x] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove code-bundle OTA updater (native shell ships whole builds)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Backend sidecar mode (`run.py` + `app/launch.py`)

**Files:**
- Modify: `app/launch.py`, `tests/test_launch.py`
- Rewrite: `run.py`

**Interfaces:**
- Consumes env vars set by the shell (Task 7): `BRAINDUMP_LITE_SIDECAR=1`, `BRAINDUMP_LITE_PORT=<int>`, `BRAINDUMP_LITE_PARENT_PID=<int>`.
- Produces in `app.launch`: `sidecar_mode(env=os.environ) -> bool`, `pick_port(env=os.environ, start=8756, span=25) -> int`, `redirect_output(log_dir: Path) -> Path`, `watch_parent(pid: int, on_exit: Callable[[], None]) -> threading.Thread | None`.
- Log file location the splash page names: `<data>/logs/backend.log`.

- [x] **Step 1: Write the failing tests** — append to `tests/test_launch.py`:

```python
import os
import socket
import subprocess
import sys
import threading

import pytest


def test_sidecar_mode_reads_env():
    assert launch.sidecar_mode({"BRAINDUMP_LITE_SIDECAR": "1"}) is True
    assert launch.sidecar_mode({}) is False


def test_pick_port_honours_forced_port():
    assert launch.pick_port({"BRAINDUMP_LITE_PORT": "9123"}) == 9123


def test_pick_port_finds_free_port_in_range():
    p = launch.pick_port({}, start=8756, span=25)
    assert 8756 <= p < 8781
    with socket.socket() as s:
        s.bind(("127.0.0.1", p))  # must still be free


def test_redirect_output_writes_log_and_keeps_previous(tmp_path):
    out, err = sys.stdout, sys.stderr
    try:
        log = launch.redirect_output(tmp_path / "logs")
        print("hello-log")
        sys.stdout.flush()
        assert log == tmp_path / "logs" / "backend.log"
        assert "hello-log" in log.read_text(encoding="utf-8")
        sys.stdout.close()
        launch.redirect_output(tmp_path / "logs")
        assert "hello-log" in (tmp_path / "logs" / "backend.log.1").read_text(encoding="utf-8")
        sys.stdout.close()
    finally:
        sys.stdout, sys.stderr = out, err


@pytest.mark.skipif(os.name != "nt", reason="parent watchdog is Windows-only in v1")
def test_watch_parent_fires_when_process_exits():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    fired = threading.Event()
    try:
        t = launch.watch_parent(child.pid, on_exit=fired.set)
        assert t is not None and not fired.is_set()
        child.kill()
        assert fired.wait(5), "watchdog did not notice parent death"
    finally:
        child.kill()
```

- [x] **Step 2: Run to verify they fail**

```bash
.venv/Scripts/python -m pytest tests/test_launch.py -q
```
Expected: 5 new FAIL with `AttributeError: module 'app.launch' has no attribute ...`.

- [x] **Step 3: Extend `app/launch.py`** — add these imports at the top and the functions below `remove_legacy_bundles`:

```python
import ctypes
import os
import socket
import sys
import threading
from typing import Callable, Mapping


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
```

- [x] **Step 4: Run the tests**

```bash
.venv/Scripts/python -m pytest tests/test_launch.py -q
```
Expected: `7 passed`.

- [x] **Step 5: Rewrite `run.py`** (whole file):

```python
"""BrainDump Lite backend entry point — the PyInstaller target.

Two ways to run:
  * Sidecar (normal): the native shell (src-tauri/) starts this exe with
    BRAINDUMP_LITE_SIDECAR=1, BRAINDUMP_LITE_PORT=<port> and
    BRAINDUMP_LITE_PARENT_PID=<shell pid>. No console, no browser: output
    goes to <data>/logs/backend.log and we exit when the shell exits.
  * Standalone (dev / debugging): `python run.py` picks a free port and
    opens the system browser, like the pre-native-shell app did.
"""
import os
import sys
import threading
import traceback
import webbrowser
from datetime import datetime

# Windows consoles default to cp1252; don't let a fancy character crash the app.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Use the OS certificate store for all TLS (model downloads, API calls).
# certifi alone breaks on machines with AV or corporate TLS interception.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

from app import db, engine, launch  # noqa: E402
from app.main import create_app  # noqa: E402
from app.version import __version__  # noqa: E402


def main() -> None:
    sidecar = launch.sidecar_mode()
    data = db.data_dir()
    if sidecar:
        launch.redirect_output(data / "logs")
        ppid = os.environ.get("BRAINDUMP_LITE_PARENT_PID")
        if ppid:
            launch.watch_parent(int(ppid), on_exit=lambda: (engine.stop_all(), os._exit(0)))
    launch.remove_legacy_bundles(data)
    try:
        _serve(sidecar)
    except SystemExit:
        raise
    except Exception:
        # Crash shield: write the traceback somewhere a human can find it.
        traceback.print_exc()
        try:
            log = data / "launcher-crash.log"
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"\n--- crash at {datetime.now().isoformat()} ---\n")
                f.write(traceback.format_exc())
            print(f"\n  BrainDump Lite could not start. Details saved to:\n    {log}")
        except Exception:
            pass
        if not sidecar:
            try:
                input("\n  Press Enter to close this window... ")
            except (EOFError, OSError):
                pass
        sys.exit(1)


def _serve(sidecar: bool) -> None:
    app = create_app()
    port = launch.pick_port()
    url = f"http://127.0.0.1:{port}"
    print(f"BrainDump Lite v{__version__} — serving at {url} ({'sidecar' if sidecar else 'standalone'})", flush=True)
    import uvicorn
    if not sidecar:
        print("KEEP THIS WINDOW OPEN while using the app. Close it to quit.", flush=True)
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
```

- [x] **Step 6: Verify both modes by hand.** Standalone (Ctrl+C to stop after the browser opens):

```bash
.venv/Scripts/python run.py
```
Expected: prints `serving at http://127.0.0.1:8756 (standalone)`, browser opens the app.

Sidecar (in PowerShell; the parent PID is the PowerShell process itself):

```powershell
$env:BRAINDUMP_LITE_SIDECAR="1"; $env:BRAINDUMP_LITE_PORT="8777"; $env:BRAINDUMP_LITE_PARENT_PID="$PID"
$p = Start-Process -PassThru .\.venv\Scripts\python.exe run.py
Start-Sleep 4; (Invoke-WebRequest http://127.0.0.1:8777/api/status).Content
Get-Content "$env:LOCALAPPDATA\BrainDumpLite\logs\backend.log" -Tail 3
Stop-Process $p.Id
Remove-Item Env:BRAINDUMP_LITE_SIDECAR, Env:BRAINDUMP_LITE_PORT, Env:BRAINDUMP_LITE_PARENT_PID
```
Expected: JSON with `"version":"0.4.3"` and no `update_ready`; the log tail shows the `serving at ... (sidecar)` line; no browser tab opened.

- [x] **Step 7: Run the whole suite, then commit**

```bash
.venv/Scripts/python -m pytest -q
git add run.py app/launch.py tests/test_launch.py
git commit -m "feat(backend): sidecar mode - forced port, file logging, parent watchdog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: CHANGELOG.md + `/api/changelog` + "What's New" panel

**Files:**
- Create: `CHANGELOG.md`, `app/changelog.py`, `tests/test_changelog.py`, `tests/test_api.py`
- Modify: `app/routes.py` (new route), `static/app.js` (What's New modal + About section), `static/style.css` (modal styles)

**Interfaces:**
- Produces: `app.changelog.parse(text) -> list[dict(version, date, body)]`, `app.changelog.load() -> list[dict]`, `app.changelog.section(version) -> str`, CLI `python -m app.changelog X.Y.Z` (prints the section, exit 1 if missing — used by `release.ps1` and CI).
- Produces: `GET /api/changelog` → `{"version": "<running>", "entries": [...]}`.
- Produces in JS: `showWhatsNew(version)`, `maybeShowWhatsNew()`, CSS classes `.modal-bg`, `.modal`, `.progress`.

- [x] **Step 1: Write the failing tests.** `tests/test_changelog.py`:

```python
from app import changelog

SAMPLE = """# Changelog

## 0.5.0 — 2026-09-20
- Native Windows app with installer and tray icon.
- Automatic updates with release notes.

## 0.4.3 - 2026-07-20
Built-in AI engine.
"""


def test_parse_splits_versions_and_bodies():
    entries = changelog.parse(SAMPLE)
    assert [e["version"] for e in entries] == ["0.5.0", "0.4.3"]
    assert entries[0]["date"] == "2026-09-20"
    assert entries[0]["body"].startswith("- Native Windows app")
    assert entries[1]["body"] == "Built-in AI engine."


def test_parse_accepts_v_prefix_and_no_date():
    assert changelog.parse("## v1.2.3\nhi")[0] == {"version": "1.2.3", "date": "", "body": "hi"}


def test_section_returns_empty_for_unknown(monkeypatch):
    monkeypatch.setattr(changelog, "load", lambda: changelog.parse(SAMPLE))
    assert changelog.section("0.5.0").startswith("- Native")
    assert changelog.section("9.9.9") == ""


def test_real_changelog_has_current_version():
    from app.version import __version__
    assert changelog.section(__version__), f"CHANGELOG.md needs a '## {__version__}' section"
```

`tests/test_api.py`:

```python
from fastapi.testclient import TestClient

from app.main import create_app
from app.version import __version__


def test_changelog_endpoint_lists_entries():
    client = TestClient(create_app())
    r = client.get("/api/changelog")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == __version__
    assert body["entries"][0]["version"] == __version__


def test_status_has_no_legacy_update_key():
    client = TestClient(create_app())
    assert "update_ready" not in client.get("/api/status").json()
```

- [x] **Step 2: Run to verify they fail**

```bash
.venv/Scripts/python -m pytest tests/test_changelog.py tests/test_api.py -q
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.changelog'` and 404 on `/api/changelog`.

- [x] **Step 3: Create `CHANGELOG.md`** (the current version needs an entry so the test above passes; the 0.5.0 entry is written for real in Task 11):

```markdown
# Changelog

Written by hand before every release. The section for the version being
released becomes the GitHub release notes AND the "What's New" panel in the
app. Format: `## X.Y.Z — YYYY-MM-DD`, then markdown. Newest first.

## 0.4.3 — 2026-07-20
- Built-in local AI engine (llama.cpp) with curated models picked by VRAM.
- Semantic search via a bundled embedding model.
```

- [x] **Step 4: Create `app/changelog.py`**

```python
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
```

- [x] **Step 5: Add the route** in `app/routes.py`. Change the import line to `from . import ai, changelog, db, engine, pipeline, transcribe` and add directly under the `status()` function:

```python
@router.get("/changelog")
def get_changelog():
    return {"version": VERSION, "entries": changelog.load()}
```

- [x] **Step 6: Run the tests**

```bash
.venv/Scripts/python -m pytest -q && .venv/Scripts/python -m app.changelog 0.4.3
```
Expected: all pass; CLI prints the two 0.4.3 bullets.

- [x] **Step 7: Frontend — modal styles.** Append to `static/style.css` (check `grep -n "modal" static/style.css` first; if a `.modal` class already exists, reuse its name instead of adding a second one):

```css
/* ── Modal (What's New / update) ─────────────────────────────────────────── */
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex;
  align-items: center; justify-content: center; z-index: 50; padding: 16px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  max-width: 560px; width: 100%; max-height: 80vh; overflow: auto; padding: 22px 24px; }
.modal h2 { margin-top: 0; }
.modal .md { margin-bottom: 16px; }
.progress { height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; margin: 12px 0; }
.progress > i { display: block; height: 100%; width: 0; transition: width .2s;
  background: var(--accent, var(--amber)); }
```

- [x] **Step 8: Frontend — What's New.** In `static/app.js`, add a new section just above `// ── Capture ──`:

```js
// ── What's New (hand-written CHANGELOG.md, served by /api/changelog) ────────

function maybeShowWhatsNew() {
  const cur = status.version;
  if (!cur) return;
  let seen = null;
  try { seen = localStorage.getItem("bdl-seen-version"); } catch {}
  try { localStorage.setItem("bdl-seen-version", cur); } catch {}
  if (seen && seen !== cur) showWhatsNew(cur);   // first-ever run: store silently
}

async function showWhatsNew(version) {
  let entries = [];
  try { entries = (await api.get("/changelog")).entries; } catch {}
  const e = entries.find((x) => x.version === version) || entries[0];
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">
    <h2>What's new in v${esc(version)}</h2>
    <div class="md">${e ? md(e.body) : `<p class="muted">No notes for this version.</p>`}</div>
    <div class="row"><button class="btn" id="wn-ok">Nice</button></div></div>`;
  document.body.appendChild(bg);
  $("#wn-ok", bg).onclick = () => bg.remove();
}
```

Then find the app's startup code at the bottom of `app.js` (the first call to `refreshStatus()`) and make the What's New check run after it, e.g. change `refreshStatus();` to `refreshStatus().then(maybeShowWhatsNew);`. (Verify `md()` at `static/app.js:172` returns an HTML string; it is used with `innerHTML` elsewhere.)

- [x] **Step 9: Frontend — About section in Settings.** In `renderSettings()`'s template, insert immediately before the line starting `<p class="small muted">Data lives in`:

```js
      <h2>About</h2>
      <div class="card">
        <p class="small" style="margin-bottom:12px">BrainDump Lite <b>v${esc(status.version || "?")}</b></p>
        <div class="row" style="margin:0">
          <button class="btn ghost" id="about-whatsnew">What's new</button>
        </div>
      </div>
```

and after the `$("#save").onclick = ...` block add:

```js
    $("#about-whatsnew").onclick = () => showWhatsNew(status.version);
```

- [x] **Step 10: Verify in the browser.** Run `.venv/Scripts/python run.py`, open Settings → "What's new" shows the 0.4.3 notes in a modal; "Nice" closes it. In devtools run `localStorage.setItem("bdl-seen-version","0.0.1")` and reload → modal appears automatically once; reload again → it doesn't.

- [x] **Step 11: Commit**

```bash
git add CHANGELOG.md app/changelog.py app/routes.py static/ tests/
git commit -m "feat: hand-written CHANGELOG.md served as What's New in the app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `build-backend.ps1` (PyInstaller → `src-tauri/backend/`)

**Files:**
- Create: `build-backend.ps1`
- Delete: `build.ps1`
- Modify: `README.md` build section (`dev.ps1` is unchanged)

**Interfaces:**
- Produces: `src-tauri/backend/braindump-backend.exe` + `src-tauri/backend/_internal/` (contains `app/`, `static/`, `CHANGELOG.md`). Task 7's Rust code spawns exactly `backend/braindump-backend.exe`.

- [x] **Step 1: Create `build-backend.ps1`**

```powershell
# build-backend.ps1 - freeze the Python backend into src-tauri\backend\.
# (ASCII only: PowerShell 5.1 parses BOM-less files as cp1252.)
#
# The Tauri shell bundles that whole folder as a resource and spawns
# backend\braindump-backend.exe as a sidecar. Run this before
#   npm run tauri dev     (try the native app locally)
#   npm run tauri build   (make the installer)
# CI runs it too (.github\workflows\release.yml).
#
#   .\build-backend.ps1            # with voice (faster-whisper)
#   .\build-backend.ps1 -NoVoice   # smaller, no mic button
param([switch]$NoVoice)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv)) {
    Write-Host "Creating venv..." -ForegroundColor Cyan
    python -m venv .venv
}
$py = ".\.venv\Scripts\python.exe"

Write-Host "Installing dependencies..." -ForegroundColor Cyan
& $py -m pip install --quiet --disable-pip-version-check -r requirements.txt pyinstaller

$voiceOk = $false
if (-not $NoVoice) {
    & $py -m pip install --quiet --disable-pip-version-check -r requirements-voice.txt
    & $py -c "import faster_whisper" 2>$null
    if ($LASTEXITCODE -eq 0) { $voiceOk = $true }
    else { Write-Warning "faster-whisper unavailable - building WITHOUT voice." }
}

$args = @(
    '--noconfirm', '--clean', '--onedir',
    '--name', 'braindump-backend',
    '--distpath', 'src-tauri', '--workpath', 'build',
    '--add-data', 'app;app',
    '--add-data', 'static;static',
    '--add-data', 'CHANGELOG.md;.'
)
if ($voiceOk) {
    $args += @('--collect-all', 'faster_whisper', '--collect-all', 'ctranslate2', '--collect-all', 'av')
}
$args += 'run.py'

$version = (Select-String -Path "app\version.py" -Pattern '"([^"]+)"').Matches[0].Groups[1].Value
Write-Host "Running PyInstaller v$version (a few minutes)..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "src-tauri\backend" -ErrorAction SilentlyContinue
& ".\.venv\Scripts\pyinstaller.exe" @args
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
Rename-Item "src-tauri\braindump-backend" "backend"

$size = [math]::Round((Get-ChildItem "src-tauri\backend" -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Done -> src-tauri\backend\braindump-backend.exe ($size MB, voice=$voiceOk)" -ForegroundColor Green
```

- [x] **Step 2: Delete the old script and update README**

```bash
git rm build.ps1
```
In `README.md` "Build & ship", replace the `build.ps1` lines with `.\build-backend.ps1   # freezes the backend into src-tauri\backend\` (Task 11 rewrites the section fully).

- [x] **Step 3: Build and smoke-test the frozen backend** (PowerShell):

```powershell
.\build-backend.ps1
$env:BRAINDUMP_LITE_SIDECAR="1"; $env:BRAINDUMP_LITE_PORT="8778"; $env:BRAINDUMP_LITE_PARENT_PID="$PID"
$p = Start-Process -PassThru .\src-tauri\backend\braindump-backend.exe
Start-Sleep 6; (Invoke-WebRequest http://127.0.0.1:8778/api/changelog).Content
Stop-Process $p.Id
Remove-Item Env:BRAINDUMP_LITE_SIDECAR, Env:BRAINDUMP_LITE_PORT, Env:BRAINDUMP_LITE_PARENT_PID
```
Expected: JSON with the 0.4.3 entry (proves `CHANGELOG.md` shipped inside `_internal/`), `src-tauri\backend\_internal\static\index.html` exists. If Avast quarantines the exe, restore it and add the exclusion from Task 1 Step 2.

- [x] **Step 4: Commit**

```bash
git add build-backend.ps1 README.md
git commit -m "build: build-backend.ps1 freezes the backend into src-tauri/backend

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Tauri scaffold (window + splash, no backend yet)

**Files:**
- Create: `package.json`, `shell-ui/index.html`, `shell-ui/icon.svg`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/icons/*` (generated)

**Interfaces:**
- Produces: window label `"main"`; splash exposes `window.bdlFailed(logPath)`; crate name `braindump-lite`, lib `braindump_lite_lib`.
- Produces: `npm run tauri dev` / `npm run tauri build` as the two dev commands.

- [x] **Step 1: npm project for the Tauri CLI.** Create `package.json`:

```json
{
  "name": "braindump-lite-shell",
  "private": true,
  "description": "npm is only here to run the Tauri CLI. The frontend has no build step.",
  "scripts": {
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

```bash
npm install && npx tauri --version
```
Expected: prints `tauri-cli 2.x.y`. Commit `package-lock.json` too.

- [x] **Step 2: Splash page** `shell-ui/index.html` (the only "frontend" Tauri itself serves; the real UI comes from the backend):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BrainDump Lite</title>
<style>
  html, body { height: 100%; margin: 0; background: #0d1017; color: #cfd3dc;
    font: 15px system-ui, Segoe UI, sans-serif; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 14px; text-align: center; padding: 24px; box-sizing: border-box; }
  .spin { width: 28px; height: 28px; border: 3px solid #2a3142; border-top-color: #8b7cf6;
    border-radius: 50%; animation: r 0.9s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
  .err { display: none; max-width: 520px; line-height: 1.5; }
  .err code { background: #151b28; padding: 2px 6px; border-radius: 4px; user-select: all; }
</style>
</head>
<body>
<div class="wrap">
  <div class="spin" id="spin"></div>
  <div id="msg">Starting BrainDump Lite…</div>
  <div class="err" id="err">
    <p><b>The backend didn't start.</b></p>
    <p>Check the log at <code id="log"></code> and send it to whoever gave you the app.</p>
    <p>Quit from the tray icon and start the app again.</p>
  </div>
</div>
<script>
  // Called by the Rust shell (src-tauri/src/lib.rs) when the backend never came up.
  window.bdlFailed = function (logPath) {
    document.getElementById("spin").style.display = "none";
    document.getElementById("msg").style.display = "none";
    document.getElementById("log").textContent = logPath;
    document.getElementById("err").style.display = "block";
  };
</script>
</body>
</html>
```

- [x] **Step 3: Icon.** Create `shell-ui/icon.svg` (a simple graph motif; replace with real art later):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#8b7cf6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
  <rect width="512" height="512" rx="110" fill="#0d1017"/>
  <g stroke="url(#g)" stroke-width="22" fill="none" stroke-linecap="round">
    <line x1="160" y1="180" x2="352" y2="140"/><line x1="160" y1="180" x2="230" y2="360"/>
    <line x1="352" y1="140" x2="230" y2="360"/><line x1="352" y1="140" x2="380" y2="330"/>
  </g>
  <g fill="url(#g)">
    <circle cx="160" cy="180" r="46"/><circle cx="352" cy="140" r="38"/>
    <circle cx="230" cy="360" r="52"/><circle cx="380" cy="330" r="30"/>
  </g>
</svg>
```

```bash
npx tauri icon shell-ui/icon.svg -o src-tauri/icons
```
Expected: `src-tauri/icons/icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (plus mobile sizes; commit them all, they're small).

- [x] **Step 4: Rust crate.** `src-tauri/Cargo.toml`:

```toml
[package]
name = "braindump-lite"
version = "0.4.3"
description = "BrainDump Lite native shell"
edition = "2021"

# Tauri's template splits the crate into a lib (all the code) and a tiny main.
# That's what lets the same code build for mobile later; harmless on desktop.
[lib]
name = "braindump_lite_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-opener = "2"
```

`src-tauri/build.rs`:

```rust
// Runs at compile time: reads tauri.conf.json, embeds icons/resources,
// generates the capability schemas under gen/. Standard Tauri boilerplate.
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/main.rs`:

```rust
// Windows: without this line a release build opens a black console window
// next to the app. Debug builds keep the console so `println!` is visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    braindump_lite_lib::run();
}
```

`src-tauri/src/lib.rs` (Task 7 grows this):

```rust
//! The native shell. Owns the window, the tray icon and the Python backend
//! process. Deliberately tiny — all product logic lives in Python and JS.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // lets the web UI open links in the default browser
        .run(tauri::generate_context!())
        .expect("error while running BrainDump Lite");
}
```

- [x] **Step 5: Tauri config** `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "BrainDump Lite",
  "version": "0.4.3",
  "identifier": "com.canyonwirthlin.braindumplite",
  "build": {
    "frontendDist": "../shell-ui"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "BrainDump Lite",
        "url": "index.html",
        "width": 1100,
        "height": 780,
        "minWidth": 720,
        "minHeight": 520,
        "center": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico"],
    "resources": ["backend/**/*"],
    "windows": {
      "nsis": { "installMode": "currentUser" }
    }
  }
}
```

Notes for the reader: `withGlobalTauri` injects `window.__TAURI__` into pages so the existing vanilla JS can call plugins without a bundler. `csp: null` because the real UI is served by the backend, not by Tauri. `resources` ships the PyInstaller folder next to the exe (on Windows the resource dir *is* the install dir). `installMode: currentUser` = no admin prompt, installs to `%LOCALAPPDATA%`.

- [x] **Step 6: Capabilities** `src-tauri/capabilities/default.json` — Tauri 2 denies all IPC unless a capability grants it per window and, for non-Tauri origins, per URL. Our UI is a "remote" page on loopback:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-window",
  "description": "The UI is served by the local Python backend on 127.0.0.1, so IPC must be allowed for that origin (the port is dynamic).",
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:*"] },
  "permissions": [
    "core:default",
    "opener:default"
  ]
}
```

- [x] **Step 7: Build and run the empty shell**

```bash
cd src-tauri && cargo check && cd .. && npm run tauri dev
```
Expected: first `cargo check` compiles Tauri (5-10 min cold). `tauri dev` opens a 1100×780 window titled "BrainDump Lite" showing the spinner and "Starting BrainDump Lite…" (it will spin forever — the backend isn't wired yet). Close the window to stop. If Avast kills `target\debug\braindump-lite.exe`, restore it and re-check the exclusion.

- [x] **Step 8: Commit** (make sure `src-tauri/target/`, `src-tauri/backend/`, `src-tauri/gen/schemas/` and `node_modules/` are ignored — `git status` must not list them)

```bash
git add package.json package-lock.json shell-ui/ src-tauri/
git commit -m "feat(shell): Tauri 2 scaffold - window, splash page, icons, capabilities

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Spawn the backend and navigate the window to it

**Files:**
- Create: `src-tauri/src/backend.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `static/app.js` (external-link bridge)

**Interfaces:**
- Consumes: env contract from Task 3; `src-tauri/backend/braindump-backend.exe` from Task 5; `bdlFailed()` from Task 6.
- Produces: `backend::Backend` managed state (`Mutex<Option<Child>>`), `backend::pick_port(start) -> u16`, `backend::spawn(&AppHandle, u16) -> Result<Child, String>`, `backend::wait_ready(u16, Duration) -> bool`, `backend::stop(&AppHandle)`.
- Produces in JS: `native`, `openExternal(url)` and a document-level click handler routing `http(s)`/`mailto` links to the default browser.

- [x] **Step 1: Write the Rust module with its unit tests.** Create `src-tauri/src/backend.rs`:

```rust
//! Starts and stops the Python backend (a PyInstaller folder shipped as a
//! Tauri resource). Pure std: no async, no extra crates.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// The running backend process, stored in Tauri's managed state so the
/// exit handler can kill it. `None` after stop().
pub struct Backend(pub Mutex<Option<Child>>);

pub const BACKEND_EXE: &str = "braindump-backend.exe";

/// First free port in [start, start+25), matching the range the standalone
/// backend always used (8756-8780). Falls back to an OS-chosen port.
pub fn pick_port(start: u16) -> u16 {
    for p in start..start + 25 {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(start)
}

/// Where the backend exe lives. Installed app: <install dir>/backend/ (the
/// resource dir IS the exe dir on Windows). `tauri dev`: the folder that
/// build-backend.ps1 writes to, in case tauri-build didn't copy resources.
pub fn exe_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("backend").join(BACKEND_EXE);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("backend").join(BACKEND_EXE)
}

pub fn spawn(app: &AppHandle, port: u16) -> Result<Child, String> {
    let exe = exe_path(app);
    if !exe.exists() {
        return Err(format!("backend not found at {} — run build-backend.ps1", exe.display()));
    }
    let mut cmd = Command::new(&exe);
    cmd.env("BRAINDUMP_LITE_SIDECAR", "1")
        .env("BRAINDUMP_LITE_PORT", port.to_string())
        .env("BRAINDUMP_LITE_PARENT_PID", std::process::id().to_string())
        .current_dir(exe.parent().expect("exe has a parent dir"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    cmd.spawn().map_err(|e| format!("could not start backend {}: {e}", exe.display()))
}

/// uvicorn binds its socket only after the app is fully constructed, so
/// "port accepts a TCP connection" == "backend is ready".
pub fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<Backend>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_port_returns_a_bindable_port() {
        let p = pick_port(8756);
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn wait_ready_gives_up_on_a_closed_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // now nothing listens there
        assert!(!wait_ready(port, Duration::from_millis(700)));
    }

    #[test]
    fn wait_ready_sees_a_listening_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(wait_ready(port, Duration::from_secs(2)));
    }
}
```

- [x] **Step 2: Wire it in `src-tauri/src/lib.rs`** (whole file) and add `serde_json = "1"` under `[dependencies]` in `src-tauri/Cargo.toml` (used to safely quote the log path into JS):

```rust
//! The native shell. Owns the window, the tray icon and the Python backend
//! process. Deliberately tiny — all product logic lives in Python and JS.

mod backend;

use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // web UI opens links in the default browser
        .setup(|app| {
            // 1. Start the backend on a port we choose, so we know where to navigate.
            let port = backend::pick_port(8756);
            let child = backend::spawn(app.handle(), port)?;
            app.manage(backend::Backend(Mutex::new(Some(child))));

            // 2. Off the UI thread: wait for the port, then swap the splash for the app.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let ready = backend::wait_ready(port, Duration::from_secs(90));
                let Some(window) = handle.get_webview_window("main") else { return };
                if ready {
                    let url = format!("http://127.0.0.1:{port}/").parse().expect("valid url");
                    let _ = window.navigate(url);
                } else {
                    let log = handle
                        .path()
                        .local_data_dir()
                        .map(|d| d.join("BrainDumpLite").join("logs").join("backend.log"))
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| "%LOCALAPPDATA%\\BrainDumpLite\\logs\\backend.log".into());
                    let _ = window.eval(&format!("window.bdlFailed({})", serde_json::to_string(&log).unwrap()));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building BrainDump Lite")
        .run(|app, event| {
            // 3. Whatever way the app exits, take the backend down with it.
            if let tauri::RunEvent::Exit = event {
                backend::stop(app);
            }
        });
}
```

- [x] **Step 3: Run the Rust tests**

```bash
cd src-tauri && cargo test && cd ..
```
Expected: `3 passed`.

- [x] **Step 4: JS — route external links through the shell.** In `static/app.js`, add a section just above the `// ── What's New` section from Task 4:

```js
// ── Native shell bridge (Tauri) ──────────────────────────────────────────────
// Inside the native app Tauri injects window.__TAURI__ (withGlobalTauri in
// src-tauri/tauri.conf.json). In a plain browser it's undefined and everything
// here degrades gracefully.
const native = window.__TAURI__ || null;

function openExternal(url) {
  if (native) native.opener.openUrl(url).catch((e) => toast("Couldn't open link: " + (e.message || e), true));
  else window.open(url, "_blank", "noopener");
}

// WebView2 would otherwise open http(s) links inside the app window.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  if (!/^(https?:|mailto:)/i.test(a.getAttribute("href") || "")) return;  // #hash routes stay in-app
  e.preventDefault();
  openExternal(a.href);
});
```

- [x] **Step 5: Run the native app end to end**

```bash
npm run tauri dev
```
Expected: splash for ~2-5 s, then the real app UI appears in the window. Settings → the AI/provider panels work; Tasks → a Google-Calendar link opens in the system browser, not in the window; `Get-Content "$env:LOCALAPPDATA\BrainDumpLite\logs\backend.log"` shows the `(sidecar)` boot line. Close the window → the app exits and `Get-Process braindump-backend` reports nothing (the parent watchdog and `RunEvent::Exit` both cover it).

Failure check: temporarily rename `src-tauri/backend/braindump-backend.exe`, run `tauri dev` → the setup returns an error and Tauri aborts with the "backend not found" message in the console; rename it back.

- [x] **Step 6: Commit**

```bash
git add src-tauri/ static/app.js
git commit -m "feat(shell): spawn the Python backend as a sidecar and load the UI from it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: System tray + close-to-tray

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `tray::setup(&AppHandle) -> tauri::Result<()>`, `tray::show_main(&AppHandle)`.

- [x] **Step 1: Create `src-tauri/src/tray.rs`**

```rust
//! Tray icon with Open / Quit. Closing the window hides it (the backend and
//! the local AI stay warm); Quit from the tray is the real exit.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open BrainDump Lite", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("icon in tauri.conf.json").clone())
        .tooltip("BrainDump Lite")
        .menu(&menu)
        .show_menu_on_left_click(false) // left click = open; right click = menu
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

(If the compiler says `show_menu_on_left_click` doesn't exist, the resolved Tauri is < 2.2; use `.menu_on_left_click(false)` instead.)

- [x] **Step 2: Register it in `lib.rs`.** Add `mod tray;` under `mod backend;`, call `tray::setup(app.handle())?;` as the last line of `.setup(...)` before `Ok(())`, and insert between `.setup(...)` and `.build(...)`:

```rust
        // Close button = hide to tray. Tray → Quit is the real exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
```

- [x] **Step 3: Verify**

```bash
cd src-tauri && cargo test && cd .. && npm run tauri dev
```
Expected: a tray icon appears with the app icon; clicking the window's X hides the window, the process keeps running; left-click on the tray reopens it focused; right-click → Quit exits and `Get-Process braindump-backend` is empty.

- [x] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat(shell): system tray with Open/Quit, close button hides to tray

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Updater (Tauri updater plugin + JS "update available → What's New → install")

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `static/app.js`
- Create (outside the repo): `~/.tauri/braindumplite.key` (+ `.pub`)

**Interfaces:**
- Consumes: `latest.json` at `https://github.com/canyonwirthlin/BrainDumpLite/releases/latest/download/latest.json` (Task 10 produces it), shape `{version, notes, pub_date, platforms: {"windows-x86_64": {signature, url}}}`.
- Produces in JS: `checkForUpdates({silent})`, `showUpdateModal()`; header `#update-pill` opens the modal; Settings About gets "Check for updates".

- [x] **Step 1: Generate the updater signing keypair** (once; the private key never enters the repo):

```bash
npx tauri signer generate -w ~/.tauri/braindumplite.key
```
It asks for a password — pick one and store it with the key (password manager). Prints the public key; also saved to `~/.tauri/braindumplite.key.pub`. Back both up: losing the private key means installed apps can never be updated again (they'd need a manual reinstall).

- [x] **Step 2: Rust side** — in `src-tauri/Cargo.toml` add:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

In `lib.rs` add after the opener plugin line:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build()) // JS: __TAURI__.updater.check()
        .plugin(tauri_plugin_process::init())                  // JS: __TAURI__.process.relaunch()
```

- [x] **Step 3: Config.** In `src-tauri/tauri.conf.json` add `"createUpdaterArtifacts": true` inside `"bundle"` and a top-level `plugins` block (paste the contents of `~/.tauri/braindumplite.key.pub` as `pubkey`):

```json
  "plugins": {
    "updater": {
      "pubkey": "<contents of braindumplite.key.pub>",
      "endpoints": [
        "https://github.com/canyonwirthlin/BrainDumpLite/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }
    }
  }
```

`installMode: passive` = the NSIS updater shows a progress bar but asks nothing. In `capabilities/default.json` add `"updater:default"` and `"process:default"` to `permissions`.

- [x] **Step 4: JS — updater UI.** In `static/app.js`, extend the Native shell bridge section (after the click handler):

```js
let pendingUpdate = null;

async function checkForUpdates({ silent = true } = {}) {
  if (!native) { if (!silent) toast("Updates are only available in the installed app."); return; }
  try {
    const u = await native.updater.check();
    if (!u) { if (!silent) toast("You're on the latest version."); return; }
    pendingUpdate = u;
    const pill = $("#update-pill");
    pill.textContent = `⬆ v${u.version} available`;
    pill.style.display = "";
    if (!silent) showUpdateModal();
  } catch (e) {
    if (!silent) toast("Update check failed: " + (e.message || e), true);
  }
}

function showUpdateModal() {
  const u = pendingUpdate;
  if (!u) return;
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">
    <h2>What's new in v${esc(u.version)}</h2>
    <div class="md">${md(u.body || "_No notes for this release._")}</div>
    <div class="progress" style="display:none"><i></i></div>
    <div class="row">
      <button class="btn" id="upd-go">Install and restart</button>
      <button class="btn ghost" id="upd-later">Later</button>
    </div></div>`;
  document.body.appendChild(bg);
  $("#upd-later", bg).onclick = () => bg.remove();
  $("#upd-go", bg).onclick = async () => {
    const go = $("#upd-go", bg), bar = $(".progress", bg), fill = $(".progress i", bg);
    go.disabled = true; go.textContent = "Downloading…"; bar.style.display = "";
    let total = 0, got = 0;
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength || 0;
        else if (ev.event === "Progress") { got += ev.data.chunkLength; if (total) fill.style.width = Math.round(100 * got / total) + "%"; }
        else if (ev.event === "Finished") { fill.style.width = "100%"; go.textContent = "Installing…"; }
      });
      await native.process.relaunch();
    } catch (e) {
      toast("Update failed: " + (e.message || e), true);
      go.disabled = false; go.textContent = "Install and restart";
    }
  };
}

$("#update-pill").onclick = showUpdateModal;
```

At the startup line from Task 4 Step 8 change `refreshStatus().then(maybeShowWhatsNew);` to `refreshStatus().then(() => { maybeShowWhatsNew(); checkForUpdates(); });`.

In `renderSettings()`'s About card, change the `<p class="small" ...>` line to `BrainDump Lite <b>v${esc(status.version || "?")}</b> · ${native ? "native app" : "browser mode"}` and add next to the What's-new button:

```js
          ${native ? `<button class="btn ghost" id="about-update">Check for updates</button>` : ""}
```
with the handler `if ($("#about-update")) $("#about-update").onclick = () => checkForUpdates({ silent: false });` next to the `#about-whatsnew` handler.

- [x] **Step 5: Verify what can be verified before a release exists**

```bash
cd src-tauri && cargo check && cd .. && npm run tauri dev
```
Expected: app boots; Settings → About says "native app" (proves `__TAURI__` is injected into the loopback page); "Check for updates" shows a toast — either "You're on the latest version." or "Update check failed: … 404" (no release yet; both prove the IPC path works). In plain browser mode (`python run.py`) the About card says "browser mode" and no update button shows. The full download→install→relaunch loop is verified in Task 11 with a real second release.

- [x] **Step 6: Commit**

```bash
git add src-tauri/ static/
git commit -m "feat: in-app updater - update pill, release notes modal, install and relaunch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Release pipeline (`release.ps1` + GitHub Actions)

**Files:**
- Create: `release.ps1`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `python -m app.changelog X.Y.Z` (Task 4), `build-backend.ps1` (Task 5).
- Produces: on `git push origin vX.Y.Z` → GitHub Release `vX.Y.Z` with `BrainDump Lite_X.Y.Z_x64-setup.exe`, its `.sig`, and `latest.json` whose `notes` = the changelog section.

- [ ] **Step 1: `release.ps1`**

```powershell
# release.ps1 - cut a release. (ASCII only for PowerShell 5.1.)
#
#   .\release.ps1              bump patch  (0.5.0 -> 0.5.1)
#   .\release.ps1 minor        bump minor
#   .\release.ps1 major        bump major
#   .\release.ps1 0.6.2        exact version
#   add -NoPush to stop after the commit + tag (inspect, then git push --follow-tags)
#
# The one human step BEFORE running this: write the "## <new version>" section
# in CHANGELOG.md. That text becomes the GitHub release notes and the in-app
# "What's New". This script refuses to run without it.
#
# Then it: writes the version into app\version.py, src-tauri\tauri.conf.json,
# src-tauri\Cargo.toml (+Cargo.lock) and the ?v= cache-busters in
# static\index.html; commits; tags vX.Y.Z; pushes. GitHub Actions
# (.github\workflows\release.yml) builds the installer and publishes it plus
# latest.json, which every installed app polls on launch.
param([string]$Bump = "patch", [switch]$NoPush)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (git status --porcelain) { throw "Working tree is not clean. Commit or stash first." }

$verFile = "app\version.py"
$cur = (Select-String -Path $verFile -Pattern '"(\d+)\.(\d+)\.(\d+)"').Matches[0]
$maj = [int]$cur.Groups[1].Value; $min = [int]$cur.Groups[2].Value; $pat = [int]$cur.Groups[3].Value
$old = "$maj.$min.$pat"
switch ($Bump.ToLower()) {
    "major" { $maj++; $min = 0; $pat = 0 }
    "minor" { $min++; $pat = 0 }
    "patch" { $pat++ }
    default {
        if ($Bump -match '^\d+\.\d+\.\d+$') { $p = $Bump -split '\.'; $maj = [int]$p[0]; $min = [int]$p[1]; $pat = [int]$p[2] }
        else { throw "Unknown bump '$Bump'. Use patch / minor / major / X.Y.Z" }
    }
}
$new = "$maj.$min.$pat"
Write-Host "  BrainDump Lite  $old  ->  $new" -ForegroundColor Cyan

# Changelog gate: no notes, no release.
& .\.venv\Scripts\python.exe -m app.changelog $new | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "CHANGELOG.md has no '## $new' section. Write what's new first - it becomes the release notes."
}

[IO.File]::WriteAllText($verFile, "__version__ = `"$new`"`n")
$html = [IO.File]::ReadAllText("static\index.html")
[IO.File]::WriteAllText("static\index.html", [regex]::Replace($html, '\?v=[\d.]+', "?v=$new"))
$conf = [IO.File]::ReadAllText("src-tauri\tauri.conf.json")
[IO.File]::WriteAllText("src-tauri\tauri.conf.json", ([regex]'"version":\s*"[\d.]+"').Replace($conf, "`"version`": `"$new`"", 1))
$cargo = [IO.File]::ReadAllText("src-tauri\Cargo.toml")
[IO.File]::WriteAllText("src-tauri\Cargo.toml", ([regex]'(?m)^version = "[\d.]+"').Replace($cargo, "version = `"$new`"", 1))
Push-Location src-tauri
cargo metadata --format-version 1 --offline -q | Out-Null   # refresh Cargo.lock's own-package version
Pop-Location
Write-Host "  wrote version into version.py, index.html, tauri.conf.json, Cargo.toml/lock" -ForegroundColor DarkGray

git add -A
git commit -q -m "Release v$new"
git tag "v$new"
if ($NoPush) { Write-Host "  committed + tagged v$new (not pushed)" -ForegroundColor Yellow; return }
git push --follow-tags
Write-Host ""
Write-Host "  PUSHED v$new - GitHub Actions is building the installer." -ForegroundColor Green
Write-Host "  Watch: https://github.com/canyonwirthlin/BrainDumpLite/actions" -ForegroundColor DarkGray
```

- [ ] **Step 2: Workflow** `.github/workflows/release.yml`

```yaml
# Tag push (vX.Y.Z, made by release.ps1) -> tests -> frozen Python backend ->
# Tauri NSIS installer -> GitHub Release with installer, .sig and latest.json.
# The updater in every installed app reads latest.json from /releases/latest.
name: release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.14"
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Python tests
        run: |
          pip install -r requirements.txt -r requirements-dev.txt
          pytest -q

      - name: Tag must match app/version.py
        shell: bash
        run: |
          v=$(python -c "from app.version import __version__; print(__version__)")
          [ "v$v" = "$GITHUB_REF_NAME" ] || { echo "tag $GITHUB_REF_NAME != version $v"; exit 1; }

      - name: Release notes from CHANGELOG.md
        id: notes
        shell: bash
        run: |
          { echo "body<<BDL_EOF"; python -m app.changelog "${GITHUB_REF_NAME#v}"; echo "BDL_EOF"; } >> "$GITHUB_OUTPUT"

      - name: Freeze Python backend
        run: powershell -NoProfile -ExecutionPolicy Bypass -File build-backend.ps1

      - run: npm ci

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "BrainDump Lite ${{ github.ref_name }}"
          releaseBody: ${{ steps.notes.outputs.body }}
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true
```

- [ ] **Step 3: GitHub secrets (user, once).** On github.com → `canyonwirthlin/BrainDumpLite` → Settings → Secrets and variables → Actions → New repository secret:
  - `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `~/.tauri/braindumplite.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password chosen in Task 9 Step 1

- [ ] **Step 4: Dry-run the script locally**

```powershell
.\release.ps1 0.4.4 -NoPush
```
Expected: FAILS with `CHANGELOG.md has no '## 0.4.4' section` (the gate works). Then temporarily add a `## 0.4.4 — test` section to `CHANGELOG.md`, commit it, rerun the same command: commit "Release v0.4.4" touches the four version files and `Cargo.lock`; `git tag --list "v*"` shows `v0.4.4`. Undo everything:

```powershell
git tag -d v0.4.4; git reset --hard HEAD~2
```

- [ ] **Step 5: Local installer build sanity check** (proves the bundler config before CI does; takes a few minutes). The updater artifacts need the signing key in the environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/braindumplite.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<the password>"
npm run tauri build
```
Expected: `src-tauri\target\release\bundle\nsis\BrainDump Lite_0.4.3_x64-setup.exe` plus a `.sig` next to it. Run the installer: it installs to `%LOCALAPPDATA%\BrainDump Lite`, adds a Start Menu entry, launches, and the app works with the existing data. Keep it installed — Task 11 upgrades it.

- [ ] **Step 6: Commit**

```bash
git add release.ps1 .github/
git commit -m "build: release.ps1 + GitHub Actions release workflow (changelog-gated)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs, first release (v0.5.0), and the update loop proof (v0.5.1)

**Files:**
- Modify: `README.md`, `FRIENDS_README.txt`, `CHANGELOG.md`, memory file `braindumplite-shipping-and-constraints.md`

- [ ] **Step 1: README.** Rewrite the "Dev", "Build & ship" and "Repo layout" sections of `README.md` to:

````markdown
## Dev

```powershell
.\dev.ps1                 # backend + UI in your browser (fastest loop, no Rust needed)
.\build-backend.ps1       # freeze the backend into src-tauri\backend\ (needed by the two below)
npm run tauri dev         # the real native window + tray, debug build
npm run tauri build       # local installer: src-tauri\target\release\bundle\nsis\
.\.venv\Scripts\python -m pytest -q        # Python tests
cd src-tauri; cargo test                   # Rust tests
```

One-time: Rust (`rustup`, MSVC Build Tools with the C++ workload) and `npm install`.
Data dir override for testing: set `BRAINDUMP_LITE_DATA=<path>`.

## Release

1. Write a `## X.Y.Z — date` section at the top of `CHANGELOG.md`. This is the
   release notes on GitHub and the "What's New" panel in the app.
2. `.\release.ps1 [patch|minor|major|X.Y.Z]` — bumps every version file,
   commits, tags, pushes.
3. GitHub Actions builds the installer and publishes the release. Installed
   apps see it on next launch and offer "Install and restart".

The updater only needs a static `latest.json` URL (`src-tauri/tauri.conf.json`
→ `plugins.updater.endpoints`); GitHub Releases hosts it today.

## Repo layout

```
run.py                # backend entry (sidecar of the native shell, or standalone)
app/                  # FastAPI backend (unchanged by the native shell)
  launch.py           # sidecar helpers: port, log file, parent watchdog
  changelog.py        # CHANGELOG.md parser -> /api/changelog
static/               # vanilla-JS SPA, served by the backend
shell-ui/             # splash page + icon source for the native window
src-tauri/            # Tauri 2 shell (Rust): window, tray, sidecar spawn, updater
build-backend.ps1     # PyInstaller -> src-tauri/backend/
release.ps1           # version bump + tag; CI does the rest
```
````

Keep the provider table and architecture paragraphs; delete the SmartScreen/zip sentences.

- [ ] **Step 2: Friends' README.** Rewrite `FRIENDS_README.txt`'s "HOW TO RUN IT" section (keep the AI/voice/privacy sections):

```
HOW TO INSTALL IT
1. Download "BrainDump Lite_x.y.z_x64-setup.exe" from
   https://github.com/canyonwirthlin/BrainDumpLite/releases/latest
2. Run it. Windows may say "Windows protected your PC" because the app
   isn't signed (signing costs money). Click "More info" -> "Run anyway".
   If your antivirus quarantines it, restore it and allow it - it's from me.
3. It installs in a few seconds and opens. There's a Start Menu entry and
   a tray icon (bottom-right, near the clock). Closing the window keeps it
   running in the tray; right-click the tray icon -> Quit to fully exit.

UPDATES
The app checks for updates when it starts. When one exists a small
"update available" pill appears at the top - click it, read what's new,
press "Install and restart". That's it.

COMING FROM THE OLD ZIP VERSION?
Just install this one. Your dumps, settings and downloaded AI models are
picked up automatically (same data folder). Delete the old unzipped folder
whenever you like.
```

`FRIENDS_README.txt` is no longer shipped inside the app; it lives in the repo and is linked from the release page.

- [ ] **Step 3: Write the real 0.5.0 changelog entry** at the top of `CHANGELOG.md` (below the header paragraph, above 0.4.3):

```markdown
## 0.5.0 — <today's date>
- BrainDump Lite is now a real Windows app: an installer, a Start Menu entry, its own window (no more black console + browser tab).
- Tray icon: closing the window keeps the app running; right-click → Quit to exit.
- Automatic updates with release notes shown in the app before you install.
- "What's New" panel after every update (Settings → About shows it any time).
- Your existing data and downloaded AI models carry over unchanged.
```

- [ ] **Step 4: Run everything, commit the docs, then release**

```bash
.venv/Scripts/python -m pytest -q && (cd src-tauri && cargo test)
git add README.md FRIENDS_README.txt CHANGELOG.md
git commit -m "docs: installer-era README, friends guide, 0.5.0 changelog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

```powershell
.\release.ps1 0.5.0
```
Watch https://github.com/canyonwirthlin/BrainDumpLite/actions until green (~15-25 min: PyInstaller + Rust cold build). Expected release assets: `BrainDump Lite_0.5.0_x64-setup.exe`, `BrainDump Lite_0.5.0_x64-setup.exe.sig`, `latest.json`. Open `latest.json`: `version` is `0.5.0`, `notes` contains the changelog bullets, `platforms.windows-x86_64.url` points at the setup exe.

If the workflow fails on `pip install` of `faster-whisper`/`av` wheels for 3.14 on the runner: change `python-version` to `"3.13"` (both have wheels), commit, delete the tag locally and remotely (`git tag -d v0.5.0; git push --delete origin v0.5.0`) and rerun `.\release.ps1 0.5.0`.

- [ ] **Step 5: Install v0.5.0 from the release page** on the dev machine (Avast permitting). Expected: app launches, existing dumps visible, Settings → About shows `v0.5.0 · native app`, "Check for updates" → "You're on the latest version." (proves the endpoint + signature verification work).

- [ ] **Step 6: Prove the update loop with v0.5.1.** Add to `CHANGELOG.md`:

```markdown
## 0.5.1 — <today's date>
- Verifies automatic updates end to end. Nothing else changed.
```

```bash
git add CHANGELOG.md && git commit -m "docs: 0.5.1 changelog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

```powershell
.\release.ps1 0.5.1
```
When CI is green: launch the installed v0.5.0 → the header pill says `⬆ v0.5.1 available` → click → the modal shows the 0.5.1 note → "Install and restart" → progress bar → installer runs passively → the app relaunches → the "What's new in v0.5.1" panel appears once → Settings → About says `v0.5.1`. The update loop is proven; Phase 1 is shippable.

- [ ] **Step 7: Update memory.** Rewrite `C:\Users\canyo\.claude\projects\C--Users-canyo-Desktop-Home-Coding-BrainDumpLite\memory\braindumplite-shipping-and-constraints.md`: shipping is now `CHANGELOG.md` entry → `release.ps1` → GitHub Actions → GitHub Release + `latest.json`; the stdlib-only-additive constraint is GONE (new pip/cargo deps are fine per release); keep the engine/ports/small-model lessons; add: Tauri updater private key lives at `~/.tauri/braindumplite.key` (+ password in the user's password manager), secrets set on the GitHub repo; Rust toolchain installed. Update the pointer line in `MEMORY.md`.

---

### Task 12 (optional, after v0.5.0 exists): last legacy bundle that points old installs at the installer

The two friends' old exes still poll the legacy manifest. One final legacy bundle shows them a banner with the download link; they never get another one.

**Files (in a worktree of the `legacy-ota` tag, nothing lands on `master`):**
- Modify: `static/index.html`, `app/version.py` (via push-update)

- [ ] **Step 1: Worktree**

```bash
git worktree add ../BrainDumpLite-legacy legacy-ota
```

- [ ] **Step 2: Banner.** In `../BrainDumpLite-legacy/static/index.html` insert directly after `</header>`:

```html
<div class="banner" style="margin:12px 18px 0">
  BrainDump Lite is now a real Windows app with automatic updates. This old version won't receive further updates —
  <a href="https://github.com/canyonwirthlin/BrainDumpLite/releases/latest" target="_blank">download the new installer</a>.
  Your dumps, settings and models carry over automatically.
</div>
```

- [ ] **Step 3: Publish through the legacy pipeline** (it bumps to 0.4.4, builds `update.bin`, pushes to `canyonwirthlin/BrainDumpLiteUpdateService`):

```powershell
cd ..\BrainDumpLite-legacy
.\push-update.bat 0.4.4
```
Expected: `PUBLISHED v0.4.4`. Verify `https://raw.githubusercontent.com/canyonwirthlin/BrainDumpLiteUpdateService/main/manifest.json` says `0.4.4` (allow ~5 min cache).

- [ ] **Step 4: Clean up** (the worktree's uncommitted bump is discarded on purpose; `master` never sees legacy code):

```bash
git worktree remove --force ../BrainDumpLite-legacy
```

---

## Self-review

- **Spec coverage:** Tauri + Python sidecar (T5-T7) ✓; native WebView2 window instead of browser tab (T7) ✓; real installer with Start Menu + uninstaller (NSIS, T6/T10) ✓; tray icon (T8) ✓; unsigned (no Authenticode anywhere) ✓; Windows-only, no cross-platform boxing-out (lib/main split, `cfg(windows)` guards, `watch_parent` posix stub) ✓; minimal Rust with explanations (3 small files, comments) ✓; global hotkey NOT built ✓; provider-agnostic updater (single static URL) ✓; hand-written changelog as the release step, gated (`release.ps1`, T4/T10) ✓; "What's New" on update (pre-install modal with `notes`, post-update panel from `/api/changelog`) ✓; automatable publish (tag → CI) ✓; removal of the stdlib-only constraint (old OTA deleted, T2/T3) ✓; friends' migration path (T11 docs, T12 banner) ✓.
- **Placeholders:** `<contents of braindumplite.key.pub>`, `<the password>` and `<today's date>` are values only the executor can fill at run time, not missing design. No TBD/TODO.
- **Type consistency:** env names `BRAINDUMP_LITE_SIDECAR/PORT/PARENT_PID` identical in T3 and T7; exe name `braindump-backend.exe` in T5 (`--name braindump-backend`) and T7 (`BACKEND_EXE`); folder `src-tauri/backend/` in T5, T6 (`resources`), T7 (`exe_path`), `.gitignore`; window label `main` in T6 config, T7 `get_webview_window("main")`, T8, capabilities; `bdlFailed` in T6 splash and T7 eval; JS names `native`, `openExternal`, `checkForUpdates`, `showUpdateModal`, `showWhatsNew`, `maybeShowWhatsNew` consistent across T4/T7/T9; `python -m app.changelog` used identically in T4, T10 script and workflow.
