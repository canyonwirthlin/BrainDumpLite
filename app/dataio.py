"""Full-fidelity JSON export/import (the lossless round trip; Markdown export lives in export_md.py).

Format: {"format": "braindump-lite-export", "version": 1, "tables": {name: {"columns": [...], "rows": [{...}]}},
"settings": {...}}. Columns are read from the live schema at export time and filtered to the destination's
columns at import time, so columns added by later releases (is_private, deleted_at, ...) travel automatically
and an export from a newer/older build still imports. Private/trashed dumps are included by default; the
export filters (include_private / include_deleted) exist for a later decision.

Import is idempotent and never overwrites local data:
  1. a row that is already there (same natural key, e.g. a dump's created_at + raw_text) is skipped;
  2. otherwise it keeps its id when free;
  3. otherwise (same id, different content) it is stored under a fresh id and references follow it.
Because step 1 runs first, importing the same file again changes nothing.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

from . import db
from .version import __version__

FORMAT = "braindump-lite-export"
VERSION = 1

# (table, natural-key columns or None, primary key columns, {fk column: table whose id map applies})
# Parents come before children.
TABLES: list[tuple[str, list[str] | None, list[str], dict[str, str]]] = [
    ("item_types", None, ["id"], {}),
    ("task_folders", ["name", "created_at"], ["id"], {}),
    ("dumps", ["created_at", "raw_text"], ["id"], {"merged_into": "dumps"}),
    ("items", ["dump_id", "kind", "content", "created_at"], ["id"], {"dump_id": "dumps", "folder_id": "task_folders"}),
    ("links", None, ["dump_id", "related_id"], {"dump_id": "dumps", "related_id": "dumps"}),
    ("reflections", None, ["period_key"], {}),
    ("habits", ["title", "created_at"], ["id"], {}),
    ("habit_log", None, ["habit_id", "day"], {"habit_id": "habits"}),
    ("saved_searches", ["query"], ["id"], {}),
    ("recent_searches", None, ["query"], {}),
    ("dump_merges", ["target_id", "created_at"], ["id"], {"target_id": "dumps"}),
    ("sessions", ["started_at", "mode"], ["id"], {"dump_id": "dumps"}),
    ("session_items", ["session_id", "turn", "content"], ["id"], {"session_id": "sessions"}),
    ("suggestions", ["kind", "title", "created_at"], ["id"], {"item_id": "items", "dump_id": "dumps"}),
]
# Not exported: runs/stats_daily (derived telemetry), FTS tables (rebuilt on import), embeddings stay with their dumps.

_SECRETISH = re.compile(r"secret|token|api_key|password|passphrase|app_lock|google|cache|^backup|onboarded|credential|^hash$|^salt$", re.I)


def _cols(table: str) -> list[str]:
    return [r["name"] for r in db.query(f"PRAGMA table_info({table})")]


def _plain(v):
    return v.hex() if isinstance(v, (bytes, bytearray)) else v


def export_data(include_private: bool = True, include_deleted: bool = True) -> dict:
    out: dict = {"format": FORMAT, "version": VERSION, "app_version": __version__,
                 "exported_at": datetime.now(timezone.utc).isoformat(),
                 "options": {"include_private": include_private, "include_deleted": include_deleted}, "tables": {}}
    with db.lock():
        dump_ids = {r["id"] for r in db.query("SELECT id, is_private, deleted_at FROM dumps")
                    if (include_private or not r["is_private"]) and (include_deleted or not r["deleted_at"])}
        for table, _nat, _pk, _refs in TABLES:
            cols = _cols(table)
            rows = [{c: _plain(r[c]) for c in cols} for r in db.query(f"SELECT * FROM {table}")]
            if table == "dumps":
                rows = [r for r in rows if r["id"] in dump_ids]
            elif table == "items":
                rows = [r for r in rows if r["dump_id"] in dump_ids]
            elif table == "links":
                rows = [r for r in rows if r["dump_id"] in dump_ids and r["related_id"] in dump_ids]
            elif table == "dump_merges":
                rows = [r for r in rows if r["target_id"] in dump_ids]
            out["tables"][table] = {"columns": cols, "rows": rows}
        out["settings"] = {r["key"]: json.loads(r["value"]) for r in db.query("SELECT key, value FROM settings")
                           if not _SECRETISH.search(r["key"])}
    return out


def _find(table: str, nat: list[str] | None, pk: list[str], row: dict):
    """The existing row this one duplicates, if any."""
    if nat:
        where = " AND ".join(f"{c} IS ?" for c in nat)
        hit = db.query_one(f"SELECT {pk[0]} AS k FROM {table} WHERE {where}", tuple(row.get(c) for c in nat))
        if hit:
            return hit["k"]
    if not nat and len(pk) == 1 and row.get(pk[0]) is not None:      # pk-only tables: same key = same row
        hit = db.query_one(f"SELECT {pk[0]} AS k FROM {table} WHERE {pk[0]}=?", (row[pk[0]],))
        if hit:
            return hit["k"]
    return None


def import_data(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("format") != FORMAT:
        raise ValueError("that isn't a BrainDump Lite export")
    if int(payload.get("version") or 0) > VERSION:
        raise ValueError("this export is from a newer BrainDump Lite; update the app first")
    tables = payload.get("tables") or {}
    report: dict = {"tables": {}, "settings_added": 0}
    maps: dict[str, dict] = {t: {} for t, *_ in TABLES}
    with db.lock():
        c = db.conn()
        for table, nat, pk, refs in TABLES:
            dest_cols = set(_cols(table))
            added = skipped = renamed = 0
            for src in (tables.get(table) or {}).get("rows", []):
                row = {k: v for k, v in src.items() if k in dest_cols}
                for col, ref in refs.items():                     # follow ids that were remapped earlier
                    if row.get(col) in maps[ref]:
                        row[col] = maps[ref][row[col]]
                old = row.get("id")
                found = _find(table, nat, pk, row)
                if found is not None:                                  # already here: skip, but remember where it lives
                    if "id" in pk:
                        maps[table][old] = found
                    skipped += 1
                    continue
                if "id" in pk and db.query_one(f"SELECT 1 FROM {table} WHERE id=?", (old,)):
                    row["id"] = db.new_id()                            # same id, different content: keep both
                    maps[table][old] = row["id"]
                    renamed += 1
                cols = list(row)
                try:
                    cur = c.execute(f"INSERT OR IGNORE INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                                    tuple(row[k] for k in cols))
                except sqlite3.IntegrityError:                         # e.g. a link to a dump that isn't in the file
                    skipped += 1
                    continue
                if cur.rowcount:
                    added += 1
                else:
                    skipped += 1
            report["tables"][table] = {"added": added, "skipped": skipped, "renamed": renamed}
        for key, val in (payload.get("settings") or {}).items():      # settings never overwrite local values
            if not _SECRETISH.search(key) and db.query_one("SELECT 1 FROM settings WHERE key=?", (key,)) is None:
                c.execute("INSERT INTO settings(key, value) VALUES(?,?)", (key, json.dumps(val)))
                report["settings_added"] += 1
        for r in c.execute("SELECT id, title, summary, clean_text, raw_text FROM dumps d WHERE status='ready' "
                           "AND NOT EXISTS (SELECT 1 FROM dumps_fts f WHERE f.id = d.id)").fetchall():
            c.execute("INSERT INTO dumps_fts (id, body) VALUES (?,?)",
                      (r["id"], "\n".join([r["title"] or "", r["summary"] or "", r["clean_text"] or r["raw_text"] or ""])))
        c.commit()
    db.backfill_items_fts()
    report["added"] = sum(t["added"] for t in report["tables"].values())
    return report
