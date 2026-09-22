# Changelog

Written by hand before every release. The section for the version being
released becomes the GitHub release notes AND the "What's New" panel in the
app. Format: `## X.Y.Z — YYYY-MM-DD`, then markdown. Newest first.

## 0.19.3 — 2026-09-21
- Cleaned dumps now read like a proper journal entry: reorganized into paragraphs so related thoughts sit together, grammatically correct, in an order that makes sense rather than the order you happened to say things — nothing is added, removed, or reworded in meaning.
- Settings → AI: the Delete button on a downloaded model now shows even when it's your only one (or the one currently in use) — it turns built-in AI off until you pick another. Clicking Start/Use this/Get now immediately shows "Starting…" instead of sitting there looking unresponsive while it loads.

## 0.19.2 — 2026-09-21
- Removed the Today tab. It only re-listed what you'd already dumped; Capture, History and Tasks cover it. The tutorial no longer shows it either.

## 0.19.1 — 2026-09-20
- BrainDump Lite can only be open once now. Launching it again (Start Menu, a double-click, the startup item) brings the window that's already running to the front instead of starting a second copy that fights over your vault.
- New setting: Settings → Data → "Quit when I close the window". Off (the default) keeps the current behaviour — the close button sends the app to the tray. On, the close button quits it for real. Streak reminders only fire while the app is running, so they stop when you quit.

## 0.19.0 — 2026-09-20
- BrainDump Lite now runs on macOS, for both Apple Silicon and Intel Macs. Download the .dmg from the releases page; the app is not notarized yet, so the first launch needs right-click → Open (the friends guide has the steps). It uses the normal Mac title bar and ⌘ shortcuts, sits in the menu bar, comes back when you click the Dock icon, and updates itself like the Windows app. Your data lives in ~/Library/Application Support/BrainDumpLite.
- On a Mac, pick Gemini (free), Claude, OpenAI or your own server for the AI. The built-in local AI is Windows-only for now, so it isn't offered on Mac.
- Under the hood: every release now also starts the packaged backend on each Mac build before publishing, so a broken package can't ship.

## 0.18.2 — 2026-09-20
- Fixes Gemini. Google closed 2.5 Flash to new users and shut down the old search model, so setup failed with a fresh key. The app now asks Google for its current model list, picks the newest free model that actually answers for your key (never a Pro model, so nothing gets billed by surprise), and lets you choose any other model from a dropdown in onboarding and Settings → AI ("Pick best" and "Refresh list" buttons). If a saved model is ever retired, the app swaps in a working one on its own.

## 0.18.1 — 2026-09-20
- Reworked how recurring topics connect. The concept grouping from 0.18.0 was too aggressive (it could fold "home lab" into "home") and the AI prompt grew with every concept you had, so both are gone. Concepts now only merge when they're spelling variants (case, plural, word order). Instead, a new dump is softly linked to earlier dumps whose concepts share a distinctive word (e.g. "internship search" ↔ "internships"), without renaming anything or adding to the prompt. Words that appear across many dumps are ignored, and you can remove any link from the dump page.

## 0.18.0 — 2026-09-20
- Edit anything the AI produced: rename a dump, edit each extracted item's text / first step / type, and add, rename or remove concepts and people. Add or remove links between dumps. Works right after a dump and from History.
- Dump pages now show the cleaned transcript first, with the key-point bullets underneath it.
- "Export .md" (and Settings → "Export all as markdown") opens a Save-as window so you choose where the file goes.
- Capture modes look and feel different: each has its own colour, headline and a short explainer that appears when you pick it. Brainstorm and Therapy are now a chat window (with AI on); Execution is a ruled checklist. Text you type before "Start talking" now becomes your first message instead of being dropped.
- History moved above Today in the left rail.
- Tasks opens on a new "All" tab (every open task, nothing from Done), then Overdue / Today / Upcoming / Someday / Done.
- Graph: a Spacing slider above the graph controls how far apart nodes sit.
- Topics that come up in several dumps now connect: similar concept names ("internships" / "internship applications") are grouped in the graph, concept pages and "Also about", and the AI is told your existing concept names so it reuses them.
- The tutorial is now an interactive replica of the app — click through every tab and try demo versions of capture, history editing, tasks, the graph and more. Nothing you do in it is saved. Replay it from Settings → About.
- Streak reminders are on by default (opt out during setup or in Settings → Data). The "Skip tutorial" button is now in the window corner.

## 0.17.1 — 2026-09-20
- Your current streak now shows right on the Capture screen too, not just Statistics — click it to jump to the full breakdown. Warns you when today's still open.

## 0.17.0 — 2026-09-20
- New Statistics tab: a daily dump streak (gained by dumping once a day, lost after a full empty day — the flame warns you when today's still open), longest and average streak, days dumped, words dumped this week/month/year/all-time, plus the model-activity numbers that used to live under Settings → Stats.
- Onboarding now asks whether to open at startup, with the free-tier "open at startup" being the honest choice: closing the window already just sends it to the tray, this only decides whether it's there when you log in. Shows the actual background footprint for the AI provider you picked (RAM/CPU while idle vs. while a dump is processing).
- The built-in local model now unloads itself after 10 idle minutes and reloads on the next dump — RAM/VRAM back for everything else when you're not actively using it.
- Opt-in notifications (Settings → Data) remind you about today's dump / streak every couple hours, only during waking hours, and only until you've dumped that day.
- The tutorial now covers every tab, including the new Statistics one, and mentions the startup/notification settings.
- `scripts/install_count.py`: a rough, privacy-respecting install count from GitHub's own public release download stats — no telemetry in the app itself. See the README's "Checking install counts" section.

## 0.16.0 — 2026-09-19
- The window no longer looks like a browser tab: a custom titlebar with its own minimize/maximize/close replaces the OS chrome, UI elements (buttons, nav, chips, labels) no longer drag-select like webpage text, right-click no longer shows a browser menu on the app's own chrome, and Ctrl+scroll/Ctrl+=/− page-zoom is disabled.
- Onboarding's "Recommended" badge now checks your hardware: a capable GPU points you at the free built-in local model, otherwise it points at Gemini's free tier instead — with a line explaining why.

## 0.15.0 — 2026-09-19
- First-run setup: pick an AI provider before doing anything else. Free options (Gemini's free tier, the built-in local model) are front and center; Claude and OpenAI are clearly marked as paid, with a cost acknowledgement before you can continue. A step-by-step tutorial walks through getting a free Gemini API key, with `gemini-2.5-flash` recommended for this app.
- A short, skippable tour of the app follows setup — Capture, Today/Tasks, History/Search/Graph, Inbox, and Settings in six slides. Replay it anytime from Settings → About.
- Removed the per-dump "reflection" (the brainstorm/therapy/execution/freeform AI take shown after Processing) — it burned an extra model call on every single dump for a paragraph nobody acted on. Capture modes still pick the tone of a live "Talk it through" conversation.

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
