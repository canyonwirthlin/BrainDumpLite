#!/usr/bin/env node
// Headless-browser screenshot + interaction driver for the brain map (Node >= 22, built-ins only).
//
//   node scripts/graph_shot.mjs --url http://127.0.0.1:8761/#graph --width 1500 --height 900 \
//        --pre "localStorage.setItem('bdl-graph-layout','galaxy')" \
//        --eval "document.querySelectorAll('#graph-canvas').length" \
//        --steps '[{"hover":[600,400]},{"wait":300},{"shot":"hover.png"},{"key":"Escape"}]' \
//        --wait 2500 --out shot.png
//
// Options
//   --url U          page to open (default http://127.0.0.1:8761/#graph)
//   --width/--height viewport in CSS px (default 1500x900); --dpr N device scale (default 1)
//   --pre JS         evaluated on a blank same-origin page BEFORE the app loads (seed localStorage here)
//   --wait MS        settle time after load (default 2500)
//   --wait-for JS    after load, poll until this expression is truthy (max 20 s) before settling
//   --eval JS        evaluated after the page settles; its JSON result is printed as `EVAL <json>`
//   --steps JSON     list of actions, run in order after --eval (see below)
//   --out FILE       final screenshot (png)
//   --init JS        evaluated on EVERY new document before any page script runs (Page.addScriptToEvaluateOnNewDocument)
//   --seed-random N  replace Math.random with a seeded PRNG, so two runs can be compared pixel for pixel
//   --browser PATH   msedge/chrome executable (default: Edge, then Chrome)
//   --timeout MS     overall limit (default 90000)
// Steps (each item is an object with one action key):
//   {"key":"ArrowRight","ctrl":true,"shift":false,"alt":false}   press a key (names: Enter Escape Tab Backspace Delete Space Arrow* Home End PageUp PageDown, or a character)
//   {"type":"hello"}                                              insert text into the focused element
//   {"click":T}  {"dblclick":T}  {"rclick":T}  {"hover":T}        T = [x,y] | "css selector" | {"js":"expr returning [x,y] or an element"}
//   {"drag":[T,T]}  or  {"drag":[x0,y0,x1,y1],"steps":12}         press at the first point, move, release
//   {"wheel":[x,y,deltaY]}                                        mouse wheel at a point
//   {"wait":MS}   {"eval":"JS"}   {"shot":"file.png","clip":"css selector"}   {"waitFor":"JS"}
// Output: `EVAL`/`STEP` lines with JSON results, console errors / uncaught exceptions as `[error] ...`.
// Exit code 1 when the page logged console.error, threw, or a resource failed to load; 2 on driver failure.
// Tip: the graph exposes its engine as window.__bdlGraph (nodes, view, select(), ...) for steps like
//   {"click":{"js":"(()=>{const g=__bdlGraph,n=g.byId['concept:sleep'];return g.view.toScreen(n.x,n.y)})()"}}
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const url = opt("url", "http://127.0.0.1:8761/#graph");
const width = +opt("width", 1500), height = +opt("height", 900), dpr = +opt("dpr", 1);
const initJs = opt("init"), seedRandom = opt("seed-random");
const pre = opt("pre"), evalJs = opt("eval"), stepsJson = opt("steps"), out = opt("out"), waitFor = opt("wait-for");
const settle = +opt("wait", 2500), overall = +opt("timeout", 90000);
if (argv.includes("--help") || argv.includes("-h")) { console.log("see the header comment of scripts/graph_shot.mjs"); process.exit(0); }

const CANDIDATES = [
  opt("browser"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean);
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) { console.error("No Edge/Chrome found; pass --browser <path>"); process.exit(2); }

const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
let quiet = false;   // true while the --pre blank page loads (its own 404 is not the app's problem)
let proc = null, profile = null, ws = null;
function cleanup() {
  try { ws?.close(); } catch {}
  if (proc && proc.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else try { process.kill(proc.pid, "SIGKILL"); } catch {}
  }
  if (profile) for (let i = 0; i < 8; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); } }
}
const fail = (msg) => { console.error("graph_shot: " + msg); cleanup(); process.exit(2); };
setTimeout(() => fail("timed out after " + overall + " ms"), overall).unref();

async function main() {
  const port = await freePort();
  profile = mkdtempSync(join(tmpdir(), "bdl-shot-"));
  proc = spawn(exe, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--disable-sync", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  proc.on("error", (e) => fail("could not launch browser: " + e.message));

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) fail("browser did not expose a debugging target");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket error")); });
  let nextId = 1; const pending = new Map(); const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) listeners.forEach((l) => l(m));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const once = (method) => new Promise((res) => { const l = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(l), 1); res(m.params); } }; listeners.push(l); });

  listeners.push((m) => {
    if (quiet) return;
    const p = m.params;
    if (m.method === "Runtime.consoleAPICalled") {
      const text = p.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
      if (p.type === "error") { problems.push(text); console.log("[error] console.error: " + text); }
      else if (p.type === "warning") console.log("[warn] " + text);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails, text = d.exception?.description || d.text;
      problems.push(text); console.log(`[error] uncaught: ${text} (line ${d.lineNumber}:${d.columnNumber} ${d.url || ""})`);
    } else if (m.method === "Log.entryAdded") {
      const e = p.entry;
      if (e.level === "error") { const t = `${e.text} ${e.url || ""}`.trim(); problems.push(t); console.log("[error] log: " + t); }
    }
  });
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  if (seedRandom !== undefined) await send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{let a=${(+seedRandom) | 0}|0;Math.random=function(){a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}})()` });
  if (initJs) await send("Page.addScriptToEvaluateOnNewDocument", { source: initJs });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async (u) => { const loaded = once("Page.loadEventFired"); await send("Page.navigate", { url: u }); await loaded; };

  const origin = new URL(url).origin;
  if (pre) {
    quiet = true;
    await goto(origin + "/__graph_shot_blank__");   // any same-origin document: only its localStorage matters (a 404 is fine)
    await evaluate(pre);
    await sleep(200);
  }
  await goto("about:blank");
  quiet = false; problems.length = 0;
  await goto(url);
  if (waitFor) {
    const t0 = Date.now(); let ok = false;
    while (Date.now() - t0 < 20000 && !ok) { try { ok = !!(await evaluate(waitFor)); } catch {} if (!ok) await sleep(150); }
    if (!ok) console.log("[warn] --wait-for never became truthy: " + waitFor);
  }
  await sleep(settle);

  const shot = async (file, clip) => {
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) {
      const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(clip)});if(!e)return null;const b=e.getBoundingClientRect();return [b.x,b.y,b.width,b.height]})()`);
      if (!r) throw new Error("clip selector not found: " + clip);
      params.clip = { x: r[0], y: r[1], width: r[2], height: r[3], scale: 1 };
    }
    const { data } = await send("Page.captureScreenshot", params);
    writeFileSync(resolve(file), Buffer.from(data, "base64"));
    console.log("SHOT " + resolve(file));
  };

  const point = async (t) => {
    if (Array.isArray(t)) return { x: t[0], y: t[1] };
    const expr = typeof t === "string"
      ? `(()=>{const e=document.querySelector(${JSON.stringify(t)});if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`
      : `(()=>{const v=(${t.js});if(!v)return null;if(Array.isArray(v))return v;if(v.getBoundingClientRect){const b=v.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]}return [v.x,v.y]})()`;
    const r = await evaluate(expr);
    if (!r) throw new Error("target not found: " + JSON.stringify(t));
    return { x: r[0], y: r[1] };
  };
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });
  const click = async (p, button = "left", count = 1) => {
    await mouse("mouseMoved", p.x, p.y);
    for (let i = 1; i <= count; i++) {
      await mouse("mousePressed", p.x, p.y, { button, buttons: button === "left" ? 1 : 2, clickCount: i });
      await mouse("mouseReleased", p.x, p.y, { button, buttons: 0, clickCount: i });
    }
  };
  const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, " ": 32, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  const key = async (s) => {
    const name = s.key === "Space" ? " " : s.key;
    const vk = KEYS[name] ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
    const printable = name.length === 1 && !s.ctrl && !s.alt;
    const code = name.length === 1 ? (/[a-z]/i.test(name) ? "Key" + name.toUpperCase() : /\d/.test(name) ? "Digit" + name : "") : name === " " ? "Space" : name;
    const modifiers = (s.alt ? 1 : 0) | (s.ctrl ? 2 : 0) | (s.meta ? 4 : 0) | (s.shift ? 8 : 0);
    const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await send("Input.dispatchKeyEvent", { type: printable || name === "Enter" ? "keyDown" : "rawKeyDown", ...base, ...(printable ? { text: name } : name === "Enter" ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  if (evalJs) console.log("EVAL " + JSON.stringify(await evaluate(evalJs)));
  const steps = stepsJson ? JSON.parse(stepsJson) : [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      if ("key" in s) await key(s);
      else if ("type" in s) await send("Input.insertText", { text: s.type });
      else if ("click" in s) await click(await point(s.click));
      else if ("dblclick" in s) await click(await point(s.dblclick), "left", 2);
      else if ("rclick" in s) await click(await point(s.rclick), "right");
      else if ("hover" in s) { const p = await point(s.hover); await mouse("mouseMoved", p.x, p.y); }
      else if ("drag" in s) {
        const d = s.drag, a = d.length === 4 ? { x: d[0], y: d[1] } : await point(d[0]), b = d.length === 4 ? { x: d[2], y: d[3] } : await point(d[1]);
        const n = s.steps || 10;
        await mouse("mouseMoved", a.x, a.y);
        await mouse("mousePressed", a.x, a.y, { button: "left", buttons: 1, clickCount: 1 });
        for (let k = 1; k <= n; k++) { await mouse("mouseMoved", a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n, { buttons: 1 }); await sleep(16); }
        await mouse("mouseReleased", b.x, b.y, { button: "left", buttons: 0, clickCount: 1 });
      }
      else if ("wheel" in s) { await mouse("mouseWheel", s.wheel[0], s.wheel[1], { deltaX: 0, deltaY: s.wheel[2] }); }
      else if ("wait" in s) await sleep(s.wait);
      else if ("waitFor" in s) { const t0 = Date.now(); while (Date.now() - t0 < 15000 && !(await evaluate(s.waitFor).catch(() => false))) await sleep(100); }
      else if ("eval" in s) console.log(`STEP ${i} ` + JSON.stringify(await evaluate(s.eval)));
      else if ("shot" in s) await shot(s.shot, s.clip);
      else throw new Error("unknown step");
      await sleep(40);   // let rAF-driven views react before the next action
    } catch (e) { problems.push(`step ${i} ${JSON.stringify(s)}: ${e.message}`); console.log(`[error] step ${i} failed: ${e.message}`); }
  }
  if (out) await shot(out);
}

try { await main(); } catch (e) { fail(e.stack || String(e)); }
cleanup();
if (problems.length) { console.log(`graph_shot: ${problems.length} problem(s)`); process.exit(1); }
process.exit(0);
