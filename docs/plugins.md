# Writing a BrainDump Lite plugin

A plugin is a folder. Drop it in your plugins directory (Settings → Plugins &
MCP → Open plugins folder, or use Install from folder), enable it, and it runs.

```
daily-digest/
  plugin.json
  main.py
```

**Plugins are not sandboxed.** They run inside the app with your account's
permissions, like a VS Code extension. Only enable code you have read or trust.

## plugin.json

```json
{
  "id": "daily-digest",
  "name": "Daily digest",
  "version": "1.0.0",
  "description": "One line, shown in Settings.",
  "author": "you",
  "permissions": ["read-vault", "propose-suggestions"],
  "entry": "main.py"
}
```

`id` must be lowercase letters, digits, `-` or `_`. `entry` must be a `.py` file
in the same folder. `permissions` is shown to the user before they enable the
plugin; only `read-vault` is enforced today, by `api.db_query`.

## main.py

```python
def register(api):
    api.on_dump(lambda dump: api.log("saw " + dump["title"]))
    api.action("shout", "Shout a thing", lambda args: {"said": args["text"].upper()})
```

`register(api)` runs once at load. Raising anything disables the plugin for the
session and shows the traceback in Settings; the rest of the app keeps going.

## The api object

| Call | What it does |
|---|---|
| `api.on_dump(fn)` | `fn(dump)` after the pipeline finishes a dump (dict of the dumps row) |
| `api.action(id, label, fn)` | registers `fn(args) -> dict`, runnable from Settings → Plugins & MCP and the API |
| `api.propose(...)` | **removed in 0.20** (the Inbox is gone): logs a line and does nothing. Use `api.action` |
| `api.setting(key, default)` / `api.set_setting(key, value)` | plugin-scoped settings |
| `api.db_query(sql, params)` | one read-only `SELECT` against the vault |
| `api.log(msg)` | appends to `logs/plugins.log` in your data folder |
| `api.id`, `api.folder` | your plugin id and its folder as a `Path` |

## Actions

Nothing a plugin does runs on its own. Register an action with `api.action` and
the user presses it from the plugin's card in Settings → Plugins & MCP; the
result (or the error) is shown right there.

## A working example

`examples/plugins/daily-digest/` in the repository is a complete plugin: a dump
hook, an action, plugin settings, and a read-only query. Copy it and edit.

## Useful tables

`dumps(id, created_at, captured_local, mode, raw_text, title, summary, tone,
provider, status)` · `items(id, dump_id, kind, content, detail, due_date,
priority, est_minutes, urgency, status, done)` · `links(from_id, to_id, kind)` ·
`sessions`, `reflections`, `runs`. Query them with `api.db_query`.
