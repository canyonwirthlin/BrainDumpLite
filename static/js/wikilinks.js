// [[wikilink]] autocomplete for textareas (Phase 6). Attach with attach(textarea).
// Typing "[[" opens a popover fed by /api/wikilinks/suggest; Enter/Tab inserts
// "[[Name]]", arrows move, Esc closes.
import { $, esc } from "./ui.js";
import { api } from "./api.js";

let pop = null, items = [], sel = 0, activeTa = null, start = -1, timer = null;

function close() { pop?.remove(); pop = null; items = []; activeTa = null; start = -1; }

function position(ta) {
  const r = ta.getBoundingClientRect();
  pop.style.left = Math.min(r.left + 16, window.innerWidth - 300) + "px";
  pop.style.top = Math.min(r.bottom - 8, window.innerHeight - 220) + "px";
}

function paint() {
  if (!pop) return;
  pop.innerHTML = items.length
    ? items.map((it, i) => `<div class="o ${i === sel ? "on" : ""}" data-i="${i}"><span class="k ${it.kind}">${it.kind}</span>${esc(it.name)}</div>`).join("")
    : `<div class="o muted">Type a name…</div>`;
  pop.querySelectorAll(".o[data-i]").forEach((o) => o.onmousedown = (e) => { e.preventDefault(); insert(+o.dataset.i); });
}

function insert(i) {
  const it = items[i];
  if (!it || !activeTa) return;
  const ta = activeTa, end = ta.selectionStart;
  ta.value = ta.value.slice(0, start) + `[[${it.name}]]` + ta.value.slice(end);
  const pos = start + it.name.length + 4;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  close();
}

async function refresh(q) {
  try { items = await api.get("/wikilinks/suggest?q=" + encodeURIComponent(q)); } catch { items = []; }
  if (q && !items.some((it) => it.name.toLowerCase() === q.toLowerCase())) items.unshift({ name: q, kind: "new" });
  sel = 0;
  paint();
}

export function attach(ta) {
  if (!ta || ta.dataset.wikilinks) return;
  ta.dataset.wikilinks = "1";
  ta.addEventListener("input", () => {
    const pos = ta.selectionStart, before = ta.value.slice(0, pos);
    const open = before.lastIndexOf("[[");
    if (open < 0 || before.slice(open).includes("]]") || before.slice(open).includes("\n")) { if (activeTa === ta) close(); return; }
    start = open; activeTa = ta;
    if (!pop) { pop = document.createElement("div"); pop.className = "wl-pop"; document.body.appendChild(pop); }
    position(ta);
    clearTimeout(timer);
    timer = setTimeout(() => refresh(before.slice(open + 2)), 120);
  });
  ta.addEventListener("keydown", (e) => {
    if (!pop || activeTa !== ta) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); paint(); }
    else if (e.key === "Enter" || e.key === "Tab") { if (items.length) { e.preventDefault(); insert(sel); } }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  ta.addEventListener("blur", () => setTimeout(close, 150));
}
