"""Phone capture over Wi-Fi (opt-in).

A SECOND, tiny FastAPI app (`build_phone_app`) is served by its own uvicorn thread on 0.0.0.0 only while the
user has "Capture from my phone" switched on. That app exposes exactly two things and nothing else (every other
path is a plain 404, no docs/openapi):

  GET  /p/<token>        -> static/phone.html (a minimal capture page)
  POST /phone/capture    -> creates a dump through the normal create-dump path

The token is random, lives in the settings table, is compared in constant time, and can be rotated. Requests are
rate-limited per client IP (with a global brake on bad-token guesses) and body-size capped. The listener is never
started automatically at boot: it is off after every restart until the user turns it on again.

Plain HTTP on the LAN: anyone on the same Wi-Fi who sees the URL/token can add dumps (never read them).
"""
from __future__ import annotations

import hmac
import json
import secrets
import socket
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from . import db, lock

DEFAULT_PORT = 8790
MAX_TEXT_CHARS = 20_000
MAX_BODY_BYTES = 64 * 1024
RATE_LIMIT = 15           # captures per client IP per window
RATE_WINDOW = 60.0        # seconds
BAD_TOKEN_LIMIT = 10      # failed token attempts (any client) per window before everything is refused
_hits: dict[str, deque] = defaultdict(deque)
_bad: deque = deque()
_rl_lock = threading.Lock()


# ── token ────────────────────────────────────────────────────────────────────

def get_token(create: bool = True) -> str | None:
    tok = db.get_setting("phone_token")
    if not tok and create:
        tok = secrets.token_urlsafe(16)
        db.set_setting("phone_token", tok)
    return tok


def rotate_token() -> str:
    tok = secrets.token_urlsafe(16)
    db.set_setting("phone_token", tok)
    return tok


def token_ok(candidate: str | None) -> bool:
    tok = db.get_setting("phone_token")
    if not tok or not candidate:
        return False
    return hmac.compare_digest(str(candidate).encode(), str(tok).encode())


# ── rate limiting ────────────────────────────────────────────────────────────

def _prune(dq: deque, now: float) -> None:
    while dq and now - dq[0] > RATE_WINDOW:
        dq.popleft()


def _blocked_by_bad_tokens(now: float) -> bool:
    with _rl_lock:
        _prune(_bad, now)
        return len(_bad) >= BAD_TOKEN_LIMIT


def _note_bad_token(now: float) -> None:
    with _rl_lock:
        _bad.append(now)


def _rate_limited(ip: str, now: float) -> bool:
    with _rl_lock:
        dq = _hits[ip]
        _prune(dq, now)
        if len(dq) >= RATE_LIMIT:
            return True
        dq.append(now)
        if len(_hits) > 256:  # bound memory
            for k in [k for k, v in _hits.items() if not v]:
                _hits.pop(k, None)
        return False


def reset_limits() -> None:
    with _rl_lock:
        _hits.clear()
        _bad.clear()


# ── the phone-facing app ─────────────────────────────────────────────────────

def _page_path() -> Path:
    from .main import static_dir
    return static_dir() / "phone.html"


_SEC_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}


def build_phone_app() -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/p/{token}")
    def page(token: str):
        now = time.monotonic()
        if _blocked_by_bad_tokens(now):
            return Response(status_code=429, headers=_SEC_HEADERS)
        if not token_ok(token):
            _note_bad_token(now)
            return Response(status_code=404, headers=_SEC_HEADERS)
        try:
            html = _page_path().read_text(encoding="utf-8")
        except OSError:
            return Response(status_code=404, headers=_SEC_HEADERS)
        return HTMLResponse(html, headers=_SEC_HEADERS)

    @app.post("/phone/capture")
    async def capture(request: Request):
        now = time.monotonic()
        if _blocked_by_bad_tokens(now):
            return JSONResponse({"detail": "too many bad attempts"}, 429, headers=_SEC_HEADERS)
        if not token_ok(request.headers.get("x-phone-token")):
            _note_bad_token(now)
            return JSONResponse({"detail": "forbidden"}, 403, headers=_SEC_HEADERS)
        ip = request.client.host if request.client else "?"
        if _rate_limited(ip, now):
            return JSONResponse({"detail": "slow down"}, 429, headers=_SEC_HEADERS)
        if lock.locked():
            return JSONResponse({"detail": "locked"}, 423, headers=_SEC_HEADERS)
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            declared = 0
        if declared > MAX_BODY_BYTES:
            return JSONResponse({"detail": "too large"}, 413, headers=_SEC_HEADERS)
        raw = b""
        async for chunk in request.stream():   # cap even when Content-Length lies / is absent
            raw += chunk
            if len(raw) > MAX_BODY_BYTES:
                return JSONResponse({"detail": "too large"}, 413, headers=_SEC_HEADERS)
        try:
            text = str(json.loads(raw or b"{}").get("text", "")).strip()
        except (ValueError, AttributeError):
            return JSONResponse({"detail": "bad request"}, 400, headers=_SEC_HEADERS)
        if not text:
            return JSONResponse({"detail": "empty"}, 400, headers=_SEC_HEADERS)
        if len(text) > MAX_TEXT_CHARS:
            return JSONResponse({"detail": "too large"}, 413, headers=_SEC_HEADERS)
        return JSONResponse(create_dump_from_phone(text), headers=_SEC_HEADERS)

    return app


def create_dump_from_phone(text: str) -> dict:
    """Normal create-dump path (queueing, pipeline), then run its background tasks in a thread."""
    from .routes import DumpIn, create_dump
    bg = BackgroundTasks()
    out = create_dump(DumpIn(text=text, mode="freeform"), bg)
    for t in bg.tasks:
        threading.Thread(target=t.func, args=t.args, kwargs=t.kwargs, daemon=True).start()
    return {"ok": True, "id": out["id"]}


# ── listener lifecycle ───────────────────────────────────────────────────────

_srv: dict = {"server": None, "thread": None, "port": None}


def lan_ip() -> str | None:
    """Best-effort LAN address (UDP connect sends no packets)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def running() -> bool:
    t = _srv["thread"]
    return bool(t and t.is_alive() and _srv["server"] is not None)


def start(host: str = "0.0.0.0", port: int | None = None) -> int:
    """Start the phone listener (idempotent). Returns the port actually used."""
    import uvicorn
    if running():
        return _srv["port"]
    want = port or int(db.get_setting("phone_port", DEFAULT_PORT) or DEFAULT_PORT)
    chosen = None
    for p in range(want, want + 20):
        with socket.socket() as s:
            try:
                s.bind((host, p))
                chosen = p
                break
            except OSError:
                continue
    if chosen is None:
        raise RuntimeError("no free port for the phone listener")
    get_token()
    server = uvicorn.Server(uvicorn.Config(build_phone_app(), host=host, port=chosen, log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True, name="phone-capture")
    th.start()
    _srv.update(server=server, thread=th, port=chosen)
    return chosen


def stop() -> None:
    server, th = _srv["server"], _srv["thread"]
    if server is not None:
        server.should_exit = True
    if th is not None:
        th.join(timeout=5)
    _srv.update(server=None, thread=None, port=None)


def status() -> dict:
    on = running()
    ip = lan_ip()
    port = _srv["port"]
    tok = get_token(create=False)
    url = f"http://{ip}:{port}/p/{tok}" if (on and ip and tok) else None
    return {"enabled": on, "port": port, "lan_ip": ip, "url": url}
