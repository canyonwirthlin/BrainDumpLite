"""Provider-switchable AI client. One SDK (openai), five configs:

  builtin   — llama.cpp servers the app downloads and manages itself
              (see engine.py) — chat + embeddings, fully offline
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

# Token usage of the last completion/embedding on THIS thread (instrument.py
# reads it right after the call). Providers that omit usage leave it None.
_usage = threading.local()


def reset_usage() -> None:
    _usage.value = None


def last_usage() -> dict | None:
    return getattr(_usage, "value", None)


def _capture_usage(resp) -> None:
    u = getattr(resp, "usage", None)
    if u is None:
        return
    _usage.value = {"prompt_tokens": getattr(u, "prompt_tokens", None),
                    "completion_tokens": getattr(u, "completion_tokens", None)}

DEFAULTS = {
    # builtin's real base_url/model are managed by engine.py at runtime;
    # the settings rows exist only so provider switching has defaults to reset.
    "builtin": {
        "base_url": "",
        "model": "",
        "embed_model": "",
    },
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
    if provider == "builtin":
        # State lives in engine.py, not the generic settings rows — so a Save
        # from the settings page can never break a working built-in setup.
        from . import engine
        return {
            "provider": "builtin",
            "api_key": "",
            "base_url": engine.chat_base_url(),
            "model": engine.active_model(),
            "embed_model": engine.EMBED_MODEL["id"],
        }
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
    if c["provider"] == "builtin":
        from . import engine
        return engine.is_configured()
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


def chat(system: str, user: str, max_tokens: int = 2048, temperature: float = 0.4,
         json_object: bool = False, schema: dict | None = None) -> str:
    """Chat completion → plain text. Raises AIError on any failure."""
    c = config()
    if not available():
        raise AIError("No AI provider configured")
    if c["provider"] == "builtin":
        # Blocks while the managed server boots (first call after app launch).
        from . import engine
        try:
            engine.ensure_chat_running()
        except Exception as e:
            raise AIError(str(e)) from e
        c = config()  # base_url now points at the live server

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
    if c["provider"] in ("local", "builtin", "openai"):
        # Pipeline calls are simple extraction tasks; unbounded thinking on
        # local reasoning models (qwen3.x) can eat the whole token budget and
        # minutes of wall time. Measured on LM Studio: 5x faster at "low"
        # with no quality change for this workload. Servers/models that don't
        # know the param get a retry without it below.
        kwargs["extra_body"] = {"reasoning_effort": "low"}
    if schema is not None and c["provider"] in ("local", "builtin"):
        # THE reliable path for small local models: llama.cpp compiles a JSON
        # *schema* into a strict GBNF grammar that constrains generation, so
        # the output is guaranteed valid + correctly shaped. Plain json_object
        # is only advisory on some builds (observed: Llama-3.2-3B emitting
        # unquoted "•" bullets 5/5 times through json_object, 0/5 through
        # json_schema). Cloud models don't need it and OpenAI's strict mode
        # rejects optional properties, so scope this to local/builtin.
        kwargs["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "response", "schema": schema},
        }
    elif json_object and c["provider"] in ("local", "builtin", "openai"):
        # Weaker guardrail for the rest — a nudge toward valid JSON.
        # Anthropic's compat endpoint doesn't support it.
        kwargs["response_format"] = {"type": "json_object"}

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
                if attempt == 1 and "response_format" in msg and "response_format" in kwargs:
                    kwargs.pop("response_format", None)
                    continue
                if attempt == 1 and "extra_body" in kwargs and (
                        "reasoning" in msg or "unknown" in msg.lower() or "unrecognized" in msg.lower()):
                    kwargs.pop("extra_body", None)
                    continue
                raise AIError(f"Model request rejected: {msg[:300]}") from e
            except Exception as e:  # connection, auth, timeout…
                raise AIError(f"AI call failed: {e}") from e

    def _finish(resp):
        _capture_usage(resp)
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


def chat_stream(messages: list[dict], max_tokens: int = 400, temperature: float = 0.7):
    """Stream a chat completion as text deltas (Phase 4 sessions). `messages`
    includes the system message. Raises AIError before the first delta if the
    provider can't be reached; errors mid-stream end the generator."""
    c = config()
    if not available():
        raise AIError("No AI provider configured")
    if c["provider"] == "builtin":
        from . import engine
        try:
            engine.ensure_chat_running()
        except Exception as e:
            raise AIError(str(e)) from e
        c = config()
    kwargs: dict = {"model": c["model"], "messages": messages, "stream": True}
    if c["provider"] == "openai":
        kwargs["max_completion_tokens"] = max(max_tokens, 2048)
    else:
        kwargs["max_tokens"] = min(max(max_tokens, 400), 2048)
        kwargs["temperature"] = temperature
    if c["provider"] in ("local", "builtin", "openai"):
        kwargs["extra_body"] = {"reasoning_effort": "low"}
    try:
        with _llm_lock:
            stream = _client(c).chat.completions.create(**kwargs)
    except BadRequestError as e:
        # Same param-style fallback as chat(): retry once without the extras.
        kwargs.pop("extra_body", None)
        kwargs.pop("temperature", None)
        try:
            with _llm_lock:
                stream = _client(c).chat.completions.create(**kwargs)
        except Exception as e2:
            raise AIError(f"AI call failed: {e2}") from e2
    except Exception as e:
        raise AIError(f"AI call failed: {e}") from e
    for chunk in stream:
        if not getattr(chunk, "choices", None):
            continue
        delta = chunk.choices[0].delta
        text = getattr(delta, "content", None)
        if text:
            yield text


def chat_json(system: str, user: str, max_tokens: int = 3000, schema: dict | None = None) -> dict:
    text = chat(
        system + "\n\nRespond with ONLY a valid JSON object. No markdown fences.",
        user,
        max_tokens=max_tokens,
        temperature=0.2,
        json_object=True,
        schema=schema,
    )
    return extract_json(text)


def extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    # strict=False: models love putting literal newlines inside string values
    # (multi-line bullet summaries) — invalid JSON strictly, but unambiguous.
    try:
        return json.loads(text, strict=False)
    except (json.JSONDecodeError, ValueError):
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0), strict=False)
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
    elif c["provider"] == "builtin":
        from . import engine
        if not engine.ensure_embed_running():
            return None
        c = dict(c, base_url=engine.embed_base_url())
        model = c["embed_model"]
        text = text[:4000]  # nomic-embed runs with a 2k-token context
    else:
        return None
    try:
        with _llm_lock:
            resp = _client(c).embeddings.create(model=model, input=text[:6000])
        _capture_usage(resp)
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
        if c["provider"] == "builtin":
            return {"ok": False, "message": "Built-in AI isn't set up yet — pick a model above."}
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
