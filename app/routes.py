"""All API routes. Sync `def` endpoints (FastAPI runs them in a threadpool) —
no async DB, no auth, single local user, same origin as the static frontend.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from . import ai, changelog, db, engine, item_types, pipeline, themes, transcribe, vault
from .version import __version__ as VERSION

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class DumpIn(BaseModel):
    text: str
    mode: str = "freeform"


class ItemPatch(BaseModel):
    status: str | None = None   # suggested|approved|rejected
    done: bool | None = None
    # "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"; null clears. Only applied when the
    # client actually sends the key (see model_fields_set) — so null means
    # "clear" while an absent key means "leave unchanged".
    due_date: str | None = None


class SettingsIn(BaseModel):
    provider: str | None = None  # builtin|anthropic|openai|local|off
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    embed_model: str | None = None
    whisper_model: str | None = None


class ReflectIn(BaseModel):
    kind: str = "daily"          # daily|weekly
    force: bool = False


# ── Status ───────────────────────────────────────────────────────────────────

@router.get("/status")
def status():
    c = ai.config()
    return {
        "version": VERSION,
        "ai": ai.available(),
        "provider": c["provider"],
        "model": c["model"],
        "whisper": transcribe.available(),
        "data_dir": str(db.data_dir()),
        "vault_dir": str(db.vault_dir()),
    }


@router.get("/changelog")
def get_changelog():
    return {"version": VERSION, "entries": changelog.load()}


# ── Item types ───────────────────────────────────────────────────────────────

class ItemTypeIn(BaseModel):
    label: str | None = None
    icon: str | None = None
    color: str | None = None
    hint: str | None = None
    enabled: bool | None = None


@router.get("/item-types")
def list_item_types():
    return item_types.all()


@router.post("/item-types")
def create_item_type(body: ItemTypeIn):
    try:
        return item_types.create(body.label or "", body.icon or "", body.color or "accent", body.hint or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/item-types/{type_id}")
def update_item_type(type_id: str, body: ItemTypeIn):
    try:
        return item_types.update(type_id, **body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/item-types/{type_id}")
def delete_item_type(type_id: str):
    try:
        item_types.delete(type_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ── Vault: backup / restore / location ───────────────────────────────────────

class VaultMoveIn(BaseModel):
    path: str


@router.get("/vault")
def vault_info():
    return vault.info()


@router.get("/backup")
def vault_backup():
    name, data = vault.backup_zip()
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/restore")
async def vault_restore(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return vault.restore_zip(data)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/vault/move")
def vault_move(body: VaultMoveIn):
    try:
        return vault.move(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/vault/reset")
def vault_reset():
    return vault.reset_location()


# ── Themes ───────────────────────────────────────────────────────────────────

class ThemeActiveIn(BaseModel):
    id: str


@router.get("/themes")
def list_themes():
    return {"active": themes.active_id(), "themes": themes.all_themes()}


@router.put("/themes/active")
def set_active_theme(body: ThemeActiveIn):
    try:
        themes.set_active(body.id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"active": themes.active_id()}


@router.post("/themes/import")
def import_theme(body: dict):
    try:
        return themes.import_theme(body)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/themes/{theme_id}")
def delete_theme(theme_id: str):
    try:
        themes.delete(theme_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "active": themes.active_id()}


@router.get("/themes/{theme_id}/export")
def export_theme(theme_id: str):
    t = themes.get(theme_id)
    if not t:
        raise HTTPException(404, "unknown theme")
    return Response(json.dumps(t, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{theme_id}.theme.json"'})


# ── Dumps ────────────────────────────────────────────────────────────────────

def _dump_out(row, items=None, related=None):
    out = {k: row[k] for k in (
        "id", "created_at", "mode", "raw_text", "clean_text", "title",
        "summary", "reflection", "status", "stage", "error", "provider", "captured_local")}
    try:
        out["tone"] = json.loads(row["tone"]) if row["tone"] else None
    except (ValueError, TypeError):
        out["tone"] = None
    if items is not None:
        out["items"] = items
    if related is not None:
        out["related"] = related
    return out


@router.post("/dumps")
def create_dump(body: DumpIn, bg: BackgroundTasks):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Empty dump")
    mode = body.mode if body.mode in pipeline._EXPAND_SYSTEMS else "freeform"
    dump_id = db.new_id()
    db.execute(
        "INSERT INTO dumps (id, created_at, mode, raw_text, status) VALUES (?,?,?,?, 'pending')",
        (dump_id, db.now_iso(), mode, text))
    bg.add_task(pipeline.run_pipeline, dump_id)
    return {"id": dump_id}


@router.get("/dumps")
def list_dumps(limit: int = 100):
    rows = db.query(
        "SELECT d.*, (SELECT COUNT(*) FROM items i WHERE i.dump_id = d.id) AS item_count "
        "FROM dumps d ORDER BY d.created_at DESC LIMIT ?", (limit,))
    return [{**_dump_out(r), "item_count": r["item_count"]} for r in rows]


@router.get("/dumps/{dump_id}")
def get_dump(dump_id: str):
    row = db.query_one("SELECT * FROM dumps WHERE id=?", (dump_id,))
    if not row:
        raise HTTPException(404, "Dump not found")
    items = [dict(r) for r in db.query(
        "SELECT * FROM items WHERE dump_id=? ORDER BY "
        "CASE kind WHEN 'task' THEN 0 WHEN 'goal' THEN 1 WHEN 'event' THEN 2 "
        "WHEN 'idea' THEN 3 WHEN 'concern' THEN 4 ELSE 5 END", (dump_id,))]
    related = []
    for r in db.query(
            "SELECT l.dump_id, l.related_id, l.score FROM links l "
            "WHERE l.dump_id=? OR l.related_id=?", (dump_id, dump_id)):
        other = r["related_id"] if r["dump_id"] == dump_id else r["dump_id"]
        d = db.query_one("SELECT id, title, created_at FROM dumps WHERE id=?", (other,))
        if d and all(x["id"] != other for x in related):
            related.append({"id": d["id"], "title": d["title"],
                            "created_at": d["created_at"], "score": r["score"]})
    return _dump_out(row, items=items, related=related)


@router.delete("/dumps/{dump_id}")
def delete_dump(dump_id: str):
    db.execute("DELETE FROM dumps_fts WHERE id=?", (dump_id,))
    db.execute("DELETE FROM dumps WHERE id=?", (dump_id,))  # cascades items/links
    return {"ok": True}


# ── Items / tasks ────────────────────────────────────────────────────────────

@router.patch("/items/{item_id}")
def patch_item(item_id: str, body: ItemPatch):
    row = db.query_one("SELECT id FROM items WHERE id=?", (item_id,))
    if not row:
        raise HTTPException(404, "Item not found")
    if body.status is not None:
        if body.status not in ("suggested", "approved", "rejected"):
            raise HTTPException(400, "Bad status")
        db.execute("UPDATE items SET status=? WHERE id=?", (body.status, item_id))
    if body.done is not None:
        db.execute("UPDATE items SET done=? WHERE id=?", (1 if body.done else 0, item_id))
    if "due_date" in body.model_fields_set:
        dd = body.due_date
        if dd is not None:
            dd = dd.strip()
            if dd == "":
                dd = None
            elif not re.fullmatch(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?", dd):
                raise HTTPException(400, "due_date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM")
        db.execute("UPDATE items SET due_date=? WHERE id=?", (dd, item_id))
    return dict(db.query_one("SELECT * FROM items WHERE id=?", (item_id,)))


@router.get("/tasks")
def list_tasks():
    rows = db.query(
        "SELECT i.*, d.title AS dump_title FROM items i JOIN dumps d ON d.id = i.dump_id "
        "WHERE i.kind IN ('task','goal') AND i.status != 'rejected' "
        "ORDER BY i.done, CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, "
        "i.due_date, COALESCE(i.priority, 0) DESC, i.created_at DESC")
    return [dict(r) for r in rows]


# ── Graph ────────────────────────────────────────────────────────────────────

@router.get("/graph")
def graph():
    """Nodes: dumps + concepts + people (merged case-insensitively across dumps).
    Edges: dump→concept / dump→person (mentions) + dump→dump (similarity, from links)."""
    rows = db.query("SELECT id, title, created_at, people, concepts FROM dumps WHERE status='ready'")
    nodes: list[dict] = []
    edges: list[dict] = []
    slots: dict[str, str] = {}

    def slot(name: str, prefix: str, kind: str) -> str:
        key = f"{prefix}:{name.strip().lower()}"
        if key not in slots:
            slots[key] = key
            nodes.append({"id": key, "label": name.strip(), "type": kind})
        return key

    for r in rows:
        nodes.append({"id": r["id"], "label": r["title"] or "Untitled",
                      "type": "dump", "created_at": r["created_at"]})
        for name in json.loads(r["concepts"] or "[]"):
            edges.append({"source": r["id"], "target": slot(name, "concept", "concept"), "type": "mention"})
        for name in json.loads(r["people"] or "[]"):
            edges.append({"source": r["id"], "target": slot(name, "person", "person"), "type": "mention"})

    for r in db.query("SELECT dump_id, related_id, score FROM links"):
        edges.append({"source": r["dump_id"], "target": r["related_id"], "type": "similar", "score": r["score"]})

    return {"nodes": nodes, "edges": edges}


@router.get("/items/{item_id}/ics")
def item_ics(item_id: str):
    """All-day VEVENT for one task — imports into Apple Calendar, Outlook,
    Google, and most reminder apps. Semi-manual by design: no OAuth."""
    row = db.query_one(
        "SELECT i.*, d.title AS dump_title FROM items i "
        "JOIN dumps d ON d.id = i.dump_id WHERE i.id=?", (item_id,))
    if not row:
        raise HTTPException(404, "Item not found")

    raw_due = row["due_date"] or date.today().isoformat()
    if "T" in raw_due:  # timed: emit a floating-local DATE-TIME, default 1h long
        dt = datetime.fromisoformat(raw_due)
        dtstart = f"DTSTART:{dt:%Y%m%dT%H%M%S}"
        dtend = f"DTEND:{dt + timedelta(hours=1):%Y%m%dT%H%M%S}"
    else:               # all-day VALUE=DATE
        start = raw_due.replace("-", "")
        end = (date.fromisoformat(raw_due) + timedelta(days=1)).strftime("%Y%m%d")
        dtstart = f"DTSTART;VALUE=DATE:{start}"
        dtend = f"DTEND;VALUE=DATE:{end}"

    def ics_escape(s: str) -> str:
        return (s.replace("\\", "\\\\").replace(";", "\\;")
                 .replace(",", "\\,").replace("\n", "\\n"))

    desc = ((f"First step: {row['detail']}\n" if row["detail"] else "")
            + f"From BrainDump Lite ({row['dump_title'] or 'dump'})")
    ics = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BrainDump Lite//EN",
        "BEGIN:VEVENT",
        f"UID:{row['id']}@braindumplite",
        f"DTSTAMP:{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}",
        dtstart,
        dtend,
        f"SUMMARY:{ics_escape(row['content'][:150])}",
        f"DESCRIPTION:{ics_escape(desc)}",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ])
    return Response(content=ics, media_type="text/calendar",
                    headers={"Content-Disposition": 'attachment; filename="braindump-task.ics"'})


# ── Search ───────────────────────────────────────────────────────────────────

@router.get("/search")
def search(q: str):
    q = q.strip()
    if not q:
        return []
    results: dict[str, dict] = {}

    terms = re.findall(r"\w+", q.lower())
    if terms:
        match = " OR ".join(f'"{t}"' for t in terms)
        try:
            for r in db.query(
                    "SELECT d.id, d.title, d.created_at, "
                    "snippet(dumps_fts, 1, '「', '」', '…', 14) AS snip "
                    "FROM dumps_fts JOIN dumps d ON d.id = dumps_fts.id "
                    "WHERE dumps_fts MATCH ? ORDER BY bm25(dumps_fts) LIMIT 12", (match,)):
                results[r["id"]] = {"id": r["id"], "title": r["title"],
                                    "created_at": r["created_at"],
                                    "snippet": r["snip"], "via": "keyword"}
        except Exception:
            pass

    # Items: "search everything" — a task/idea/… whose text matches surfaces its dump.
    if terms:
        try:
            for r in db.query(
                    "SELECT f.item_id, f.dump_id, i.kind, i.content, d.title, d.created_at, d.summary "
                    "FROM items_fts f JOIN items i ON i.id = f.item_id JOIN dumps d ON d.id = f.dump_id "
                    "WHERE items_fts MATCH ? ORDER BY bm25(items_fts) LIMIT 30", (match,)):
                entry = results.get(r["dump_id"])
                if not entry:
                    entry = results[r["dump_id"]] = {"id": r["dump_id"], "title": r["title"],
                                                     "created_at": r["created_at"],
                                                     "snippet": (r["summary"] or "")[:160], "via": "items"}
                entry.setdefault("matched_items", []).append(
                    {"id": r["item_id"], "kind": r["kind"], "content": r["content"][:160]})
        except Exception:
            pass

    emb = ai.embed(q) if ai.available() else None
    if emb:
        rows = db.query("SELECT id, title, created_at, summary, embedding "
                        "FROM dumps WHERE embedding IS NOT NULL")
        scored = sorted(((r, ai.cosine(emb, json.loads(r["embedding"]))) for r in rows),
                        key=lambda t: -t[1])
        for r, score in scored[:8]:
            if score < 0.45:
                break
            if r["id"] in results:
                results[r["id"]]["via"] = "both"
            else:
                results[r["id"]] = {"id": r["id"], "title": r["title"],
                                    "created_at": r["created_at"],
                                    "snippet": (r["summary"] or "")[:160],
                                    "via": "semantic"}
    return list(results.values())


# ── Reflect ──────────────────────────────────────────────────────────────────

_REFLECT_SYSTEM = """
You are the user's second brain, reflecting back what they dumped into it.
Write in second person, warm but direct. Structure:
1. The through-line — what actually connects these dumps
2. What deserves attention next
3. One gentle observation they might be missing
Under 180 words. No headers, just three short paragraphs.
""".strip()


def _local_date(iso: str):
    return datetime.fromisoformat(iso).astimezone().date()


@router.post("/reflect")
def reflect(body: ReflectIn):
    kind = body.kind if body.kind in ("daily", "weekly") else "daily"
    today = datetime.now().astimezone().date()
    if kind == "daily":
        key = f"daily:{today.isoformat()}"
        since = today
        label = "today"
    else:
        y, w, _ = today.isocalendar()
        key = f"weekly:{y}-W{w:02d}"
        since = today - timedelta(days=6)
        label = "the last 7 days"

    if not body.force:
        cached = db.query_one("SELECT content FROM reflections WHERE period_key=?", (key,))
        if cached:
            return {"content": cached["content"], "cached": True}

    rows = [r for r in db.query(
        "SELECT title, summary, mode, created_at FROM dumps "
        "WHERE status='ready' ORDER BY created_at DESC LIMIT 60")
        if _local_date(r["created_at"]) >= since]
    if not rows:
        return {"content": f"No dumps from {label} yet — nothing to reflect on. Go dump something.",
                "cached": False, "empty": True}
    if not ai.available():
        listing = "\n".join(f"• {r['title'] or '(untitled)'}" for r in rows[:15])
        return {"content": f"AI is off, so here's the raw tally — {len(rows)} dump(s) from {label}:\n{listing}",
                "cached": False}

    corpus = "\n".join(
        f"- [{r['mode']}] {r['title']}: {(r['summary'] or '').replace(chr(10), ' ')[:300]}"
        for r in rows)
    try:
        content = ai.chat(_REFLECT_SYSTEM,
                          f"Brain dumps from {label}:\n{corpus}", max_tokens=600, temperature=0.6)
    except ai.AIError as e:
        raise HTTPException(502, f"Reflection failed: {e}")
    db.execute("INSERT OR REPLACE INTO reflections VALUES (?,?,?)",
               (key, content, db.now_iso()))
    return {"content": content, "cached": False}


# ── Transcription ────────────────────────────────────────────────────────────

@router.post("/transcribe")
def transcribe_audio(file: UploadFile = File(...)):
    if not transcribe.available():
        raise HTTPException(501, "Voice transcription not available in this build")
    data = file.file.read()
    if len(data) < 1000:
        return {"text": ""}
    try:
        return {"text": transcribe.transcribe_bytes(data)}
    except Exception as e:
        raise HTTPException(500, f"Transcription failed: {e}")


# ── Settings ─────────────────────────────────────────────────────────────────

@router.get("/settings")
def get_settings():
    c = ai.config()
    return {**c, "whisper_model": db.get_setting("whisper_model", "base"),
            "defaults": ai.DEFAULTS}


@router.put("/settings")
def put_settings(body: SettingsIn):
    if body.provider is not None:
        if body.provider not in ("builtin", "anthropic", "openai", "local", "off"):
            raise HTTPException(400, "Bad provider")
        db.set_setting("provider", body.provider)
        if body.provider != "builtin":
            # Fire-and-forget: stop_all waits on the proc lock, which a
            # concurrent engine setup can hold for a while.
            threading.Thread(target=engine.stop_all, daemon=True).start()
        # Reset per-provider fields to that provider's defaults when they were
        # never customised, so switching providers doesn't drag stale URLs along.
        d = ai.DEFAULTS.get(body.provider, {})
        if body.base_url is None:
            db.set_setting("base_url", d.get("base_url", ""))
        if body.model is None:
            db.set_setting("model", d.get("model", ""))
        if body.embed_model is None:
            db.set_setting("embed_model", d.get("embed_model", ""))
    for key in ("api_key", "base_url", "model", "embed_model"):
        val = getattr(body, key)
        if val is not None:
            db.set_setting(key, val.strip())
    if body.whisper_model is not None:
        if body.whisper_model not in ("tiny", "base", "small"):
            raise HTTPException(400, "Bad whisper model")
        db.set_setting("whisper_model", body.whisper_model)
    return get_settings()


# ── Built-in AI engine ───────────────────────────────────────────────────────

class EngineSetupIn(BaseModel):
    model: str


@router.get("/engine/status")
def engine_status():
    return engine.status()


@router.post("/engine/setup")
def engine_setup(body: EngineSetupIn):
    """Kick off download + launch in the background; the settings page polls
    /engine/status for progress. Also how you switch built-in models."""
    ok, msg = engine.start_setup(body.model)
    if not ok:
        raise HTTPException(409, msg)
    return {"ok": True}


@router.delete("/engine/models/{model_id}")
def engine_delete_model(model_id: str):
    ok, msg = engine.delete_model(model_id)
    if not ok:
        raise HTTPException(400, msg)
    return {"ok": True}


@router.get("/models")
def models():
    try:
        return {"models": ai.list_models()}
    except ai.AIError as e:
        raise HTTPException(502, str(e))


@router.post("/settings/test")
def test_settings():
    return ai.test_connection()
