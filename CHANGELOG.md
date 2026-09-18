# Changelog

Written by hand before every release. The section for the version being
released becomes the GitHub release notes AND the "What's New" panel in the
app. Format: `## X.Y.Z — YYYY-MM-DD`, then markdown. Newest first.

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
