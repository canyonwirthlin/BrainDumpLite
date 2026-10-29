// Hover card: rest the pointer on a node for ~200 ms and a small card appears beside it with what the map itself
// doesn't carry (snippet, concepts, mention counts, latest dumps ...), fetched from GET /api/graph/card/<node id>.
//
// It is a plain DOM element on <body> (position: fixed, pointer-events: none), so it never blocks the canvas, and it
// survives the map being rebuilt. Responses are cached per node id; a stale request is aborted when the pointer moves on.
// Hides on pan / drag / zoom / leave / Escape and whenever the map is rebuilt.
import { esc } from "../ui.js";
import { onGraphReady } from "./hooks.js";
import { mentionTimes, summarizeMentions, sparkBlock } from "./info-sparkline.js";

const DELAY = 200;          // ms of resting before the card shows
const TTL = 45000;          // ms a cached card stays fresh
const CACHE_MAX = 300;
const GAP = 16;             // px between pointer and card
const EDGE = 8;             // px kept free at the viewport edge

const day = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const chips = (names, cls = "") => names.map((n) => `<span class="bdl-hc-chip ${cls}">${esc(String(n).slice(0, 28))}</span>`).join("");
const KIND = { dump: "Dump", concept: "Concept", person: "Person" };

function render(card, node, api) {
  const GC = api.colors;
  const dot = `<i class="bdl-hc-dot" style="background:${GC.colors[node.type] || GC.dump}"></i>`;
  const title = (t) => `<div class="bdl-hc-title">${esc(t)}</div>`;
  let head = "", body = "", foot = "";
  const selects = !!(api.prefs.get("focus") || api.selectedId === node.id || api.overlays.infoHtml(node));   // mirrors the engine's click rule
  if (card.type === "dump") {
    head = `${KIND.dump}${card.created_at ? " · " + esc(day(card.created_at)) : ""}`;
    body = title(card.label) + (card.snippet ? `<div class="bdl-hc-snippet">${esc(card.snippet)}</div>` : "")
      + (card.concepts.length || card.people.length ? `<div class="bdl-hc-chips">${chips(card.concepts)}${chips(card.people, "person")}</div>` : "")
      + `<div class="bdl-hc-meta">${card.open_tasks ? plural(card.open_tasks, "open task") : "No open tasks"}</div>`;
    foot = selects ? "Click to select it, then open it from the info box" : "Click to open this dump";
  } else if (card.type === "concept" || card.type === "person") {
    const sum = summarizeMentions(mentionTimes(api, node.id));
    head = `${KIND[card.type]} · ${plural(card.count, "mention")}`;
    body = title(card.label) + sparkBlock(sum)
      + `<div class="bdl-hc-seen">First seen ${esc(day(card.first_at))} · last seen ${esc(day(card.last_at))}</div>`
      + (card.related.length ? `<div class="bdl-hc-sec">Often with</div><div class="bdl-hc-chips">${chips(card.related.map((r) => r.name))}${card.type === "concept" ? chips(card.people.map((r) => r.name), "person") : ""}</div>` : "")
      + (card.latest.length ? `<div class="bdl-hc-sec">Latest dumps</div><ul class="bdl-hc-list">${card.latest.map((d) => `<li>${esc(d.title)}</li>`).join("")}</ul>` : "");
    foot = `Click to select · Shift + drag onto another ${card.type} to merge`;
  } else {   // an item: task, idea, concern ...
    head = `${esc(card.kind_label)} · ${card.status === "done" ? "Done" : card.status === "approved" ? "Open" : "Suggested"}`;
    body = `<div class="bdl-hc-text">${esc(card.text)}</div>`
      + (card.detail ? `<div class="bdl-hc-snippet">${esc(card.detail)}</div>` : "")
      + `<div class="bdl-hc-meta">${card.due_date ? "Due " + esc(day(card.due_date + "T00:00")) + " · " : ""}From “${esc(card.dump_title.slice(0, 60))}”</div>`;
    foot = selects ? "Click to select it, then open its dump from the info box" : "Click to open its dump";
  }
  return `<div class="bdl-hc-head">${dot}<span>${head}</span></div>${body}<div class="bdl-hc-foot">${foot}</div>`;
}

// What to show when the card endpoint isn't reachable: whatever the node itself knows.
function fallbackCard(node) {
  if (node.type === "dump") return { type: "dump", label: node.label, created_at: node.created_at, snippet: "", concepts: [], people: [], open_tasks: 0 };
  return null;
}

onGraphReady((api) => {
  const el = document.createElement("div");
  el.className = "bdl-hc";
  el.setAttribute("aria-hidden", "true");   // screen readers get the selection announcement instead (keyboard.js)
  document.body.appendChild(el);

  const cache = new Map();                  // id -> { at, card | null (null = gone) }
  let timer = 0, ctl = null, token = 0, shownId = null, hoverNodeId = null, lastData = null;
  let px = 0, py = 0, down = null, suppress = null;
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  function hide() {
    clearTimeout(timer); timer = 0;
    if (ctl) { ctl.abort(); ctl = null; }
    token++;
    shownId = null;
    el.classList.remove("show");
  }

  function place() {
    const w = el.offsetWidth, h = el.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let x = px + GAP, y = py + GAP;
    if (x + w > vw - EDGE) x = px - GAP - w;          // no room on the right: flip to the left of the pointer
    if (y + h > vh - EDGE) y = py - GAP - h;          // no room below: flip above
    x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
    y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
    el.style.left = Math.round(x) + "px";
    el.style.top = Math.round(y) + "px";
  }

  function show(node, card) {
    if (!card || api.selectedId === node.id) return hide();   // a selected node already shows its details in the info box
    el.innerHTML = render(card, node, api);
    place();
    shownId = node.id;
    el.classList.add("show");
  }

  async function open(node) {
    const id = node.id, my = ++token;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL) { if (api.hoverId === id) show(node, hit.card); return; }
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ctl;
    let card = null, real = false;
    try {
      const r = await fetch("/api/graph/card/" + encodeURIComponent(id), { signal: mine.signal });
      if (r.status === 404) real = true;                // gone (trashed, private or filtered away): remember, show nothing
      else if (r.ok) { card = await r.json(); real = true; }
      else card = fallbackCard(node);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      card = fallbackCard(node);
    }
    if (my !== token) return;                          // the pointer moved on while we waited
    ctl = null;
    if (real) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(id, { at: Date.now(), card });
    }
    if (api.hoverId === id) show(node, card);
  }

  function schedule(node) {
    hide();
    if (!node || suppress === node.id) return;
    timer = setTimeout(() => { timer = 0; if (api.hoverId === node.id && api.selectedId !== node.id) open(node); }, DELAY);
  }

  const offs = [
    api.on("hover", ({ id, node }) => {
      hoverNodeId = id;
      if (id !== suppress) suppress = null;
      if (down) { hide(); return; }                    // a button is held: this is a drag or a pan, not a hover
      schedule(id ? node : null);
    }),
    api.on("nodesChanged", () => {
      hide(); hoverNodeId = null;
      const data = api.viewState && api.viewState.data;
      if (data !== lastData) { cache.clear(); lastData = data; }   // fresh data (after a merge, say): drop old cards
      const c = api.canvas;
      if (c) c.addEventListener("mouseleave", () => { hoverNodeId = null; hide(); });
    }),
  ];

  window.addEventListener("mousemove", (e) => { px = e.clientX; py = e.clientY; }, { capture: true, passive: true, ...sig });
  window.addEventListener("mousedown", (e) => { down = { x: e.clientX, y: e.clientY }; hide(); }, { capture: true, ...sig });
  window.addEventListener("mouseup", (e) => {
    const was = down; down = null;
    // a plain click (not a drag) leaves the pointer on the same node: bring the card back
    if (was && Math.hypot(e.clientX - was.x, e.clientY - was.y) <= 4 && api.hoverId) { const n = api.byId[api.hoverId]; if (n) schedule(n); }
  }, { capture: true, ...sig });
  window.addEventListener("wheel", () => { if (shownId || timer) hide(); }, { capture: true, passive: true, ...sig });
  window.addEventListener("blur", hide, sig);
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hide(); }, sig);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (shownId || timer)) { suppress = hoverNodeId; hide(); }
  }, { capture: true, ...sig });

  const cleanup = () => { ac.abort(); offs.forEach((o) => o()); hide(); el.remove(); };
  window.addEventListener("hashchange", cleanup, { once: true });
  return cleanup;
});
