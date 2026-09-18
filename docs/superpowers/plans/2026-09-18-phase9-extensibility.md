# Phase 9: Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-09-18-phase9-extensibility-design.md`.

**Architecture:** `mcp_client.py` (stdio JSON-RPC, `<data>/mcp.json`, per-tool gate) and
`plugins.py` (folder plugins, narrow API) both feed Phase 8's suggestions inbox through two
new executor kinds. Frontend: Settings → Plugins & MCP, palette "Run a tool…", generic Inbox
cards, session confirm cards.

### Task 1: MCP client
- [ ] `app/mcp_client.py` + `tests/fixtures/echo_server.py` + tests (handshake, list, call, timeout, crash).
- [ ] Routes: `/mcp/servers` CRUD + paste-config, `/mcp/tools`, `/mcp/tools/{server}/{tool}/call`, per-tool mode.
- [ ] Commit `feat(mcp): stdio MCP client, server config, tool gating`.

### Task 2: Plugins
- [ ] `app/plugins.py` (loader, API object, isolation), example plugin, docs/plugins.md, tests.
- [ ] Suggestion kinds `mcp_tool` + `plugin_action`; pipeline hook calls `plugins.on_dump`.
- [ ] Routes: `/plugins` list/enable/disable/install/reload. Commit `feat(plugins): folder plugin loader and generic suggestion executors`.

### Task 3: Frontend
- [ ] Settings → Plugins & MCP; palette "Run a tool…"; generic inbox cards; argument form from `inputSchema`.
- [ ] Session tool proposals behind the Advanced "Tools in chat" switch.
- [ ] Verify in the browser with the echo server; commit `feat(ui): plugins & MCP settings, tool runner, tool cards`.

### Task 4: Release 0.13.0
- [ ] Changelog, merge, `.\release.ps1 0.13.0`.
