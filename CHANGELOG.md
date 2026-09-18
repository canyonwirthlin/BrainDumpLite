# Changelog

Written by hand before every release. The section for the version being
released becomes the GitHub release notes AND the "What's New" panel in the
app. Format: `## X.Y.Z — YYYY-MM-DD`, then markdown. Newest first.

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
