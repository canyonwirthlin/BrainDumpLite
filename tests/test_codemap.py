import importlib.util
import sys
from pathlib import Path

from app import db

ROOT = Path(__file__).resolve().parent.parent


def _load():
    spec = importlib.util.spec_from_file_location("codemap", ROOT / "scripts" / "codemap.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["codemap"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_codemap_covers_backend_frontend_and_schema():
    cm = _load()
    open_conn = db.conn()
    text = cm.render()
    assert db._conn is open_conn            # building the schema section must not disturb the caller's vault
    assert open_conn.execute("SELECT 1").fetchone()[0] == 1
    assert "### `app/graph.py`" in text and "### `static/js/views/graph.js`" in text
    assert "`GET /api/graph` → " in text and "← graph/data" in text    # backend route linked to its frontend caller (graph fetch lives in graph/data.js)
    assert "- `dumps`: id," in text and "`items_fts` (FTS)" in text      # schema read from a real init, FTS shadow tables hidden
    assert "dumps_fts_data" not in text
    assert "## Hot spots" in text


def test_codemap_imports_resolve_both_directions():
    cm = _load()
    py = cm.scan_python()
    assert "db" in py["graph"]["deps"] and "graph" in py["db"]["used_by"]
    assert "graph" in py["graph"]["tests"]
    js, calls = cm.scan_js()
    assert "ui" in js["views/graph"]["deps"] and "views/graph" in js["ui"]["used_by"]
    assert ("GET", "/graph", "graph/data") in calls
