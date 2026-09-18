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
    print(f"BrainDump Lite v{__version__} - serving at {url} ({'sidecar' if sidecar else 'standalone'})", flush=True)
    import uvicorn
    if not sidecar:
        print("KEEP THIS WINDOW OPEN while using the app. Close it to quit.", flush=True)
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
