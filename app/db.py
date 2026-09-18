"""SQLite storage — one file, no server, no Docker.

A single shared connection in WAL mode, guarded by an RLock. Fine for a
single-user local app; the pipeline runs in a background thread and the
lock serialises writes.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()


def data_dir() -> Path:
    """Per-user data folder (NOT next to the exe, which may live in Downloads)."""
    override = os.environ.get("BRAINDUMP_LITE_DATA")
    if override:
        p = Path(override)
    elif os.name == "nt":
        p = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "BrainDumpLite"
    else:
        p = Path.home() / ".braindump-lite"
    p.mkdir(parents=True, exist_ok=True)
    return p


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dumps (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'freeform',
  raw_text   TEXT NOT NULL,
  clean_text TEXT,
  title      TEXT,
  summary    TEXT,
  reflection TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|ready|failed
  stage      TEXT,                             -- cleanup|classify|expand|embed|link
  error      TEXT,
  embedding  TEXT,                             -- JSON float array; NULL when unavailable
  people     TEXT,                             -- JSON string array
  concepts   TEXT                              -- JSON string array
);
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  dump_id    TEXT NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- task|goal|idea|concern|event|note
  content    TEXT NOT NULL,
  detail     TEXT,                             -- first_tiny_step / extra context
  priority   INTEGER,                          -- 1-5 (5 = today)
  due_date   TEXT,                             -- YYYY-MM-DD
  status     TEXT NOT NULL DEFAULT 'suggested',-- suggested|approved|rejected
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  dump_id    TEXT NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  PRIMARY KEY (dump_id, related_id)
);
CREATE TABLE IF NOT EXISTS reflections (
  period_key TEXT PRIMARY KEY,                 -- 'daily:2026-07-17' | 'weekly:2026-W29'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS dumps_fts USING fts5(id UNINDEXED, body);
CREATE TABLE IF NOT EXISTS item_types (
  id      TEXT PRIMARY KEY,
  label   TEXT NOT NULL,
  icon    TEXT NOT NULL DEFAULT '',
  color   TEXT NOT NULL,                       -- token name (accent|green|amber|red|blue|dim) or #rrggbb
  hint    TEXT NOT NULL DEFAULT '',            -- one-line rule shown to the model
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (                -- one row per model call (Phase 7 Stats reads it)
  id TEXT PRIMARY KEY, dump_id TEXT, stage TEXT NOT NULL, provider TEXT, model TEXT,
  started_at TEXT NOT NULL, ms INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
  ok INTEGER NOT NULL, error TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(item_id UNINDEXED, dump_id UNINDEXED, body);
"""


def conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(str(data_dir() / "braindump.db"), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA foreign_keys=ON")
        return _conn


def init_db() -> None:
    with _lock:
        conn().executescript(SCHEMA)
        _migrate()
        conn().commit()


def _migrate() -> None:
    """Additive column migrations for dbs created before a schema addition."""
    cols = {r["name"] for r in conn().execute("PRAGMA table_info(dumps)")}
    for col, typ in (("people", "TEXT"), ("concepts", "TEXT"), ("captured_local", "TEXT"),
                     ("tone", "TEXT"), ("provider", "TEXT")):
        if col not in cols:
            conn().execute(f"ALTER TABLE dumps ADD COLUMN {col} {typ}")
    icols = {r["name"] for r in conn().execute("PRAGMA table_info(items)")}
    for col, typ in (("est_minutes", "INTEGER"), ("urgency", "INTEGER"), ("time_hint", "TEXT")):
        if col not in icols:
            conn().execute(f"ALTER TABLE items ADD COLUMN {col} {typ}")


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    with _lock:
        return conn().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> None:
    with _lock:
        conn().execute(sql, params)
        conn().commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


# ── Settings (key → JSON value) ──────────────────────────────────────────────

def get_setting(key: str, default=None):
    row = query_one("SELECT value FROM settings WHERE key=?", (key,))
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value)),
    )
