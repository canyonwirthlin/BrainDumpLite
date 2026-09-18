import json
import sys
from pathlib import Path

import pytest

from app import db, mcp_client
from app.main import create_app

FIXTURE = str(Path(__file__).parent / "fixtures" / "echo_server.py")


def cfg(*extra_args, name="echo"):
    return {name: {"command": sys.executable, "args": [FIXTURE, *extra_args], "env": {}, "enabled": True}}


@pytest.fixture(autouse=True)
def clean():
    create_app()
    yield
    mcp_client.stop_all()
    p = mcp_client.config_path()
    if p.exists():
        p.unlink()
    db.execute("DELETE FROM settings WHERE key IN ('mcp_tools_cache', 'mcp_tool_modes')")


def test_parse_block_shapes():
    one = json.dumps({"mcpServers": {"fs": {"command": "npx", "args": ["-y", "x"]}}})
    assert mcp_client.parse_block(one)["fs"]["args"] == ["-y", "x"]
    assert "fs" in mcp_client.parse_block(json.dumps({"fs": {"command": "npx"}}))
    with pytest.raises(ValueError):
        mcp_client.parse_block(json.dumps({"command": "npx"}))
    with pytest.raises(ValueError):
        mcp_client.parse_block(json.dumps({"fs": {"args": []}}))
    with pytest.raises(ValueError):
        mcp_client.parse_block("[]")


def test_handshake_list_and_call():
    mcp_client.save_config(cfg())
    st = mcp_client.start("echo")
    assert st["running"] and [t["name"] for t in st["tools"]] == ["echo", "boom", "slow", "die"]
    assert st["tools"][0]["mode"] == "ask"
    r = mcp_client.call("echo", "echo", {"text": "hello"})
    assert r["text"].startswith("hello") and "non-text block" in r["text"] and not r["is_error"]
    assert mcp_client.call("echo", "boom", {})["is_error"]
    with pytest.raises(RuntimeError):
        mcp_client.execute_suggestion({"server": "echo", "tool": "boom", "args": {}})
    with pytest.raises(RuntimeError):
        mcp_client.call("echo", "nope", {})
    # tool list survives a stop through the settings cache
    mcp_client.stop("echo")
    assert mcp_client.status("echo")["running"] is False
    assert len(mcp_client.status("echo")["tools"]) == 4


def test_modes_and_ai_tool_list():
    mcp_client.save_config(cfg())
    mcp_client.start("echo")
    mcp_client.set_tool_mode("echo", "boom", "off")
    mcp_client.set_tool_mode("echo", "echo", "auto")
    names = {t["name"]: t["mode"] for t in mcp_client.tools(ai_only=True)}
    assert names == {"echo": "auto", "slow": "ask", "die": "ask"}
    with pytest.raises(ValueError):
        mcp_client.set_tool_mode("echo", "echo", "sometimes")
    mcp_client.set_enabled("echo", False)
    assert mcp_client.tools(ai_only=True) == []
    with pytest.raises(RuntimeError):
        mcp_client.call("echo", "echo", {"text": "x"})


def test_timeout_and_crash():
    mcp_client.save_config(cfg())
    mcp_client.start("echo")
    with pytest.raises(TimeoutError):
        mcp_client._get("echo")._request("tools/call", {"name": "slow", "arguments": {"seconds": 3}}, timeout=0.5)
    with pytest.raises(RuntimeError):
        mcp_client.call("echo", "die", {})
    # a dead process restarts on the next call
    assert mcp_client.call("echo", "echo", {"text": "again"})["text"].startswith("again")


def test_bad_command_and_no_handshake():
    mcp_client.save_config({"nope": {"command": "definitely-not-a-real-binary-xyz", "args": [], "enabled": True}})
    with pytest.raises(RuntimeError, match="not on PATH"):
        mcp_client.start("nope")
    mcp_client.save_config(cfg("--no-init", name="mute"))
    with pytest.raises(RuntimeError):
        mcp_client.start("mute")
    assert mcp_client.status("mute")["error"]
    with pytest.raises(ValueError):
        mcp_client.start("ghost")


def test_config_roundtrip_via_routes():
    from fastapi.testclient import TestClient
    c = TestClient(create_app())
    assert c.get("/api/mcp/servers").json() == []
    block = json.dumps({"mcpServers": cfg()})
    assert c.post("/api/mcp/servers", json={"config": block}).json()["added"] == ["echo"]
    assert c.post("/api/mcp/servers", json={"config": "{oops"}).status_code == 400
    servers = c.get("/api/mcp/servers").json()
    assert servers[0]["name"] == "echo" and servers[0]["command"] == sys.executable
    assert c.post("/api/mcp/servers/echo/start").json()["running"]
    assert c.post("/api/mcp/call", json={"server": "echo", "tool": "echo", "args": {"text": "hi"}}).json()["text"].startswith("hi")
    assert c.put("/api/mcp/tools/echo/echo/mode", json={"mode": "auto"}).json()["ok"]
    assert [t for t in c.get("/api/mcp/tools").json() if t["name"] == "echo"][0]["mode"] == "auto"
    c.post("/api/mcp/servers/echo/stop")
    assert c.delete("/api/mcp/servers/echo").json()["ok"]
    assert c.get("/api/mcp/servers").json() == []
