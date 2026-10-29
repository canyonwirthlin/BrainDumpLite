"""Run BrainDump Lite against a throwaway, seeded vault (foreground; Ctrl+C / kill to stop).

    python scripts/graph_serve.py --data <dir> --port 8761 [--dumps 140]

Seeds <dir> with scripts/seed_graph_demo.py when it has no dumps yet, then serves the app on
127.0.0.1:<port>. Open http://127.0.0.1:<port>/#graph. Never touches the real vault: the data dir is
always the one you pass. BRAINDUMP_LITE_PARENT_PID is deliberately removed so the server doesn't
shut itself down when some parent process exits.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", required=True, help="data dir for the sandbox vault (created if missing)")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--dumps", type=int, default=140, help="dumps to seed when the vault is empty (default 140)")
    ap.add_argument("--force-seed", action="store_true", help="re-seed even if the vault already has dumps")
    a = ap.parse_args()

    data = Path(a.data).resolve()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["BRAINDUMP_LITE_DATA"] = str(data)
    os.environ.pop("BRAINDUMP_LITE_PARENT_PID", None)
    os.environ.pop("BRAINDUMP_LITE_SIDECAR", None)
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "scripts"))

    from app import db
    import seed_graph_demo

    db.init_db()
    has = db.query_one("SELECT COUNT(*) AS n FROM dumps WHERE id != ?", (db.MANUAL_DUMP_ID,))["n"]
    if not has or a.force_seed:
        out = seed_graph_demo.seed(a.dumps, force=bool(has))
        print(f"[graph_serve] seeded {out['dumps']} dumps / {out['items']} items / {out['links']} links", flush=True)
    else:
        print(f"[graph_serve] vault already has {has} dumps - not re-seeding", flush=True)

    from app.main import create_app
    import uvicorn

    app = create_app()
    print(f"[graph_serve] data={data}\n[graph_serve] http://127.0.0.1:{a.port}/#graph", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
