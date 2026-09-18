"""Provider-switchable AI client. One SDK (openai), four configs:

  anthropic — Claude via Anthropic's OpenAI-compatible endpoint (chat only,
              no embeddings → linking falls back to keyword search)
  openai    — chat + embeddings
  local     — any OpenAI-compatible server (LM Studio, Ollama, llama.cpp)
  off       — app still works; dumps are stored raw, no AI stages run

Every LLM call in the app goes through chat() / chat_json() / embed().
"""
from __future__ import annotations

import json
import re
import threading

from openai import OpenAI, BadRequestError

from . import db

# Local model servers (LM Studio/Ollama/llama.cpp) generally run ONE generation
# at a time — concurrent dumps (fired back-to-back before the first finishes)
# would otherwise queue overlapping requests that interleave and come back
# truncated/garbled. Serialising all calls costs cloud-provider users nothing
# they'd notice and makes local mode correct under real (impatient) usage.
_llm_lock = threading.Lock()

DEFAULTS = {
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1/",
        "model": "claude-sonnet-5",
        "embed_model": "",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-5-mini",
        "embed_model": "text-embedding-3-small",
    },
    "local": {
        "base_url": "http://localhost:1234/v1",
        "model": "",
        "embed_model": "",
    },
}


class AIError(RuntimeError):
    pass


def config() -> dict:
    provider = db.get_setting("provider", "off")
    d = DEFAULTS.get(provider, {})
    return {
        "provider": provider,
        "api_key": db.get_setting("api_key", "") or "",
        "base_url": db.get_setting("base_url") or d.get("base_url", ""),
        "model": db.get_setting("model") or d.get("model", ""),
        "embed_model": db.get_setting("embed_model") or d.get("embed_model", ""),
    }


def available() -> bool:
    c = config()
    if c["provider"] not in ("anthropic", "openai", "local"):
        return False
    if c["provider"] in ("anthropic", "openai") and not c["api_key"]:
        return False
    return bool(c["model"])


def _client(c: dict | None = None) -> OpenAI:
    c = c or config()
    return OpenAI(
        api_key=c["api_key"] or "not-needed",
        base_url=c["base_url"],
        timeout=120.0,
        max_retries=1,
    )


def chat(system: str, user: str, max_tokens: int = 2048, temperature: float = 0.4) -> str:
    """Chat completion → plain text. Raises AIError on any failure."""
    c = config()
    if not available():
        raise AIError("No AI provider configured")

    kwargs: dict = {
        "model": c["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    # Reasoning models (gpt-5 family, qwen3.x, Claude w/ thinking) burn
    # completion tokens on hidden reasoning BEFORE the answer — a small cap
    # yields an empty or mid-JSON-truncated response, so floor the budget.
    # But do NOT exceed a local server's context window: llama.cpp lets the
    # model reason until context is exhausted, turning every failure into a
    # minutes-long wait for an empty reply. Local models commonly load with a
    # 4k context, so cap local budgets at 4096; cloud contexts are huge and
    # get generous headroom instead.
    if c["provider"] == "openai":
        # gpt-5-family models reject max_tokens and non-default temperature.
        kwargs["max_completion_tokens"] = max(max_tokens, 8192)
    elif c["provider"] == "anthropic":
        kwargs["max_tokens"] = max(max_tokens, 8192)
        kwargs["temperature"] = temperature
    else:
        kwargs["max_tokens"] = min(max(max_tokens, 2048), 4096)
        kwargs["temperature"] = temperature
    if c["provider"] in ("local", "openai"):
        # Pipeline calls are simple extraction tasks; unbounded thinking on
        # local reasoning models (qwen3.x) can eat the whole token budget and
        # minutes of wall time. Measured on LM Studio: 5x faster at "low"
        # with no quality change for this workload. Servers/models that don't
        # know the param get a retry without it below.
        kwargs["extra_body"] = {"reasoning_effort": "low"}

    with _llm_lock:
        for attempt in (1, 2):
            try:
                resp = _client(c).chat.completions.create(**kwargs)
                break
            except BadRequestError as e:
                msg = str(e)
                # Swap param styles once if the endpoint disagrees with our guess.
                if attempt == 1 and "max_completion_tokens" in msg and "max_tokens" in kwargs:
                    kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
                    kwargs.pop("temperature", None)
                    continue
                if attempt == 1 and "max_tokens" in msg and "max_completion_tokens" in kwargs:
                    kwargs["max_tokens"] = kwargs.pop("max_completion_tokens")
                    continue
                if attempt == 1 and "temperature" in msg:
                    kwargs.pop("temperature", None)
                    continue
                if attempt == 1 and "extra_body" in kwargs and (
                        "reasoning" in msg or "unknown" in msg.lower() or "unrecognized" in msg.lower()):
                    kwargs.pop("extra_body", None)
                    continue
                raise AIError(f"Model request rejected: {msg[:300]}") from e
            except Exception as e:  # connection, auth, timeout…
                raise AIError(f"AI call failed: {e}") from e

    def _finish(resp):
        choice = resp.choices[0]
        out = (choice.message.content or "").strip()
        # Some local models leak reasoning blocks into content.
        out = re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
        if not out:
            detail = " (all tokens spent on reasoning)" if choice.finish_reason == "length" else ""
            raise AIError(f"Model returned an empty completion{detail}")
        if choice.finish_reason == "length":
            raise AIError("Model output truncated at the token limit")
        return out

    try:
        return _finish(resp)
    except AIError:
        # Thinking models occasionally enter a stochastic reasoning loop and
        # burn the whole budget. One re-roll usually escapes it.
        with _llm_lock:
            try:
                resp = _client(c).chat.completions.create(**kwargs)
            except Exception as e:
                raise AIError(f"AI call failed on retry: {e}") from e
        return _finish(resp)


def chat_json(system: str, user: str, max_tokens: int = 3000) -> dict:
    text = chat(
        system + "\n\nRespond with ONLY a valid JSON object. No markdown fences.",
        user,
        max_tokens=max_tokens,
        temperature=0.2,
    )
    return extract_json(text)


def extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except (json.JSONDecodeError, ValueError) as e:
            raise AIError(f"Model produced invalid JSON: {e}") from e
    raise AIError("No JSON object in model output")


def embed(text: str) -> list[float] | None:
    """Embedding, or None when the provider can't do them (anthropic / off /
    local without an embed model). Callers must handle None — keyword search
    is the fallback everywhere."""
    c = config()
    if c["provider"] == "openai":
        model = c["embed_model"] or "text-embedding-3-small"
    elif c["provider"] == "local" and c["embed_model"]:
        model = c["embed_model"]
    else:
        return None
    try:
        with _llm_lock:
            resp = _client(c).embeddings.create(model=model, input=text[:6000])
        return list(resp.data[0].embedding)
    except Exception:
        return None


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def list_models() -> list[str]:
    try:
        return sorted(m.id for m in _client().models.list().data)
    except Exception as e:
        raise AIError(f"Could not list models: {e}") from e


def test_connection() -> dict:
    """Cheap end-to-end check used by the Settings page."""
    c = config()
    if not available():
        return {"ok": False, "message": "Provider not fully configured (missing key or model)."}
    try:
        reply = chat("Reply with the single word OK.", "ping", max_tokens=2000)
        emb = embed("connection test")
        return {
            "ok": True,
            "message": f"Connected — model replied ({reply[:40]}). "
            + ("Embeddings working." if emb else "No embeddings (keyword search will be used)."),
        }
    except AIError as e:
        return {"ok": False, "message": str(e)}
