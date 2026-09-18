"""Todoist push (Phase 8) with a personal API token (unified API v1; REST v2 is retired)."""
from __future__ import annotations

import json
import urllib.request

from . import secrets

API = "https://api.todoist.com/api/v1"


def _http(method: str, url: str, data: dict | None, token: str) -> dict:
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Todoist API {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from e


def connected() -> bool:
    return bool(secrets.get_secret("todoist_token"))


def set_token(token: str | None) -> bool:
    token = (token or "").strip() or None
    if token:
        _http("GET", API + "/projects", None, token)   # validates the token
    secrets.set_secret("todoist_token", token)
    return bool(token)


def create_task(content: str, due: str | None = None, description: str = "") -> dict:
    token = secrets.get_secret("todoist_token")
    if not token:
        raise RuntimeError("Todoist is not connected")
    body: dict = {"content": content, "description": description or ""}
    if due:
        if "T" in due:
            body["due_datetime"] = due + ":00"
        else:
            body["due_date"] = due
    t = _http("POST", API + "/tasks", body, token)
    return {"id": t.get("id"), "link": t.get("url") or (f"https://app.todoist.com/app/task/{t['id']}" if t.get("id") else None)}


def execute_push(payload: dict) -> dict:
    return create_task(payload.get("title", "Untitled"), payload.get("due"), payload.get("description", ""))
