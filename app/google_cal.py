"""Google Calendar via OAuth 2.0 (Phase 8): one-click sign-in with PKCE and a
loopback redirect on the app's own port, tokens in DPAPI-protected settings,
plain HTTPS calls (no SDK). Push-only plus free/busy reads for the planner."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets as pysecrets
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from . import db, secrets

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3"
SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly"
_pending: dict = {}   # state -> {verifier, redirect}


def client() -> dict:
    cfg = db.get_setting("google_client") or {}
    return {"id": (cfg.get("id") or "").strip(), "secret": (cfg.get("secret") or "").strip()}


def set_client(client_id: str, secret: str) -> None:
    """An empty secret keeps the saved one (the UI never echoes it back)."""
    secret = secret.strip() or client().get("secret", "")
    db.set_setting("google_client", {"id": client_id.strip(), "secret": secret})


def _http(method: str, url: str, data: dict | None = None, token: str | None = None, form: bool = False) -> dict:
    headers = {"Accept": "application/json"}
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Google API {e.code}: {detail}") from e


def auth_url(port: int) -> str:
    c = client()
    if not c["id"]:
        raise ValueError("set a Google OAuth client id first (Settings → Integrations → Advanced)")
    verifier = base64.urlsafe_b64encode(pysecrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = pysecrets.token_urlsafe(24)
    redirect = f"http://127.0.0.1:{port}/oauth/google/callback"
    _pending.clear()
    _pending[state] = {"verifier": verifier, "redirect": redirect}
    q = {"client_id": c["id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
         "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
         "access_type": "offline", "prompt": "consent"}
    return AUTH_URL + "?" + urllib.parse.urlencode(q)


def handle_callback(code: str, state: str) -> dict:
    p = _pending.pop(state, None)
    if not p:
        raise ValueError("unknown or expired sign-in state — start again from Settings")
    c = client()
    data = {"code": code, "client_id": c["id"], "redirect_uri": p["redirect"], "grant_type": "authorization_code",
            "code_verifier": p["verifier"]}
    if c["secret"]:
        data["client_secret"] = c["secret"]
    tok = _http("POST", TOKEN_URL, data, form=True)
    if "access_token" not in tok:
        raise ValueError("Google did not return a token")
    _store(tok, keep_refresh=None)
    return {"connected": True, "account": account()}


def _store(tok: dict, keep_refresh: str | None) -> None:
    prev = _tokens() or {}
    rec = {"access_token": tok["access_token"], "refresh_token": tok.get("refresh_token") or keep_refresh or prev.get("refresh_token"),
           "expires_at": time.time() + int(tok.get("expires_in", 3600)) - 60, "scope": tok.get("scope", SCOPES)}
    secrets.set_secret("google_tokens", json.dumps(rec))


def _tokens() -> dict | None:
    raw = secrets.get_secret("google_tokens")
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def connected() -> bool:
    return bool(_tokens())


def disconnect() -> None:
    secrets.set_secret("google_tokens", None)
    db.execute("DELETE FROM settings WHERE key='google_account'")


def _access_token() -> str:
    t = _tokens()
    if not t:
        raise RuntimeError("Google Calendar is not connected")
    if t["expires_at"] > time.time():
        return t["access_token"]
    c = client()
    data = {"client_id": c["id"], "refresh_token": t.get("refresh_token", ""), "grant_type": "refresh_token"}
    if c["secret"]:
        data["client_secret"] = c["secret"]
    tok = _http("POST", TOKEN_URL, data, form=True)
    _store(tok, keep_refresh=t.get("refresh_token"))
    return tok["access_token"]


def account() -> str | None:
    cached = db.get_setting("google_account")
    if cached:
        return cached
    try:
        info = _http("GET", API + "/calendars/primary", token=_access_token())
        db.set_setting("google_account", info.get("id") or info.get("summary"))
        return info.get("id") or info.get("summary")
    except Exception:
        return None


def events(day: str) -> list[dict]:
    """Events on a local calendar day: [{title, start, end, all_day}]."""
    start = datetime.fromisoformat(day + "T00:00").astimezone()
    end = start + timedelta(days=1)
    q = urllib.parse.urlencode({"timeMin": start.isoformat(), "timeMax": end.isoformat(), "singleEvents": "true", "orderBy": "startTime"})
    data = _http("GET", f"{API}/calendars/primary/events?{q}", token=_access_token())
    out = []
    for e in data.get("items", []):
        s, en = e.get("start", {}), e.get("end", {})
        out.append({"title": e.get("summary", "(busy)"), "start": s.get("dateTime") or s.get("date"),
                    "end": en.get("dateTime") or en.get("date"), "all_day": "date" in s})
    return out


def create_event(title: str, due: str, description: str = "") -> dict:
    """`due` is YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:MM (one hour)."""
    body: dict = {"summary": title, "description": (description + "\n\nFrom BrainDump Lite").strip()}
    if "T" in due:
        s = datetime.fromisoformat(due).astimezone()
        e = s + timedelta(hours=1)
        body["start"], body["end"] = {"dateTime": s.isoformat()}, {"dateTime": e.isoformat()}
    else:
        nxt = (datetime.fromisoformat(due + "T00:00") + timedelta(days=1)).date().isoformat()
        body["start"], body["end"] = {"date": due}, {"date": nxt}
    ev = _http("POST", f"{API}/calendars/primary/events", body, token=_access_token())
    return {"id": ev.get("id"), "link": ev.get("htmlLink")}


def execute_push(payload: dict) -> dict:
    if not payload.get("due"):
        raise ValueError("a date is needed for a calendar event")
    return create_event(payload.get("title", "Untitled"), payload["due"], payload.get("description", ""))
