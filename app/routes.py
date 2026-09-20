"""All API routes. Sync `def` endpoints (FastAPI runs them in a threadpool) —
no async DB, no auth, single local user, same origin as the static frontend.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import ai, catalog, changelog, db, engine, export_md, gitsync, google_cal, graph, import_md, item_types, lock, mcp_client, pipeline, planner, plugins, profiles, secrets, sessions, stats, suggestions, themes, todoist, transcribe, vault
from .version import __version__ as VERSION

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class DumpIn(BaseModel):
    text: str
    mode: str = "freeform"


class ItemPatch(BaseModel):
    status: str | None = None   # suggested|approved|rejected
    done: bool | None = None
    kind: str | None = None     # an enabled item type id (task, idea, or a custom one)
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
    tools_in_chat: bool | None = None


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
        "locked": lock.locked(),
        "lock_set": lock.is_set(),
        "last_dump_at": (db.query_one("SELECT MAX(created_at) AS m FROM dumps") or {"m": None})["m"],
        "inbox_pending": suggestions.count_pending(),
        "onboarded": bool(db.get_setting("onboarded", False)),
    }


@router.post("/onboarding/complete")
def complete_onboarding():
    db.set_setting("onboarded", True)
    return {"onboarded": True}


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


# ── Sessions (conversational capture) ────────────────────────────────────────

class SessionIn(BaseModel):
    mode: str = "therapy"


class MessageIn(BaseModel):
    text: str


@router.post("/sessions")
def create_session(body: SessionIn):
    try:
        return sessions.start(body.mode)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/sessions")
def list_sessions(open: int = 1):
    return sessions.list_open()


@router.get("/sessions/{sid}")
def get_session(sid: str):
    s = sessions.get(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@router.get("/sessions/{sid}/items")
def session_items(sid: str):
    return sessions.items(sid)


@router.post("/sessions/{sid}/message")
def session_message(sid: str, body: MessageIn):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Empty message")
    try:
        turn = sessions.append(sid, "user", text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    sessions.extract_lite_async(sid, turn, text)

    def gen():
        try:
            for delta in sessions.reply_stream(sid):
                yield f"data: {json.dumps(delta)}\n\n"
            proposal = sessions.tool_proposal(sid)
            if proposal:
                yield f"event: tool\ndata: {json.dumps(proposal)}\n\n"
            yield "event: done\ndata: {}\n\n"
        except ai.AIError as e:
            yield f"event: error\ndata: {json.dumps(str(e))}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class SessionToolIn(BaseModel):
    server: str
    tool: str
    args: dict = {}


@router.post("/sessions/{sid}/tool")
def session_tool(sid: str, body: SessionToolIn):
    try:
        return sessions.run_tool(sid, body.server, body.tool, body.args)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except (RuntimeError, TimeoutError) as e:
        raise HTTPException(400, str(e))


@router.post("/sessions/{sid}/end")
def end_session(sid: str):
    try:
        return {"dump_id": sessions.end(sid)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/sessions/{sid}")
def delete_session(sid: str):
    sessions.delete(sid)
    return {"ok": True}


# ── App lock ─────────────────────────────────────────────────────────────────

class PassIn(BaseModel):
    passphrase: str
    current: str | None = None


@router.get("/lock")
def lock_state():
    return {"locked": lock.locked(), "lock_set": lock.is_set()}


@router.post("/lock/set")
def lock_set(body: PassIn):
    try:
        lock.set_passphrase(body.passphrase, body.current)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.post("/lock/clear")
def lock_clear(body: PassIn):
    try:
        lock.clear(body.passphrase)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.post("/lock/now")
def lock_now():
    lock.lock()
    return {"locked": lock.locked()}


@router.post("/unlock")
def unlock(body: PassIn):
    if not lock.unlock(body.passphrase):
        raise HTTPException(401, "Wrong passphrase")
    return {"locked": False}


# ── Markdown export / import, wikilinks (Phase 6) ────────────────────────────

@router.get("/dumps/{dump_id}/markdown")
def dump_markdown(dump_id: str, wikilinks: int = 1):
    try:
        name, text = export_md.dump_markdown(dump_id, bool(wikilinks))
    except ValueError:
        raise HTTPException(404, "Dump not found")
    return Response(text, media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/export/markdown.zip")
def export_markdown_zip(wikilinks: int = 1):
    data = export_md.vault_markdown_zip(bool(wikilinks))
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="braindump-markdown.zip"'})


@router.post("/import/markdown")
async def import_markdown(files: list[UploadFile] = File(...), mode: str = "freeform"):
    batch = []
    for f in files:
        raw = await f.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        batch.append((f.filename or "note.md", text, None))
    return import_md.import_files(batch, mode if mode in pipeline.VALID_MODES else "freeform")


@router.get("/import/status")
def import_status():
    return import_md.status()


@router.get("/wikilinks/suggest")
def wikilink_suggest(q: str = ""):
    q = q.strip().lower()
    out = []
    for c in graph.concepts():
        if not q or q in c["name"].lower():
            out.append({"name": c["name"], "kind": "concept", "count": c["count"]})
    for p in graph.people():
        if not q or q in p["name"].lower():
            out.append({"name": p["name"], "kind": "person", "count": p["count"]})
    for r in db.query("SELECT title FROM dumps WHERE status='ready' AND title IS NOT NULL ORDER BY created_at DESC LIMIT 200"):
        if r["title"] and (not q or q in r["title"].lower()):
            out.append({"name": r["title"], "kind": "dump", "count": 1})
    return out[:20]


# ── Vault profiles + git mirror (Phase 6) ────────────────────────────────────

class ProfileIn(BaseModel):
    name: str
    dir: str | None = None


@router.get("/profiles")
def list_profiles():
    return profiles.list_profiles()


@router.post("/profiles/add")
def profile_add(body: ProfileIn):
    try:
        return profiles.add(body.name, body.dir or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/profiles/create")
def profile_create(body: ProfileIn):
    try:
        return profiles.create(body.name, body.dir or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/profiles/switch")
def profile_switch(body: ProfileIn):
    try:
        return profiles.switch(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/profiles/remove")
def profile_remove(body: ProfileIn):
    try:
        profiles.remove(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


class GitIn(BaseModel):
    dir: str | None = None
    message: str | None = None


@router.get("/gitsync")
def gitsync_status():
    return gitsync.status()


@router.post("/gitsync/configure")
def gitsync_configure(body: GitIn):
    try:
        return gitsync.configure(body.dir)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/gitsync/now")
def gitsync_now(body: GitIn):
    try:
        return gitsync.sync_now(body.message)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── Model catalog + stats (Phase 7) ──────────────────────────────────────────

@router.get("/catalog")
def get_catalog(refresh: int = 0):
    return catalog.load(refresh=bool(refresh))


@router.get("/stats")
def get_stats(days: int = 30):
    return stats.summary(days)


# ── Integrations + Suggestions inbox (Phase 8) ───────────────────────────────
oauth_router = APIRouter()   # mounted without the /api prefix (OAuth redirect target)

_OAUTH_PAGE = """<!doctype html><meta charset=utf-8><title>BrainDump Lite</title>
<body style="font:15px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:32rem"><h2 style="margin:0 0 .5rem">{h}</h2><p style="opacity:.7">{p}</p></div>
<script>setTimeout(()=>window.close(),1500)</script></body>"""


@oauth_router.get("/oauth/google/callback", response_class=HTMLResponse)
def google_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    if error or not code or not state:
        return _OAUTH_PAGE.format(h="Sign-in cancelled", p=f"Google said: {error or 'no code'}. You can close this tab.")
    try:
        google_cal.handle_callback(code, state)
    except Exception as e:
        return _OAUTH_PAGE.format(h="Sign-in failed", p=str(e))
    return _OAUTH_PAGE.format(h="Google Calendar connected", p="Back to BrainDump Lite — this tab closes itself.")


@router.get("/integrations")
def integrations_status():
    gc = google_cal.client()
    return {
        "secrets": secrets.storage_kind(),
        "google": {"connected": google_cal.connected(), "account": db.get_setting("google_account") if google_cal.connected() else None,
                   "client_id": gc["id"], "has_secret": bool(gc["secret"])},
        "todoist": {"connected": todoist.connected()},
    }


class GoogleClientIn(BaseModel):
    client_id: str = ""
    client_secret: str = ""


@router.put("/integrations/google/client")
def integrations_google_client(body: GoogleClientIn):
    google_cal.set_client(body.client_id, body.client_secret)
    return {"ok": True}


@router.post("/integrations/google/connect")
def integrations_google_connect(request: Request):
    port = request.url.port or 8756
    try:
        return {"url": google_cal.auth_url(port)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/integrations/google/disconnect")
def integrations_google_disconnect():
    google_cal.disconnect()
    return {"ok": True}


class TodoistIn(BaseModel):
    token: str = ""


@router.put("/integrations/todoist")
def integrations_todoist(body: TodoistIn):
    try:
        return {"connected": todoist.set_token(body.token)}
    except Exception as e:
        raise HTTPException(400, f"Todoist rejected the token: {e}")


@router.get("/suggestions")
def suggestions_list():
    return {"pending": suggestions.pending(), "recent": suggestions.recent()}


class SuggestionAccept(BaseModel):
    title: str | None = None
    due: str | None = None
    description: str | None = None


@router.post("/suggestions/{sid}/accept")
def suggestions_accept(sid: str, body: SuggestionAccept | None = None):
    edits = {k: v for k, v in (body.model_dump() if body else {}).items() if v is not None}
    try:
        return suggestions.accept(sid, edits)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/suggestions/{sid}/dismiss")
def suggestions_dismiss(sid: str):
    s = suggestions.dismiss(sid)
    if not s:
        raise HTTPException(404, "no such suggestion")
    return s


@router.post("/suggestions/dismiss-all")
def suggestions_dismiss_all(kind: str | None = None):
    n = 0
    for k in ([kind] if kind else ["calendar_push", "todoist_push"]):
        n += suggestions.dismiss_kind(k)
    return {"dismissed": n}


class SendIn(BaseModel):
    target: str    # calendar|todoist
    due: str | None = None


@router.post("/items/{item_id}/send")
def item_send(item_id: str, body: SendIn):
    it = db.query_one("SELECT * FROM items WHERE id=?", (item_id,))
    if not it:
        raise HTTPException(404, "no such item")
    kind = {"calendar": "calendar_push", "todoist": "todoist_push"}.get(body.target)
    if not kind:
        raise HTTPException(400, "target must be calendar or todoist")
    if kind == "calendar_push" and not google_cal.connected():
        raise HTTPException(400, "Google Calendar is not connected")
    if kind == "todoist_push" and not todoist.connected():
        raise HTTPException(400, "Todoist is not connected")
    payload = {"title": it["content"], "due": body.due or it["due_date"], "description": it["detail"] or ""}
    s = suggestions.create(kind, f"{'Add to Google Calendar' if kind == 'calendar_push' else 'Send to Todoist'}: {it['content'][:80]}",
                           payload, "manual", item_id, it["dump_id"])
    return suggestions.accept(s["id"])   # manual sends are already user-approved


@router.get("/plan")
def plan_get(day: str | None = None):
    return planner.plan(day)


class PlanPushIn(BaseModel):
    day: str
    slots: list[dict]


@router.post("/plan/push")
def plan_push(body: PlanPushIn):
    """Turn chosen plan slots into calendar_push suggestions (pending, so the user still confirms)."""
    made = []
    for s in body.slots:
        it = db.query_one("SELECT * FROM items WHERE id=?", (s.get("task_id"),))
        if not it or not s.get("start"):
            continue
        made.append(suggestions.create("calendar_push", f"Block time: {it['content'][:80]}",
                                       {"title": it["content"], "due": f"{body.day}T{s['start']}", "description": s.get("reason") or ""},
                                       "planner", it["id"], it["dump_id"]))
    return {"created": len(made), "suggestions": made}


# ── MCP servers + plugins (Phase 9) ──────────────────────────────────────────

@router.get("/mcp/servers")
def mcp_servers():
    return mcp_client.status()


class McpConfigIn(BaseModel):
    config: str


@router.post("/mcp/servers")
def mcp_add(body: McpConfigIn):
    try:
        return {"added": mcp_client.add_servers(body.config)}
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(400, f"Couldn't read that config: {e}")


@router.delete("/mcp/servers/{name}")
def mcp_remove(name: str):
    mcp_client.remove_server(name)
    return {"ok": True}


@router.post("/mcp/servers/{name}/start")
def mcp_start(name: str):
    try:
        return mcp_client.start(name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except (RuntimeError, TimeoutError) as e:
        raise HTTPException(400, str(e))


@router.post("/mcp/servers/{name}/stop")
def mcp_stop(name: str):
    mcp_client.stop(name)
    return {"ok": True}


class EnabledIn(BaseModel):
    enabled: bool


@router.put("/mcp/servers/{name}/enabled")
def mcp_enabled(name: str, body: EnabledIn):
    mcp_client.set_enabled(name, body.enabled)
    return mcp_client.status(name)


@router.get("/mcp/tools")
def mcp_tools(ai_only: bool = False):
    return mcp_client.tools(ai_only=ai_only)


class ModeIn(BaseModel):
    mode: str


@router.put("/mcp/tools/{server}/{tool}/mode")
def mcp_tool_mode(server: str, tool: str, body: ModeIn):
    try:
        mcp_client.set_tool_mode(server, tool, body.mode)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


class McpCallIn(BaseModel):
    server: str
    tool: str
    args: dict = {}


@router.post("/mcp/call")
def mcp_call(body: McpCallIn):
    try:
        return mcp_client.call(body.server, body.tool, body.args)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except (RuntimeError, TimeoutError) as e:
        raise HTTPException(400, str(e))


@router.get("/plugins")
def plugins_list():
    return plugins.listing()


class PathIn(BaseModel):
    path: str


@router.post("/plugins/install")
def plugins_install(body: PathIn):
    try:
        return plugins.install(body.path)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.put("/plugins/{pid}/enabled")
def plugins_enabled(pid: str, body: EnabledIn):
    return plugins.set_enabled(pid, body.enabled)


@router.post("/plugins/reload")
def plugins_reload():
    return plugins.load_all()


@router.delete("/plugins/{pid}")
def plugins_uninstall(pid: str):
    plugins.uninstall(pid)
    return {"ok": True}


class ActionIn(BaseModel):
    args: dict = {}


@router.post("/plugins/{pid}/actions/{action_id}")
def plugins_run(pid: str, action_id: str, body: ActionIn):
    try:
        return plugins.run_action(pid, action_id, body.args)
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"the action failed: {e}")


@router.get("/plugins/examples")
def plugins_examples():
    return plugins.examples()


@router.get("/plugins/folder")
def plugins_folder():
    return {"path": str(plugins.plugins_dir())}


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


@router.post("/themes")
def create_theme(body: dict):
    try:
        return themes.save(body)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/themes/{theme_id}")
def update_theme(theme_id: str, body: dict):
    try:
        return themes.save(body, theme_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


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
        "summary", "status", "stage", "error", "provider", "captured_local")}
    try:
        out["tone"] = json.loads(row["tone"]) if row["tone"] else None
    except (ValueError, TypeError):
        out["tone"] = None
    for k in ("concepts", "people"):
        try:
            out[k] = json.loads(row[k]) if row[k] else []
        except (ValueError, TypeError):
            out[k] = []
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
    mode = body.mode if body.mode in pipeline.VALID_MODES else "freeform"
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
    if body.kind is not None:
        # Hand-retagging: how a custom type gets its first node without waiting for the AI.
        if body.kind not in item_types.enum():
            raise HTTPException(400, "Unknown or disabled item type")
        db.execute("UPDATE items SET kind=? WHERE id=?", (body.kind, item_id))
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
def graph_data(items: int = 0):
    return graph.build(items=bool(items))


@router.get("/graph/types")
def graph_types():
    return graph.types()


class BaseTypeIn(BaseModel):
    label: str | None = None
    color: str | None = None


@router.put("/graph/types/{type_id}")
def update_graph_type(type_id: str, body: BaseTypeIn):
    """Rename/recolor a built-in node kind (dump/concept/person). Item types use /item-types."""
    try:
        return graph.update_base_type(type_id, body.label, body.color)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/graph/types/{type_id}")
def reset_graph_type(type_id: str):
    try:
        return graph.reset_base_type(type_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/concepts")
def list_concepts():
    return graph.concepts()


@router.get("/concepts/{name}")
def concept_dumps(name: str):
    return graph.for_concept(name)


@router.get("/people")
def list_people():
    return graph.people()


@router.get("/people/{name}")
def person_dumps(name: str):
    return graph.for_person(name)


@router.get("/dumps/{dump_id}/backlinks")
def dump_backlinks(dump_id: str):
    return graph.backlinks(dump_id)


@router.get("/today")
def today(date: str | None = None):
    return graph.today(date)


@router.get("/resurface")
def resurface():
    return graph.resurface() or {}


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
            "tools_in_chat": bool(db.get_setting("tools_in_chat", False)),
            "defaults": ai.DEFAULTS}


@router.put("/settings")
def put_settings(body: SettingsIn):
    if body.tools_in_chat is not None:
        db.set_setting("tools_in_chat", bool(body.tools_in_chat))
    if body.provider is not None:
        if body.provider not in ("builtin", "anthropic", "openai", "gemini", "local", "off"):
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


@router.get("/engine/gpu")
def engine_gpu():
    """Cheap hardware check for onboarding's provider recommendation: GPU info
    only, no catalog fetch (that can hit the network; this never does)."""
    gpu = engine.detect_gpu()
    return {"gpu": gpu, "capable": gpu["vram_mb"] >= 4 * 1024 - 600}  # smallest catalog tier's own headroom rule


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


@router.delete("/engine/files/{name}")
def engine_delete_file(name: str):
    ok, msg = engine.delete_file(name)
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
