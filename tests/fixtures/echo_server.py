"""A tiny real MCP server over stdio, used by the client tests.

Tools: echo (returns its text), boom (isError), slow (sleeps), die (exits).
Run with --no-init to test a server that never completes the handshake.
"""
import json
import sys
import time

TOOLS = [
    {"name": "echo", "description": "Echo the text back.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "boom", "description": "Always fails.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "slow", "description": "Sleeps.", "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}}},
    {"name": "die", "description": "Exits the process.", "inputSchema": {"type": "object", "properties": {}}},
]


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    silent = "--no-init" in sys.argv
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
        if rid is None:
            continue
        if method == "initialize":
            if silent:
                continue
            send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                                                          "serverInfo": {"name": "echo", "version": "1.0"}}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            if name == "echo":
                send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": args.get("text", "")},
                                                                          {"type": "image", "data": "x"}]}})
            elif name == "boom":
                send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "it broke"}], "isError": True}})
            elif name == "slow":
                time.sleep(float(args.get("seconds", 5)))
                send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "awake"}]}})
            elif name == "die":
                sys.exit(3)
            else:
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": f"unknown tool {name}"}})
        else:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})


if __name__ == "__main__":
    main()
