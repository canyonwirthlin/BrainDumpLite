// Ctrl+K command palette: actions, navigation, recent dumps, themes.
import { $, esc, relTime, ICONS } from "./ui.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { go } from "./router.js";
import { NAV } from "./shell.js";
import { setActive } from "./theme.js";
import { native, checkForUpdates } from "./native.js";

const SECTIONS = [["appearance", "Appearance"], ["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["stats", "Stats"], ["about", "About"]];
let root, items = [], filtered = [], sel = 0, open = false;

function staticItems() {
  const out = [
    { group: "Actions", label: "New dump", hint: "Ctrl N", run: () => { go("capture"); setTimeout(() => $("#dump-text")?.focus(), 50); } },
  ];
  if (native) out.push({ group: "Actions", label: "Check for updates", run: () => checkForUpdates({ silent: false }) });
  for (const t of state.themes) out.push({ group: "Themes", label: `Switch theme → ${t.name}`, run: () => setActive(t.id) });
  for (const n of NAV) out.push({ group: "Go to", label: n.label, run: () => go(n.id) });
  for (const [id, label] of SECTIONS) out.push({ group: "Go to", label: `Settings → ${label}`, run: () => go("settings/" + id) });
  return out;
}

async function recentItems() {
  try {
    const dumps = await api.get("/dumps?limit=8");
    return dumps.map((d) => ({ group: "Recent dumps", label: d.title || (d.raw_text || "").slice(0, 60) || "Untitled",
      hint: relTime(d.created_at), run: () => go("history/" + d.id) }));
  } catch { return []; }
}

// Subsequence match with bonuses for prefix and word starts; 0 = no match.
export function score(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 60;
  let qi = 0, s = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { s += (i === 0 || t[i - 1] === " ") ? 3 : 1; qi++; }
  }
  return qi === q.length ? s : 0;
}

const GROUP_ORDER = { Actions: 0, "Go to": 1, "Recent dumps": 2, Themes: 3 };

function paint() {
  const q = $("#pal-q", root).value.trim();
  filtered = items.map((it) => ({ it, s: score(q, it.label) })).filter((x) => x.s > 0)
    .filter((x) => q || x.it.group !== "Themes")          // themes only when searched for
    .sort((a, b) => (b.s - a.s) || (GROUP_ORDER[a.it.group] - GROUP_ORDER[b.it.group]))
    .map((x) => x.it).slice(0, 14);
  if (!q) filtered.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  sel = Math.min(sel, Math.max(0, filtered.length - 1));
  let html = "", lastGroup = null;
  filtered.forEach((it, i) => {
    if (it.group !== lastGroup) { html += `<div class="g">${it.group}</div>`; lastGroup = it.group; }
    const icon = it.group === "Go to" ? ICONS.search : it.group === "Recent dumps" ? ICONS.history : ICONS.capture;
    html += `<div class="o ${i === sel ? "on" : ""}" data-i="${i}"><span class="ic">${icon}</span>${esc(it.label)}${it.hint ? `<span class="r">${esc(it.hint)}</span>` : ""}</div>`;
  });
  $("#pal-list", root).innerHTML = html || `<div class="g">No matches</div>`;
  $(".o.on", root)?.scrollIntoView({ block: "nearest" });
}

function run(i) { const it = filtered[i]; closePalette(); if (it) it.run(); }

export function closePalette() { if (!open) return; open = false; root.innerHTML = ""; }

export async function openPalette() {
  if (open) return;
  open = true; sel = 0;
  root.innerHTML = `<div class="scrim"></div><div class="pal" role="dialog" aria-label="Command palette">
    <div class="q"><input id="pal-q" placeholder="Type a command or search…" autocomplete="off" spellcheck="false"></div>
    <div id="pal-list"></div></div>`;
  items = staticItems();
  paint();
  $("#pal-q", root).focus();
  $("#pal-q", root).oninput = () => { sel = 0; paint(); };
  $(".scrim", root).onclick = closePalette;
  $("#pal-list", root).onclick = (e) => { const o = e.target.closest(".o"); if (o) run(+o.dataset.i); };
  items = items.concat(await recentItems());
  if (open) paint();
}

export function initPalette() {
  root = $("#palette-root");
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open ? closePalette() : openPalette(); return; }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, filtered.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + filtered.length) % Math.max(1, filtered.length); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
  });
  $(".kbd-hint")?.addEventListener("click", openPalette);
}
