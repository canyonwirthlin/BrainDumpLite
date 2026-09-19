# Changelog

Written by hand before every release. The section for the version being
released becomes the GitHub release notes AND the "What's New" panel in the
app. Format: `## X.Y.Z — YYYY-MM-DD`, then markdown. Newest first.

## 0.14.0 — 2026-09-19
- Graph and Search moved up in the left rail, right under Capture.
- Theme editor: pick every color by hand, name your own theme, and see the whole app repaint live before you save. Edit a built-in theme to start a copy of it.
- Node types are yours to customize: rename or recolor Dumps, Concepts and People from the Graph legend (with a reset), and add your own node types right there too — the AI looks for them from the next dump on.
- Delete a downloaded built-in model to free up space, including the one you're currently using; stray or partial download files can be cleared too.
- Optional "Show AI output as it arrives" panel under Processing, off by default, for watching what each pipeline stage actually produced.
- Removed the Gemma 4 family from the model catalog (e2b/e4b/12b/26b-a4b/31b): a user report showed classify failing outright on it with this app's pinned llama.cpp build. Held back pending a fix or an engine upgrade.

## 0.13.2 — 2026-09-18
- The built-in model catalog grows from 4 to 17 models, from 3B up to 32B: Qwen, Mistral, IBM Granite, Microsoft Phi, Ai2 Olmo and more, including a mixture-of-experts model for bigger GPUs.
- Every model now shows its size, parameter count, quantization, license, the GPU memory it needs, the RAM a CPU-only run needs, and plain-language caveats. Models bigger than your GPU are flagged before you download them.
- New 12, 16 and 24 GB filters, and search now matches model family and license.
- The list is sorted smallest to largest. The recommended model for your GPU can now be a bigger one if your card has the room.
- Only models that answer directly are listed, because ones that think out loud first can run out of response budget.

## 0.13.1 — 2026-09-18
- Fixes the release build. Every release since 0.5.0 failed before producing an installer because the automated tests could not find the app; this is the first one that should reach you. No changes inside the app.

## 0.13.0 — 2026-09-18
- Connect MCP servers: paste the same config block you'd give any other desktop client and their tools appear in the app. Run one from Settings or from Ctrl+K.
- Every tool has its own switch: hidden from the AI, propose-and-confirm, or run freely.
- In a conversation, the AI can now suggest a tool call and show you exactly what it would send before you press Run. Off by default, in Settings → Plugins & MCP → Advanced.
- Plugins: drop a folder of Python in your plugins directory to react to dumps, add actions and propose things. An example plugin ships with the app; anything a plugin proposes waits in the Inbox.

## 0.12.0 — 2026-09-18
- New Inbox: when a dump produces a dated task or event, the app proposes sending it to your connected services and waits. Nothing leaves your machine until you press the button, and you can edit the title and date first.
- Google Calendar connects with one click (Settings → Integrations). Tokens are encrypted with Windows DPAPI, and the app only ever pushes what you approve.
- Todoist connects with a personal API token.
- "Send to…" on any task pushes it straight to Calendar or Todoist.
- Reflect → Plan my day fits your open tasks into the free gaps around your real calendar events, then blocks the ones you pick.

## 0.11.0 — 2026-09-18
- Google Gemini is a provider now (free tier from AI Studio), with embeddings for semantic search.
- Built-in AI has a browsable model catalog: search, filter by VRAM, see tags; nothing downloads until you press Get. "Check for new models" pulls the latest curated list.
- New Settings → Stats: model calls, success rate, latency per stage, tokens and estimated cost per provider, dumps per day, vault growth.

## 0.10.0 — 2026-09-18
- Export any dump, or the whole vault, as Obsidian-compatible markdown with [[wikilinks]] (toggleable).
- Type [[ in the editor to link concepts, people or dumps with autocomplete; explicit links always count.
- Import a folder of markdown notes: each file becomes a dump and runs through the pipeline in the background.
- Multiple vaults: create or add vault folders and switch between them in Settings → Data.
- Git mirror: point at a repo you own and "Sync now" commits a markdown copy of everything plus a backup zip.

## 0.9.0 — 2026-09-18
- The graph knows your item types: every type is a colored node kind you can toggle from the legend (off by default), and Focus dims everything more than two hops from what you select.
- Click a concept or person to browse every dump that mentions it; every dump shows what it's linked from.
- New Today view: the day's dumps in order with their items, a quick-capture box on top, and a way to walk back day by day.
- Reflect opens with an "on this day" card resurfacing an older dump.

## 0.8.0 — 2026-09-18
- Therapy and Brainstorm are now conversations: pick the mode, hit "Talk it through", and the AI replies live while it notes the items it hears. Ending the chat saves it as one dump.
- Unfinished conversations wait in History with a Resume link.
- Optional app lock: set a passphrase in Settings → Data and the app locks at launch and after 10 idle minutes.
- Optional nudge notification when you haven't captured anything for three days (Settings → Data).

## 0.7.0 — 2026-09-18
- Extraction types are yours to customize: add "Question", "Decision", anything — the AI looks for them from the next dump on (Settings → AI → Advanced).
- Every dump now gets a tone (calm, anxious, excited…) and every item an effort estimate, an urgency marker and the time phrase it came from.
- On-device / cloud badge on every dump so you always know where your text went.
- Search finds items too, not just dumps.
- Backup and restore your whole vault as one zip (Settings → Data).
- Move the vault to any folder, e.g. a synced Dropbox/OneDrive folder.

## 0.6.0 — 2026-09-18
- New look: a slim left rail, a focused Capture stage, and History/Tasks as list + detail side by side.
- Ctrl+K command palette: jump anywhere, switch themes, open recent dumps. Ctrl+N starts a new dump.
- Settings reorganised into sections (Appearance, AI, Voice, Data, About); each has an "Advanced" switch so the basics stay simple.
- Themes are now JSON files: import your own, export the current one.
- Bundled Inter font, compact density and reduced-motion options.
- Graph fills the window; toggle dumps/concepts/people from the legend.

## 0.5.0 — 2026-09-18
- BrainDump Lite is now a real Windows app: an installer, a Start Menu entry, its own window (no more black console + browser tab).
- Tray icon: closing the window keeps the app running; right-click → Quit to exit.
- Automatic updates with release notes shown in the app before you install.
- "What's New" panel after every update (Settings → About shows it any time).
- Your existing data and downloaded AI models carry over unchanged.

## 0.4.3 — 2026-07-20
- Built-in local AI engine (llama.cpp) with curated models picked by VRAM.
- Semantic search via a bundled embedding model.
