#!/usr/bin/env node
// Headless walk-through of the tutorial against a RUNNING sandbox app (never the real vault). Node >= 22, built-ins only.
//
//   1. serve a seeded sandbox:   .venv\Scripts\python.exe scripts\graph_serve.py --data "$PWD\.data" --port 8765
//   2. walk it:                  node scripts/tour_walk.mjs --base http://127.0.0.1:8765 --out <folder>
//        --themes midnight,paper   themes to walk (default both: one dark, one light). Switches the SANDBOX's active theme.
//        --width 1300 --height 850 viewport (default 1300x850; use --width 420 --height 800 for a narrow phone-like window)
//        --only real|sequence|flows|probes|firstrun   just one part (default: the first four; firstrun needs an EMPTY vault, see below)
//        --step graph-link         probes for one card only
//
//   real      screenshots of the real screens the tutorial teaches (compare them side by side with the tour cards)
//   sequence  starts the tour, presses Next through EVERY card (one screenshot each) and finishes with Get started
//   flows     Settings, About, Replay tutorial opens the tour; Skip and Get started close it; the arrow keys turn cards
//   probes    for each card: opens it directly, uses it like a newcomer would (click, type, drag, Ctrl+Z) and screenshots
//             each state. The walk fails (exit 1) on any console error, uncaught exception or failed resource, so a clean
//             run also proves the console is clean.
// Output: <out>/<theme>-<WxH>/real-*.png, seq-NN-<card>.png, probe-<card>-*.png. See docs/TUTORIAL-CHECKLIST.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const base = opt("base", "http://127.0.0.1:8765").replace(/\/$/, "");
const out = resolve(opt("out", "tour-shots"));
const width = +opt("width", 1300), height = +opt("height", 850);
const themes = opt("themes", "midnight,paper").split(",");
const only = opt("only", "all"), onlyStep = opt("step", "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) { console.error("tour_walk: refusing a non-local --base (sandbox vault only)"); process.exit(2); }

// tour-steps.js is pure data; load it from a data: URL so node does not warn about the package having no "type".
const stepsSrc = readFileSync(join(here, "..", "static", "js", "tour-steps.js"), "utf8");
const { STEPS } = await import("data:text/javascript;base64," + Buffer.from(stepsSrc).toString("base64"));
let failures = 0;

// `expect` = { "<eval text printed as STEP n>": reason }: a run also fails when an eval step printed something else than expected.
function shot(args, label, expect = {}) {
  const r = spawnSync(process.execPath, [join(here, "graph_shot.mjs"), ...args], { encoding: "utf8", timeout: 120000 });
  const lines = (r.stdout + r.stderr).split(/\r?\n/).filter((l) => /^\[error\]|^graph_shot:|EVAL|STEP/.test(l) && !/^SHOT/.test(l));
  const printed = new Set(lines.filter((l) => /^STEP /.test(l)).map((l) => l.replace(/^STEP \d+ /, "")));
  const missed = Object.keys(expect).filter((v) => !printed.has(JSON.stringify(v)));
  if (r.status !== 0 || missed.length) {
    failures++; console.log(`FAIL ${label} (exit ${r.status})`);
    missed.forEach((v) => console.log(`   expected "${v}": ${expect[v]}`));
    lines.forEach((l) => console.log("   " + l));
  } else console.log(`ok   ${label}`);
  return r;
}
const run = (dir, name, hash, steps = [], extra = [], expect = {}) => shot(["--url", `${base}/${hash}`, "--width", width, "--height", height, "--wait", "1800", ...extra,
  ...(steps.length ? ["--steps", JSON.stringify(steps)] : []), "--out", join(dir, name + ".png")].map(String), name, expect);
const evalOpen = "document.querySelector('#onboarding') ? 'open' : 'closed'";

// Open the tour as a replica of Settings → About → Replay tutorial (or at a given card) on top of the page.
const startTour = (card = "") => `(()=>{const el=document.createElement('div');el.id='onboarding';document.body.appendChild(el);import('/js/tour.js').then(m=>m.runTour(el,()=>el.remove()${card ? `,'${card}'` : ""}));return 1})()`;
// a point on the mock map, given in the 640x300 design grid of tour-graph.js (nodes sit at those coordinates, scaled to the box)
const svgPt = (x, y) => ({ js: `(()=>{const r=document.querySelector('#t-svg').getBoundingClientRect();return [r.left+${x}/640*r.width,r.top+${y}/300*r.height]})()` });

// What a newcomer would do on each card. Targets are the mock's own selectors; each {shot} adds a screenshot.
const PROBES = {
  capture: (p) => [{ click: ".mode-chip[data-mode=brainstorm]" }, { click: "#t-go" }, { wait: 1800 }, { shot: p("brainstorm") }, { click: ".mode-chip[data-mode=execution]" }, { click: "#t-go" }, { wait: 3600 }, { shot: p("execution-run") }],
  "capture-templates": (p) => [{ click: ".tpl-btn[data-id=morning]" }, { wait: 150 }, { shot: p("filled") }, { click: "#t-more" }, { type: "gr" }, { wait: 250 }, { shot: p("search") },
    { click: ".tp-row .tp-star" }, { wait: 200 }, { shot: p("pinned") }, { key: "Escape" }],
  "capture-manage": (p) => [{ shot: p("start") }, { click: ".tm-item[data-id=worry] .tm-pick" }, { click: "#t-del" }, { wait: 150 }, { shot: p("confirm-delete") }, { click: "#t-yes" }, { wait: 150 }, { shot: p("deleted") }, { click: ".tm-new" }, { shot: p("new") }],
  "capture-extras": (p) => [{ click: "#t-mic" }, { wait: 1300 }, { shot: p("recording") }, { click: "#t-mic" }, { wait: 1000 }, { click: "#t-priv" }, { shot: p("private") }],
  "capture-shortcuts": () => [],
  graph: (p) => [{ hover: svgPt(300, 62) }, { wait: 500 }, { shot: p("hover") }, { click: svgPt(300, 62) }, { wait: 200 }, { shot: p("selected") }, { drag: [svgPt(285, 235), svgPt(330, 270)] }, { wait: 200 }, { shot: p("moved") }],
  "graph-ribbon": (p) => [{ click: ".gr-tab[data-tab=layout]" }, { hover: ".gr-btn[data-tool='layout:galaxy']" }, { wait: 700 }, { shot: p("layout-tip") }, { click: ".gr-help-btn" }, { wait: 300 }, { shot: p("help") },
    { key: "Escape" }, { click: ".gr-tab[data-tab=filter]" }, { wait: 200 }, { shot: p("filter") }, { click: ".gr-tab[data-tab=tools]" }, { wait: 200 }, { shot: p("tools") }],
  "graph-link": (p) => [{ shot: p("start") }, { drag: [svgPt(120, 205), svgPt(400, 125)] }, { wait: 300 }, { shot: p("linked") }, { click: svgPt(115, 178) }, { wait: 200 }, { shot: p("wire-selected") }, { key: "Delete" }, { wait: 300 }, { shot: p("deleted") },
    { key: "z", ctrl: true }, { wait: 300 }, { shot: p("undone") }, { click: "#t-show" }, { wait: 1500 }, { shot: p("show-me") }],
  "graph-merge": (p) => [{ shot: p("start") }, { drag: [svgPt(560, 105), svgPt(400, 125)] }, { wait: 300 }, { shot: p("merged") }, { key: "z", ctrl: true }, { wait: 300 }, { shot: p("undone") },
    { drag: [svgPt(560, 105), svgPt(285, 235)] }, { wait: 300 }, { shot: p("wrong-kind") }],
  search: (p) => [{ shot: p("start") }, { click: "#t-save" }, { wait: 150 }, { shot: p("saved") }],
  "search-browse": (p) => [{ click: "[data-t=concept]" }, { wait: 150 }, { shot: p("concepts") }],
  ask: (p) => [{ click: "#t-ask" }, { wait: 1300 }, { shot: p("answer") }],
  history: (p) => [{ click: ".drow[data-i='1']" }, { wait: 200 }, { shot: p("second") }, { click: "#t-edit-title" }, { type: " (edited)" }, { shot: p("rename") }],
  "history-manage": (p) => [{ click: "#t-split" }, { click: ".t-w[data-i='9']" }, { wait: 150 }, { shot: p("split") }, { click: "#t-priv" }, { shot: p("private") }, { click: "#t-del" }, { shot: p("trash") }],
  tasks: (p) => [{ click: "[data-g=overdue]" }, { wait: 150 }, { shot: p("overdue") }, { click: "[data-g=goals]" }, { shot: p("goals") }],
  "tasks-more": (p) => [{ click: ".t-snz" }, { wait: 150 }, { shot: p("menu") }, { click: ".snooze-menu button" }, { wait: 150 }, { shot: p("snoozed") }, { click: "#t-jot" }, { wait: 150 }, { shot: p("just-one") }, { click: "[data-a=done]" }, { shot: p("next-one") }, { click: "[data-a=close]" }, { click: "#t-fit" }, { shot: p("fit") }],
  reflect: (p) => [{ click: "#t-gen" }, { wait: 1300 }, { shot: p("written") }],
  stats: (p) => [{ click: "[data-d='90']" }, { wait: 150 }, { shot: p("90") }],
  settings: (p) => [{ click: "[data-k=About]" }, { wait: 150 }, { shot: p("about") }, { click: "[data-k=Templates]" }, { shot: p("templates") }],
};

const REAL = [["capture", "capture"], ["graph", "graph"], ["search", "search"], ["ask", "ask"], ["history", "history"], ["tasks", "tasks"], ["reflect", "reflect"], ["stats", "stats"],
  ["settings", "settings/appearance"], ["settings-templates", "settings/templates"], ["settings-data", "settings/data"], ["settings-about", "settings/about"]];

if (only === "firstrun") {
  // The first-run path on an EMPTY vault (serve it with: graph_serve.py --data <new dir> --port 8765 --empty): pick "Off" for the AI,
  // continue past the background step, land on the tour's first card, press Next, then Skip. Use a new data dir each time: it ends onboarded.
  const dir = join(out, "firstrun"); mkdirSync(dir, { recursive: true });
  const txt = (sel, none) => ({ eval: `document.querySelector('${sel}') ? document.querySelector('${sel}').textContent : '${none}'` });
  run(dir, "firstrun", "#capture", [{ wait: 500 }, { shot: join(dir, "1-provider.png") }, { click: "[data-p=off]" }, { wait: 200 }, { click: "#ob-continue" }, { wait: 900 }, txt(".ob-head h1", "none"), { shot: join(dir, "2-background.png") },
    { click: "#ob-continue" }, { wait: 900 }, txt(".tour h1", "no tour"), { shot: join(dir, "3-tour.png") }, { eval: "document.querySelector('#ob-next').click()" }, { wait: 300 },
    { eval: "document.querySelector('#ob-skip').click()" }, { wait: 800 }, { eval: evalOpen }, { shot: join(dir, "4-after.png") }], [],
    { "Run in the background?": "the setup step after the AI choice", [STEPS[0].title]: "the tour's first card", closed: "Skip tutorial must end the first-run flow" });
  console.log(failures ? `\n${failures} walk(s) FAILED` : "\nall walks clean");
  process.exit(failures ? 1 : 0);
}

for (const theme of themes) {
  const put = await fetch(`${base}/api/themes/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: theme }) });
  if (!put.ok) { console.error(`could not switch the sandbox theme to ${theme}`); process.exit(2); }
  const dir = join(out, `${theme}-${width}x${height}`); mkdirSync(dir, { recursive: true });
  console.log(`\n== ${theme} ${width}x${height} -> ${dir}`);

  if (only === "all" || only === "real") {
    const p = (n) => join(dir, `real-${n}.png`);
    for (const [name, hash] of REAL) run(dir, "real-" + name, "#" + hash);
    run(dir, "real-graph-edit-link", "#graph", [{ click: "#gr-tab-edit" }, { click: "[data-tool=link]" }, { wait: 600 }, { shot: p("graph-edit-link") }, { click: ".gr-help-btn" }, { wait: 300 }, { shot: p("graph-edit-help") }]);
    run(dir, "real-capture-templates", "#capture", [{ click: ".tpl-btn" }, { click: ".tpl-more" }, { wait: 300 }, { shot: p("capture-templates-popover") }]);
  }
  if (only === "all" || only === "sequence") {
    // Press Next through every card; each card gets a shot; the last press (Get started) must close the tour.
    const steps = [];
    STEPS.forEach((s, i) => { steps.push({ wait: 350 }, { shot: join(dir, `seq-${String(i + 1).padStart(2, "0")}-${s.id}.png`) }, { eval: "document.querySelector('#ob-next').click()" }); });
    steps.push({ wait: 300 }, { eval: evalOpen });
    run(dir, "seq-all", "#capture", steps, ["--eval", startTour()], { closed: "Get started must close the tour" });
  }
  if (only === "all" || only === "flows") {
    // Settings -> About -> Replay tutorial opens the real tour; Skip closes it; so does Get started on the last card.
    run(dir, "flow-replay-skip", "#settings/about", [{ click: "#about-tutorial" }, { wait: 700 }, { eval: "document.querySelector('#onboarding .tour h1') ? 'tour' : 'none'" }, { shot: join(dir, "flow-replay-start.png") },
      { click: "#ob-skip" }, { wait: 300 }, { eval: evalOpen }], [], { tour: "Replay tutorial must open the tour", closed: "Skip tutorial must close it" });
    run(dir, "flow-replay-finish", "#settings/about", [{ click: "#about-tutorial" }, { wait: 700 }, { click: ".tour-rail a[data-id=settings]" }, { wait: 300 }, { eval: "document.querySelector('#ob-next').textContent" },
      { click: "#ob-next" }, { wait: 300 }, { eval: evalOpen }], [], { "Get started": "the last card offers Get started", closed: "Get started must close the tour" });
    run(dir, "flow-keys", "#capture", [{ wait: 600 }, { key: "ArrowRight" }, { wait: 200 }, { eval: "document.querySelector('.tour-count').textContent" }, { key: "ArrowLeft" }, { wait: 200 }, { eval: "document.querySelector('.tour-count').textContent" }],
      ["--eval", startTour()], { [`Card 2 of ${STEPS.length}`]: "ArrowRight turns to the next card", [`Card 1 of ${STEPS.length}`]: "ArrowLeft turns back" });
  }
  if (only === "all" || only === "probes") {
    for (const s of STEPS) {
      if (onlyStep && s.id !== onlyStep) continue;
      const p = (n) => join(dir, `probe-${s.id}-${n}.png`);
      run(dir, `probe-${s.id}-start`, "#capture", [{ wait: 600 }, ...(PROBES[s.id] ? PROBES[s.id](p) : [])], ["--eval", startTour(s.id)]);
    }
  }
}
console.log(failures ? `\n${failures} walk(s) FAILED` : "\nall walks clean");
process.exit(failures ? 1 : 0);
