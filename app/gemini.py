"""Gemini model discovery. Google retires and renames models constantly (2.5 Flash closed
to new users, text-embedding-004 shut down), so nothing here hard-codes a model name:
the list comes from Google's own /models endpoint, the default is the best *free-tier*
model that actually answers for the user's key, and a saved model that later vanishes is
replaced automatically (heal()).

"Best free" = newest stable Flash, then Flash-Lite, then previews. Pro models are listed
for manual choice but never picked by default: they are paid-only on the free tier, and a
user with billing on would be silently charged for the most expensive model.
"""
from __future__ import annotations

import re
import threading
import time

import httpx

from . import db

BASE = "https://generativelanguage.googleapis.com/v1beta"
TIER_ORDER = {"flash": 0, "flash-lite": 1, "pro": 2}
# Not text-in/text-out chat models, or unstable research variants — never offered.
_SKIP_WORDS = {"image", "tts", "live", "audio", "native", "vision", "computer", "robotics",
               "customtools", "exp", "experimental", "thinking", "dialog", "embedding"}
_CHAT_RE = re.compile(r"^gemini-(?P<ver>\d+(?:\.\d+)?)-(?P<tier>flash-lite|flash|pro)(?P<rest>(?:-[a-z0-9.]+)*)$")
_ALIAS_RE = re.compile(r"^gemini-(?P<tier>flash-lite|flash|pro)-latest$")
_EMBED_RE = re.compile(r"^gemini-embedding-(?P<ver>[a-z0-9]+)(?P<rest>(?:-[a-z0-9.]+)*)$")


class GeminiError(RuntimeError):
    pass


# ── Talking to Google ────────────────────────────────────────────────────────

def _err_text(r: httpx.Response) -> str:
    try:
        return str(r.json().get("error", {}).get("message") or r.text)[:300]
    except ValueError:
        return r.text[:300]


def _bad_key(r: httpx.Response) -> bool:
    text = _err_text(r).lower()
    return r.status_code in (400, 401, 403) and ("api key" in text or "api_key" in text)


def fetch_models(api_key: str) -> list[dict]:
    """Every model Google lists for this key, as {id, label, methods}."""
    if not api_key:
        raise GeminiError("Enter your Google API key first.")
    out: list[dict] = []
    token = None
    for _ in range(10):
        params = {"pageSize": 1000, **({"pageToken": token} if token else {})}
        try:
            r = httpx.get(f"{BASE}/models", params=params, headers={"x-goog-api-key": api_key}, timeout=20)
        except httpx.HTTPError as e:
            raise GeminiError(f"Couldn't reach Google: {e}") from e
        if _bad_key(r):
            raise GeminiError("Google rejected that API key — check it and try again.")
        if r.status_code != 200:
            raise GeminiError(f"Google's model list failed ({r.status_code}): {_err_text(r)}")
        d = r.json()
        for m in d.get("models", []):
            out.append({"id": str(m.get("name", "")).removeprefix("models/"),
                        "label": m.get("displayName") or "",
                        "methods": m.get("supportedGenerationMethods") or []})
        token = d.get("nextPageToken")
        if not token:
            break
    return out


def _probe(api_key: str, model: str, method: str, body: dict) -> tuple[bool, str]:
    try:
        r = httpx.post(f"{BASE}/models/{model}:{method}", json=body, headers={"x-goog-api-key": api_key}, timeout=30)
    except httpx.HTTPError as e:
        return False, f"network: {e}"
    if _bad_key(r):
        raise GeminiError("Google rejected that API key — check it and try again.")
    return r.status_code == 200, _err_text(r) if r.status_code != 200 else ""


def probe_chat(api_key: str, model: str) -> tuple[bool, str]:
    return _probe(api_key, model, "generateContent", {
        "contents": [{"parts": [{"text": "Reply with the single word OK."}]}],
        "generationConfig": {"maxOutputTokens": 16}})


def probe_embed(api_key: str, model: str) -> tuple[bool, str]:
    return _probe(api_key, model, "embedContent", {"content": {"parts": [{"text": "ping"}]}, "outputDimensionality": 768})


# ── Ranking ──────────────────────────────────────────────────────────────────

def _version(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)) or (0,)


def classify_chat(models: list[dict]) -> list[dict]:
    """Chat-capable models, best first, each tagged {id, label, tier, kind, note, default_ok}.
    kind: stable | preview | snapshot (dated/numbered build) | alias (gemini-flash-latest)."""
    out = []
    for m in models:
        if "generateContent" not in m["methods"]:
            continue
        mid = m["id"]
        a = _ALIAS_RE.match(mid)
        c = _CHAT_RE.match(mid)
        if a:
            tier, kind, ver = a["tier"], "alias", (0,)
        elif c:
            words = set(c["rest"].strip("-").split("-")) if c["rest"] else set()
            if words & _SKIP_WORDS:
                continue
            tier, ver = c["tier"], _version(c["ver"])
            kind = "stable" if not c["rest"] else "preview" if "preview" in words else "snapshot"
        else:
            continue
        note = {"pro": "may need a paid plan", "flash-lite": "lighter, faster"}.get(tier, "")
        if kind == "preview":
            note = (note + ", " if note else "") + "preview"
        if kind == "alias":
            note = "always the newest " + tier.replace("-", " ")
        out.append({"id": mid, "label": m["label"] or mid, "tier": tier, "kind": kind, "ver": ver, "note": note,
                    "default_ok": tier != "pro" and kind in ("stable", "preview")})
    kind_rank = {"stable": 0, "preview": 1, "snapshot": 2, "alias": 3}
    # Free defaults first (all Flash before any Flash-Lite, newest first, stable before preview),
    # then everything else for manual choice.
    out.sort(key=lambda m: (not m["default_ok"], TIER_ORDER[m["tier"]] if m["default_ok"] else 0,
                            kind_rank[m["kind"]] if m["default_ok"] else 0,
                            tuple(-x for x in m["ver"]), TIER_ORDER[m["tier"]], kind_rank[m["kind"]], m["id"]))
    return out


def classify_embed(models: list[dict]) -> list[dict]:
    out = []
    for m in models:
        e = _EMBED_RE.match(m["id"])
        if not e or not ({"embedContent", "batchEmbedContents"} & set(m["methods"])):
            continue
        kind = "stable" if not e["rest"] else "preview"
        out.append({"id": m["id"], "label": m["label"] or m["id"], "kind": kind, "ver": _version(e["ver"]),
                    "note": "preview" if kind == "preview" else ""})
    out.sort(key=lambda m: (m["kind"] != "stable", tuple(-x for x in m["ver"]), m["id"]))
    return out


def _public(m: dict) -> dict:
    return {k: m[k] for k in ("id", "label", "note") if k in m}


# ── Setup / heal ─────────────────────────────────────────────────────────────

def setup(api_key: str, probe: bool = True, max_probes: int = 6) -> dict:
    """List the models and (when probe=True) find the best one that really answers for
    this key. Without probing, `model` is just the top-ranked candidate."""
    models = fetch_models(api_key)
    chat, embed = classify_chat(models), classify_embed(models)
    cands = [m for m in chat if m["default_ok"]]
    chosen, tried = None, []
    if probe:
        for m in cands[:max_probes]:
            ok, why = probe_chat(api_key, m["id"])
            if ok:
                chosen = m["id"]
                break
            tried.append({"id": m["id"], "why": why})
    else:
        chosen = cands[0]["id"] if cands else None
    emb = None
    for m in embed[:2] if probe else embed[:1]:
        if not probe or probe_embed(api_key, m["id"])[0]:
            emb = m["id"]
            break
    return {"chat_models": [_public(m) for m in chat], "embed_models": [_public(m) for m in embed],
            "model": chosen, "embed_model": emb, "tried": tried}


_heal_lock = threading.Lock()
_heal_at: dict[str, float] = {}


def heal(kind: str) -> str | None:
    """A saved model stopped working (retired, or closed to new users): pick and save the
    best replacement. At most once per 10 minutes per kind so a bad key can't spin."""
    with _heal_lock:
        if time.time() - _heal_at.get(kind, 0) < 600:
            return None
        _heal_at[kind] = time.time()
    key = db.get_setting("api_key", "") or ""
    if not key:
        return None
    try:
        r = setup(key, probe=True)
    except GeminiError:
        return None
    new = r["model"] if kind == "chat" else r["embed_model"]
    if new:
        db.set_setting("model" if kind == "chat" else "embed_model", new)
    return new
