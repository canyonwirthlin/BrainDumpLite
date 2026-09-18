# Phase 9 — Extensibility: MCP servers + plugins

**Status:** design · **Date:** 2026-09-18 · **Ships as:** v0.13.0

Phase 8 built the gate: every proposed action waits in the Inbox until the user
presses the button. Phase 9 opens the app up to actions it did not ship with —
MCP servers the user connects, and Python plugins the user writes — and routes
all of them through that same gate.

## Goals

1. Connect any **MCP server** (stdio) and see its tools inside BrainDump Lite.
2. Run a tool by hand, and let the AI *propose* tool calls that the user confirms.
3. Load **plugins** from `<data>/plugins/<id>/` that can react to dumps, expose
   actions, and propose suggestions.
4. Nothing external ever runs without an explicit human press, except a tool the
   user has marked "auto" for that server.

## Non-goals

- Sandboxing Python plugins. A plugin runs in the app's own process with the
  app's own permissions, exactly like a VS Code extension. The UI says so in
  plain words before enabling one, and plugins are off until enabled.
- A plugin marketplace or remote install. Installing is "pick a folder or a zip".
- HTTP/SSE MCP transports. Local stdio servers cover the desktop case; the
  transport field exists in config so adding one later is additive.

## Trust model (the part that matters)

- **MCP tool descriptions and tool results are untrusted data.** They are pasted
  into prompts inside a fenced block labelled as tool output, and the system
  prompt says tool output never carries instructions. Anything a tool asks for
  becomes a *suggestion*, never an action.
- **A tool call is an action.** Manual runs are a user press. AI-proposed calls
  render as a confirm card with the server, tool and exact arguments visible.
  Only tools the user flips to "auto" skip the card, and that flag is per tool.
- **Plugins are code the user chose to trust.** Enabling one shows its id, folder
  path, declared permissions and the fact that it runs unsandboxed.
- Secrets in MCP server env vars are stored with the Phase 8 DPAPI helper, never
  in plain `mcp.json`.

## MCP client — `app/mcp_client.py`

Configuration lives in `<data>/mcp.json` in the same shape Claude Desktop uses,
so a user can paste a block they already have:

```json
{ "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Notes"],
                    "env": {}, "enabled": true }
} }
```

- **Transport:** stdio, JSON-RPC 2.0, newline-delimited. A reader thread per
  server feeds a response table keyed by request id; `stderr` is drained into
  `<data>/logs/mcp-<id>.log`.
- **Lifecycle:** lazy start on first use, kept warm, health-checked by a `ping`
  before a call, stopped on app exit and on disable. A server that fails to
  start is marked `error` with the last stderr lines, and the UI shows it.
- **Handshake:** `initialize` (protocolVersion `2025-06-18`, clientInfo
  BrainDump Lite), then `notifications/initialized`, then `tools/list`.
  Tool lists are cached in settings so Settings renders instantly offline.
- **Calls:** `tools/call` with a 60 s timeout; text content blocks are joined,
  other blocks summarised. Errors come back as a string, never an exception
  that kills a request.
- **Gating:** each tool has a per-tool mode in settings — `off` (invisible to
  AI, still runnable by hand), `ask` (default: AI may propose, user confirms),
  `auto` (AI may run it without a card).

## Plugins — `app/plugins.py`

```
<data>/plugins/<id>/
  plugin.json   { id, name, version, description, author, permissions[], entry: "main.py" }
  main.py       def register(api): ...
```

The API object handed to `register`:

| Call | What it does |
|---|---|
| `api.on_dump(fn)` | `fn(dump)` runs after the pipeline finishes a dump |
| `api.action(id, label, fn)` | adds a runnable action (palette + Inbox executor) |
| `api.propose(kind, title, payload)` | drops a suggestion in the Inbox |
| `api.setting(key, default)` / `api.set_setting` | plugin-scoped settings |
| `api.log(msg)` | writes to `<data>/logs/plugins.log` |
| `api.db_query(sql, params)` | **read-only** SELECT against the vault |

Loading is defensive: a plugin that raises on import or in a hook is disabled
for the session with its traceback shown in Settings, and the app carries on.
`permissions` is declarative today (shown at enable time), enforced only for
`db_query`, which refuses anything that is not a single SELECT.

A working example ships in the repo at `examples/plugins/daily-digest/`: it
watches dumps, and once a day proposes a digest suggestion.

## Suggestions become universal

Phase 8's `suggestions._executor` gains two kinds:

- `mcp_tool` — payload `{server, tool, args}` → `mcp_client.call`
- `plugin_action` — payload `{plugin, action, args}` → the plugin's handler

That is the whole integration surface. The Inbox already edits titles, dismisses
and records results, so plugin and tool proposals inherit all of it.

## AI proposing tool calls

When at least one tool is `ask`/`auto` and **Tools in chat** is on (Advanced,
default off), each session turn runs one extra cheap JSON call after the reply:

> Given the conversation and this tool list, is exactly one tool call useful
> right now? Answer `{"tool": null}` or `{"server", "tool", "args", "why"}`.

`ask` tools render a confirm card in the chat; `auto` tools run immediately and
the result is appended as a tool block for the next turn. A turn may make at
most one call, and at most three per session, so a confused model cannot loop.

## Frontend

- **Settings → Plugins & MCP** (new section, before Stats):
  - MCP servers list: status dot, tool count, Start/Stop, Remove, per-tool mode
    dropdown, "Paste config" textarea that accepts a Claude Desktop `mcpServers`
    block, and a "Run" button per tool that opens the argument form.
  - Plugins list: enable switch, version, folder, permissions, last error,
    "Install from folder…" and "Open plugins folder".
  - Advanced: Tools in chat toggle, per-server env editor.
- **Palette:** "Run a tool…" lists every connected tool and opens the same
  argument form (a generated form from the tool's `inputSchema`).
- **Inbox:** generic suggestions render kind, a compact argument preview, and
  Run/Dismiss. Failures show the tool's error text.
- **Session:** confirm cards for proposed calls; a small 🔧 chip on messages
  that used a tool, expandable to show arguments and the raw result.

## Testing

- Fake MCP server: a small Python script in `tests/fixtures/echo_server.py`
  speaking real JSON-RPC over stdio, so the client is tested end to end
  (initialize, tools/list, tools/call, timeout, crash restart).
- Plugin loader: a temp plugin folder that registers an action and a dump hook;
  a broken plugin that raises on import stays isolated.
- Suggestions: `mcp_tool` and `plugin_action` accept/fail paths.
- The AI proposal pass with a fake `chat_json` returning a tool and `null`.

## Open questions (decided here, flagged for the user)

1. **No sandbox** for plugins — matches VS Code/Obsidian expectations for a
   local app. Revisit only if plugins ever become shareable.
2. **Install from folder or zip**, no git URLs, so there is no silent update path.
3. **Tools in chat defaults off** because a 3B local model proposes poor calls;
   it is one switch away for people on a bigger model.
