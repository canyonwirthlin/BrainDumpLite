# Tutorial checklist

The first-run tour (also **Settings, About, Replay tutorial**) is a replica of the app made of small mock screens. It goes stale
the moment a screen, button, tool, shortcut or setting changes, so it is part of every release (see "Tutorial protocol" in `CLAUDE.md`).
Do this after EVERY major update and again before `release.ps1`.

Files: the script (titles, copy, what each card mirrors) is `static/js/tour-steps.js`; the mock screens are `tour-scenes.js`,
`tour-templates.js` and `tour-graph.js`; the driver is `tour.js`; the styles are `static/css/tour.css`. The static guard is
`tests/test_tour.py`.

## Hard rules for the walk

- **Headless only.** Never open a visible window: use `scripts/tour_walk.mjs` (headless Edge/Chrome through `scripts/graph_shot.mjs`).
- **Sandbox vault only.** `scripts/graph_serve.py` refuses to run without an explicit throwaway data dir. Never point anything at the real vault.
- The walk switches the *sandbox's* active theme (dark `midnight`, light `paper`); that is why it refuses a non-local `--base`.

## Run it

All commands from the repo (or worktree) root. Worktrees have no `.venv`, so use the main checkout's interpreter.

```powershell
$py = "C:\Users\canyo\Desktop\Home\Coding\BrainDumpLite\.venv\Scripts\python.exe"
$out = "$env:TEMP\tour-shots"

# 1. serve a seeded sandbox vault (hidden / background; .data is git-ignored)
Start-Process -WindowStyle Hidden -FilePath $py -ArgumentList "scripts\graph_serve.py","--data","$PWD\.data","--port","8765","--dumps","140"

# 2. walk it: both themes at 1300x850 (about 3 minutes), then the narrow window
node scripts/tour_walk.mjs --base http://127.0.0.1:8765 --out $out
node scripts/tour_walk.mjs --base http://127.0.0.1:8765 --out $out --width 420 --height 800 --only sequence

# one card, after you edit it
node scripts/tour_walk.mjs --base http://127.0.0.1:8765 --out $out --only probes --step graph-link --themes midnight

# the first-run path needs an EMPTY vault (stop the seeded server first; a new data dir each time, it ends onboarded)
Start-Process -WindowStyle Hidden -FilePath $py -ArgumentList "scripts\graph_serve.py","--data","$PWD\.data-fresh","--port","8765","--empty"
node scripts/tour_walk.mjs --base http://127.0.0.1:8765 --out $out --only firstrun

# 3. the static guard and the JS syntax check
& $py -m pytest tests/test_tour.py -q
npm run lint:js
```

What the walk produces in `<out>\<theme>-<W>x<H>\`:

| files | what they are |
|---|---|
| `real-*.png` | the REAL screens the tour teaches (Capture, Graph, Search, Ask, History, Tasks, Reflect, Statistics, Settings, plus Graph's Edit tab with Link on, its `?` panel, and Capture's Templates menu) |
| `seq-NN-<card>.png` | the tour started at card 1 and advanced with **Next** through every card, ending with **Get started** (it must close the tour) |
| `probe-<card>-*.png` | each card used like a newcomer would: click, type, drag, press Ctrl+Z / Delete |
| `flow-*.png`, `firstrun/*.png` | the two places the tour starts (Settings, About, Replay tutorial; first run on an empty vault), Skip, Get started and the arrow keys |

The command exits 1 on any console error, uncaught exception or failed request (`[error] ...` lines) and on any failed expectation
(for example "Get started must close the tour"), so a clean run also proves the console is clean. A one-off `exit 3221226505` on a
`real-*` shot is Edge crashing while the machine is busy: run that shot again.

## What to compare, card by card

For every card open `seq-NN-<card>.png` and the matching `real-*.png` side by side, then the `probe-*` shots. Ask:

1. Does the mock still look like the real screen (layout, names, buttons, icons, counts)? Is anything real missing, or invented?
2. Is every claim in the title, blurb and tip still true (names, buttons, keys, what a click does, limits like "30 days")?
3. Is there something NEW or something a newcomer would get stuck on that the card does not say? Add or extend a card.
4. Light and dark both readable, no clipped text, no horizontal page scroll at 420 wide, the card fits without hidden buttons.
5. Copy: plain English, short, one idea per card. Keyboard: arrows turn cards, the mock's buttons work with Tab and Enter.

## Every card and the real screen it mirrors

`mirrors` in `tour-steps.js` holds the exact ids, classes, labels, ribbon tools and shortcuts; `test_tour.py` checks them against the code.

| card | teaches | real screen / code to compare |
|---|---|---|
| `capture` | the four capture modes and what a dump turns into | `#capture` (`views/capture.js`, `MODES` in `ui.js`); mode chips, mode info, "Dump it", "Start talking" |
| `capture-templates` | pinned template buttons, the searchable Templates menu, pinning with a star | Capture's template row (`templates-ui.js`: `mountTemplatePicker`), built-in texts in `templates.js` |
| `capture-manage` | the template manager: pin, reorder, edit, duplicate, delete, restore, new | `#settings/templates` and Capture's "Manage templates..." dialog (`templates-ui.js`: `mountTemplateManager`) |
| `capture-extras` | the mic, the Private switch, short dumps staying as typed | Capture's bottom row (`views/capture.js`: `#mic`, `#dump-private`); `app/pipeline.py` (`_is_short`); Settings, Voice |
| `capture-shortcuts` | Ctrl+Enter, Ctrl+N, Ctrl+K, Ctrl+Shift+Space | `views/capture.js`, `shell.js`, `palette.js`, `src-tauri/src/quick.rs`; Settings, Data (the from-anywhere switch) |
| `graph` | dots, hover preview, selecting, dragging | `#graph` (`graph/ribbon.js`, `hovercard.js`, `infobox.js`); View tab |
| `graph-busy` | bigger dots = more mentions; top-K names | View tab: Size by mentions, Names shown (`graph/ribbon-tools.js`, `graph/sizing.js`); the mock sizes dots like the real map |
| `graph-ribbon` | six tabs, tooltips, the round `?` help | the ribbon (`graph/ribbon.js`, `toolbar.js` `TABS`); every tab's `?` panel. The mock draws the REAL registry, so check the tabs, not the icons |
| `graph-link` | Link mode: drag a wire, select it, Delete, Esc, Ctrl+Z | Edit tab, Link (`graph/blueprint.js`); the hint chip; undo/redo (`graph/edit-tools.js`) |
| `graph-merge` | Merge mode: drag onto the same kind, no confirmation, Undo / Ctrl+Z | Edit tab, Merge (`graph/drag-merge.js`, `merge-rules.js`); the floating label and the Undo toast |
| `search` | words search, typo forgiveness, Save search | `#search` (`views/search.js`): top box, results, "Save search" |
| `search-browse` | Browse list with counts and the duplicates badge | `#search` left column (`views/search.js`: `#browse-types`) |
| `ask` | questions answered from your dumps, cited sources | `#ask` (`views/ask.js`) |
| `history` | the dump list, filters, the opened dump, editable items and tags | `#history` (`views/history.js`, `views/review.js`, `dumpedit.js`) |
| `history-manage` | Pin, Make private, Split, Merge with, Delete to Trash (30 days) | the buttons under an open dump (`dumpedit.js`), the Trash chip (`views/history.js`) |
| `tasks` | task tabs (All..Done), Not tasks (Goals, Ideas, Habits) | `#tasks` (`views/tasks.js`) |
| `tasks-more` | snooze, Reschedule, Just one thing, I have 10 minutes | `views/tasks.js`, `focus.js`, `jot.js`, `snooze.js` |
| `reflect` | week at a glance, Week in words, Plan my day, Today | `#reflect` (`views/reflect.js`) |
| `stats` | streak, longest/average streak, days dumped, words, model activity, model comparison | `#stats` (`views/stats.js`) |
| `settings` | the eight Settings sections and where Replay tutorial lives | `#settings` (`views/settings.js`: `SECTIONS`, About) |

## When the app changes

| you changed | do this |
|---|---|
| a rail screen (added, renamed, removed) | `NAV` in `shell.js` and `SCREENS`/`ICONS` must agree with `tour-steps.js`; add a card and a scene |
| text, a button or a layout on a screen | update that screen's scene in `tour-scenes.js` (copy the real markup) and its card text; re-walk |
| a Brain map tool, tab or shortcut | nothing to redraw (the ribbon is drawn from the registry) but re-read `graph-ribbon`, `graph-link`, `graph-merge` copy; add a card for a big new tool |
| templates | `tour-templates.js` |
| a Settings section | the `settings` scene lists every section (the test enforces it) |
| a new shortcut | add it to the `capture-shortcuts` card and to `KEY_EVIDENCE` in `tests/test_tour.py` |

When `tests/test_tour.py` fails it is telling you the tour is out of date: fix the tour. Do not loosen the test.
