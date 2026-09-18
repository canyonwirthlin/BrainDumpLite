"""BrainDump Lite launcher — the PyInstaller entry point, and deliberately dumb.

It never changes between updates. Its whole job:
  1. Pick the newest healthy code bundle: <data>/code/<version>/ folders
     (delivered by app/updater.py) beat the seed copy shipped inside the exe.
  2. Import the app from it. If a freshly-pushed update crashes at boot,
     mark that version .bad and fall back to the previous one — a bad push
     must never brick a friend's install.
  3. Serve on a free port and open the browser.
"""
import importlib
import os
import re
import socket
import sys
import threading
import traceback
import webbrowser
from datetime import datetime
from pathlib import Path

# Windows consoles default to cp1252; don't let a fancy character crash the app.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Use the OS certificate store for all TLS (huggingface model downloads,
# Claude/OpenAI API calls, update downloads). certifi alone breaks on machines
# with AV or corporate TLS interception.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass


def _pyinstaller_trace_hint():  # never called — static-analysis hint only
    """Makes PyInstaller bundle the app's whole dependency tree (fastapi,
    openai, pydantic, …) even though the real import happens dynamically
    through the version-selecting bootstrap below."""
    import app.main  # noqa: F401
    import app.updater  # noqa: F401


def data_dir() -> Path:
    """Must mirror app.db.data_dir (which we can't import yet)."""
    override = os.environ.get("BRAINDUMP_LITE_DATA")
    if override:
        p = Path(override)
    elif os.name == "nt":
        p = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "BrainDumpLite"
    else:
        p = Path.home() / ".braindump-lite"
    p.mkdir(parents=True, exist_ok=True)
    return p


def parse_version(v: str) -> tuple:
    nums = re.findall(r"\d+", str(v))
    return tuple(int(x) for x in nums[:3]) if nums else (0,)


def candidate_code_dirs() -> list:
    """Downloaded bundles, newest first, then None (= the exe's seed copy)."""
    out = []
    code_root = data_dir() / "code"
    if code_root.is_dir():
        versioned = []
        for d in code_root.iterdir():
            if (d.is_dir() and not d.name.startswith(".")
                    and (d / "app" / "__init__.py").exists()
                    and not (code_root / f"{d.name}.bad").exists()):
                versioned.append(d)
        versioned.sort(key=lambda d: parse_version(d.name), reverse=True)
        out.extend(versioned)
    out.append(None)
    return out


def demote_frozen_importer() -> None:
    """PyInstaller's FrozenImporter beats sys.path, which would pin us to the
    frozen app copy forever. Move it last: disk code wins, and everything the
    disk copy doesn't provide (stdlib, third-party deps) still resolves from
    the frozen archive. No-op in dev."""
    frozen = [m for m in sys.meta_path if "Frozen" in type(m).__name__]
    for m in frozen:
        sys.meta_path.remove(m)
        sys.meta_path.append(m)


def load_app():
    demote_frozen_importer()
    inserted = None
    for code_dir in candidate_code_dirs():
        try:
            if code_dir is not None:
                inserted = str(code_dir)
                sys.path.insert(0, inserted)
            for name in [n for n in sys.modules if n == "app" or n.startswith("app.")]:
                del sys.modules[name]
            importlib.invalidate_caches()
            main_mod = importlib.import_module("app.main")
            app_obj = main_mod.create_app()
            version = importlib.import_module("app.version").__version__
            # This version booted — clear its "restart to apply" marker.
            marker = data_dir() / "update_ready.txt"
            try:
                if marker.exists() and marker.read_text(encoding="utf-8").strip() == version:
                    marker.unlink()
            except OSError:
                pass
            return app_obj, version, code_dir
        except Exception:
            traceback.print_exc()
            if inserted:
                try:
                    sys.path.remove(inserted)
                except ValueError:
                    pass
                inserted = None
            if code_dir is not None:
                bad = code_dir.parent / f"{code_dir.name}.bad"
                try:
                    bad.write_text("failed to boot; rolled back", encoding="utf-8")
                except OSError:
                    pass
                print(f"[launcher] update {code_dir.name} failed to boot — rolled back.", flush=True)
    raise RuntimeError("could not start BrainDump Lite from any code bundle")


def free_port(start: int = 8756) -> int:
    for p in range(start, start + 25):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0  # let the OS pick


def main() -> None:
    """Crash shield: friends can't read a console that closes itself. Any
    startup failure is written to a log AND held on screen."""
    try:
        _main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        try:
            log = data_dir() / "launcher-crash.log"
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"\n--- crash at {datetime.now().isoformat()} ---\n")
                f.write(traceback.format_exc())
            print()
            print("  BrainDump Lite could not start. Details were saved to:")
            print(f"    {log}")
            print("  Send that file (or a screenshot of this window) to whoever")
            print("  gave you the app.")
        except Exception:
            pass
        try:
            input("\n  Press Enter to close this window... ")
        except (EOFError, OSError):
            pass
        sys.exit(1)


def _main() -> None:
    app, version, code_dir = load_app()
    source = f"update bundle {code_dir.name}" if code_dir is not None else "built-in"
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    print()
    print("  ==============================================")
    print(f"        BrainDump Lite  v{version} ({source})")
    print()
    print(f"    Running at:  {url}")
    print("    Your browser should open automatically.")
    print()
    print("    KEEP THIS WINDOW OPEN while using the app.")
    print("    Close it to quit.")
    print("  ==============================================")
    print()

    try:
        updater = importlib.import_module("app.updater")
        updater.start_background_check()
    except Exception as e:
        print(f"[launcher] updater unavailable: {e}", flush=True)

    import uvicorn
    threading.Timer(1.2, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
