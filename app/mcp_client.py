"""MCP client (Phase 9): talks JSON-RPC 2.0 over stdio to local MCP servers.

Config lives in <data>/mcp.json in Claude Desktop's shape, so a block the user
already has can be pasted in. Everything a server says — tool names,
descriptions, results — is untrusted data: it is shown and prompted as content,
and any action it wants goes through the suggestions inbox.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time

from . import db

PROTOCOL = "2025-06-18"
CALL_TIMEOUT = 60.0
START_TIMEOUT = 25.0
MODES = ("off", "ask", "auto")          # per-tool exposure to the AI
_servers: dict[str, "Server"] = {}
_lock = threading.Lock()


# ── config ───────────────────────────────────────────────────────────────────

def config_path():
    return db.data_dir() / "mcp.json"


def load_config() -> dict:
    p = config_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return data.get("mcpServers") or {}


def save_config(servers: dict) -> None:
    config_path().write_text(json.dumps({"mcpServers": servers}, indent=2), encoding="utf-8")


def parse_block(text: str) -> dict:
    """Accept a whole Claude Desktop config, a bare mcpServers object, or one server."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    if "mcpServers" in data:
        data = data["mcpServers"]
    if "command" in data:
        raise ValueError('wrap the server in a name, e.g. {"my-server": {"command": …}}')
    out = {}
    for name, cfg in data.items():
        if not isinstance(cfg, dict) or not cfg.get("command"):
            raise ValueError(f"'{name}' has no command")
        out[name] = {"command": str(cfg["command"]), "args": [str(a) for a in cfg.get("args") or []],
                     "env": {str(k): str(v) for k, v in (cfg.get("env") or {}).items()},
                     "enabled": cfg.get("enabled", True)}
    if not out:
        raise ValueError("no servers in that block")
    return out


def add_servers(text: str) -> list[str]:
    new = parse_block(text)
    cfg = load_config()
    cfg.update(new)
    save_config(cfg)
    return list(new)


def remove_server(name: str) -> None:
    cfg = load_config()
    cfg.pop(name, None)
    save_config(cfg)
    stop(name)
    _tool_cache_write({k: v for k, v in _tool_cache().items() if k != name})


def set_enabled(name: str, enabled: bool) -> None:
    cfg = load_config()
    if name in cfg:
        cfg[name]["enabled"] = bool(enabled)
        save_config(cfg)
    if not enabled:
        stop(name)


# ── per-tool gating + tool cache ─────────────────────────────────────────────

def _modes() -> dict:
    return db.get_setting("mcp_tool_modes", {}) or {}


def tool_mode(server: str, tool: str) -> str:
    return _modes().get(f"{server}/{tool}", "ask")


def set_tool_mode(server: str, tool: str, mode: str) -> None:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    m = _modes()
    m[f"{server}/{tool}"] = mode
    db.set_setting("mcp_tool_modes", m)


def _tool_cache() -> dict:
    return db.get_setting("mcp_tools_cache", {}) or {}


def _tool_cache_write(data: dict) -> None:
    db.set_setting("mcp_tools_cache", data)


# ── one server process ───────────────────────────────────────────────────────

class Server:
    def __init__(self, name: str, cfg: dict):
        self.name, self.cfg = name, cfg
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self.started_at: float | None = None
        self._id = 0
        self._replies: dict[int, dict] = {}
        self._event = threading.Condition()
        self._io = threading.Lock()

    # -- process ------------------------------------------------------------
    def running(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def _log_path(self):
        d = db.data_dir() / "logs"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"mcp-{''.join(c if c.isalnum() or c in '-_' else '_' for c in self.name)}.log"

    def start(self) -> None:
        if self.running():
            return
        cmd = self.cfg.get("command", "")
        exe = shutil.which(cmd) or (shutil.which(cmd + ".cmd") if os.name == "nt" else None)
        if not exe:
            raise RuntimeError(f"'{cmd}' is not on PATH — install it, or give the full path in the command field")
        env = {**os.environ, **(self.cfg.get("env") or {})}
        env.setdefault("PYTHONIOENCODING", "utf-8")
        log = open(self._log_path(), "ab", buffering=0)
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen([exe, *self.cfg.get("args", [])], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=log, env=env, creationflags=flags, bufsize=0)
        self.started_at = time.time()
        self.error = None
        threading.Thread(target=self._reader, daemon=True).start()
        try:
            info = self._request("initialize", {
                "protocolVersion": PROTOCOL, "capabilities": {},
                "clientInfo": {"name": "BrainDump Lite", "version": __import__("app.version", fromlist=["__version__"]).__version__},
            }, timeout=START_TIMEOUT)
            self._notify("notifications/initialized", {})
            self.server_info = info.get("serverInfo") or {}
            self.refresh_tools()
        except Exception as e:
            self.error = str(e)[:400] + self._tail()
            self.stop()
            raise RuntimeError(self.error)

    def _tail(self, n: int = 3) -> str:
        try:
            lines = self._log_path().read_text(encoding="utf-8", errors="replace").strip().splitlines()[-n:]
            return ("\n" + "\n".join(lines)) if lines else ""
        except OSError:
            return ""

    def stop(self) -> None:
        p, self.proc = self.proc, None
        if not p:
            return
        try:
            p.stdin.close()
        except Exception:
            pass
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()

    # -- JSON-RPC -----------------------------------------------------------
    def _reader(self) -> None:
        proc = self.proc
        while proc and proc.poll() is None:
            try:
                line = proc.stdout.readline()
            except (OSError, ValueError):
                break
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") is not None:
                with self._event:
                    self._replies[msg["id"]] = msg
                    self._event.notify_all()

    def _send(self, payload: dict) -> None:
        if not self.running():
            raise RuntimeError(f"'{self.name}' is not running")
        data = (json.dumps(payload) + "\n").encode("utf-8")
        with self._io:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict, timeout: float = CALL_TIMEOUT) -> dict:
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout
        with self._event:
            while rid not in self._replies:
                if not self.running():
                    raise RuntimeError(f"'{self.name}' exited" + self._tail())
                if time.time() >= deadline:
                    raise TimeoutError(f"'{self.name}' did not answer {method} in {int(timeout)}s")
                self._event.wait(0.25)
            msg = self._replies.pop(rid)
        if "error" in msg:
            err = msg["error"]
            raise RuntimeError(f"{err.get('message', 'error')} ({err.get('code')})")
        return msg.get("result") or {}

    # -- tools --------------------------------------------------------------
    def refresh_tools(self) -> list[dict]:
        res = self._request("tools/list", {})
        self.tools = [{"name": t.get("name", "?"), "description": (t.get("description") or "")[:600],
                       "inputSchema": t.get("inputSchema") or {}} for t in res.get("tools", [])]
        cache = _tool_cache()
        cache[self.name] = self.tools
        _tool_cache_write(cache)
        return self.tools

    def call(self, tool: str, args: dict) -> dict:
        res = self._request("tools/call", {"name": tool, "arguments": args or {}})
        parts, other = [], 0
        for block in res.get("content", []):
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            else:
                other += 1
        text = "\n".join(parts).strip()
        if other:
            text += f"\n[{other} non-text block{'s' if other != 1 else ''} omitted]"
        return {"text": text[:20000], "is_error": bool(res.get("isError")), "server": self.name, "tool": tool}


# ── module-level API ─────────────────────────────────────────────────────────

def _get(name: str, start: bool = True) -> Server:
    cfg = load_config().get(name)
    if not cfg:
        raise ValueError(f"no MCP server called '{name}'")
    if not cfg.get("enabled", True):
        raise RuntimeError(f"'{name}' is disabled")
    with _lock:
        s = _servers.get(name)
        if not s or s.cfg != cfg:
            if s:
                s.stop()
            s = _servers[name] = Server(name, cfg)
    if start and not s.running():
        s.start()
    return s


def start(name: str) -> dict:
    _get(name)
    return status(name)


def stop(name: str) -> None:
    with _lock:
        s = _servers.pop(name, None)
    if s:
        s.stop()


def stop_all() -> None:
    for name in list(_servers):
        stop(name)


def status(name: str | None = None) -> dict | list[dict]:
    cfg = load_config()
    cache = _tool_cache()

    def one(n: str) -> dict:
        s, c = _servers.get(n), cfg.get(n, {})
        tools = (s.tools if s and s.tools else cache.get(n, []))
        return {"name": n, "command": c.get("command", ""), "args": c.get("args", []),
                "env_keys": sorted((c.get("env") or {}).keys()), "enabled": c.get("enabled", True),
                "running": bool(s and s.running()), "error": s.error if s else None,
                "tools": [{**t, "mode": tool_mode(n, t["name"])} for t in tools]}

    return one(name) if name else [one(n) for n in cfg]


def tools(ai_only: bool = False) -> list[dict]:
    """Flat tool list across servers; ai_only keeps ask/auto tools of enabled servers."""
    out = []
    for s in status():
        if not s["enabled"]:
            continue
        for t in s["tools"]:
            if ai_only and t["mode"] == "off":
                continue
            out.append({**t, "server": s["name"]})
    return out


def call(server: str, tool: str, args: dict | None = None) -> dict:
    return _get(server).call(tool, args or {})


def execute_suggestion(payload: dict) -> dict:
    r = call(payload.get("server", ""), payload.get("tool", ""), payload.get("args") or {})
    if r["is_error"]:
        raise RuntimeError(r["text"][:300] or "the tool reported an error")
    return r
