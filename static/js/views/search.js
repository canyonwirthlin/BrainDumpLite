// Search + Browse. Left: every node type with how many entries it has (People, Concepts, then
// Tasks, Goals, Ideas…). Right: search results, a type's entries, or one entry's dumps.
// Routes: #search · #search/q/<text> · #search/type/<id> · #search/type/<id>/<name>
import { $, $$, esc, fmtDate, relTime, kindBadge, colorCss } from "../ui.js";
import { api } from "../api.js";
import { go } from "../router.js";
import { state } from "../state.js";

const GLYPH = { person: "🧑", concept: "💡" };
const VIA = { keyword: "words", items: "in an item", semantic: "by meaning", both: "words + meaning", name: "by name" };

export async function render(ctx) {
  const [mode, a, b] = ctx.params;
  const query = mode === "q" ? a || "" : "";
  ctx.setTitle("Search", `<input type="text" id="q" class="topbar-input" placeholder="a name, a topic, a half-remembered phrase…" value="${esc(query)}" autocomplete="off">
    <button class="btn small" id="go">Search</button>`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split has-detail" id="search">
    <div class="master" id="browse-types"><div class="center small">Loading…</div></div>
    <div class="detail" id="search-main"></div></div>`;
  const run = () => { const q = $("#q").value.trim(); go(q ? "search/q/" + encodeURIComponent(q) : "search"); };
  $("#go").onclick = run;
  $("#q").onkeydown = (e) => { if (e.key === "Enter") run(); };
  if (!query) $("#q").focus();

  let types = [];
  try { types = await api.get("/browse"); } catch {}
  const active = mode === "type" ? a : null;
  $("#browse-types").innerHTML = `<div class="glist"><div class="glist-sep" style="margin-top:0">Browse</div>
    ${types.map((t) => `<a href="#search/type/${encodeURIComponent(t.id)}" class="grow-row ${t.id === active ? "on" : ""}">
      <span><i class="legend-dot" style="background:${colorCss(t.color)}"></i> ${esc((t.icon ? t.icon + " " : "") + t.label)}</span><span class="count">${t.count}</span></a>`).join("")}</div>
    <div class="small muted" style="padding:12px 16px">Pick a type to see everything of that kind, and how often each appears across your dumps.</div>`;

  const main = $("#search-main");
  if (mode === "q" && query) return paintResults(main, query);
  if (mode === "type" && a) {
    const t = types.find((x) => x.id === a);
    if (!t) { main.innerHTML = `<div class="center">Unknown type.</div>`; return; }
    return t.entries === "names" ? (b ? paintEntry(main, t, b) : paintNames(main, t)) : paintItems(main, t);
  }
  main.innerHTML = `<h1 class="page">Search your brain</h1>
    <p class="sub">${state.status.ai ? "Words, names and meaning across every dump." : "Words and names across every dump."} Typos and word endings are forgiven.</p>
    <div class="center" style="padding-top:30px"><div class="big">🔍</div>Search above, or pick a type on the left to browse it.</div>`;
}

async function paintResults(main, q) {
  main.innerHTML = `<div class="center">Searching…</div>`;
  let r;
  try { r = await api.get("/search?q=" + encodeURIComponent(q)); }
  catch (e) { main.innerHTML = `<div class="center">Search failed: ${esc(e.message)}</div>`; return; }
  const fixes = Object.entries(r.corrected || {});
  main.innerHTML = `<h1 class="page">Results for “${esc(q)}”</h1>
    ${fixes.length ? `<p class="sub">Also searched for ${fixes.map(([from, to]) => `<b>${esc(to)}</b> (you typed “${esc(from)}”)`).join(", ")}.</p>` : ""}
    ${r.entities.length ? `<div class="ent-strip">${r.entities.map((e) => `
      <a class="chip ent" href="#search/type/${e.type}/${encodeURIComponent(e.name)}" title="See every dump that mentions ${esc(e.name)}">${GLYPH[e.type]} ${esc(e.name)} · ${e.count}×</a>`).join("")}</div>` : ""}
    ${r.results.length ? r.results.map((d) => `
      <div class="card click" onclick="location.hash='history/${d.id}'">
        <b>${esc(d.title || "Untitled")}</b>
        <span class="chip">${VIA[d.via] || d.via}</span>
        ${(d.matched_names || []).map((n) => `<span class="chip">${esc(n)}</span>`).join("")}
        <div class="meta small muted">${fmtDate(d.created_at)}</div>
        <div class="small" style="margin-top:6px">${esc(d.snippet || "").replace(/「/g, "<b>").replace(/」/g, "</b>")}</div>
        ${(d.matched_items || []).length ? `<div class="matched">${d.matched_items.map((it) => `<div class="mi">${kindBadge(it.kind)} ${esc(it.content)}</div>`).join("")}</div>` : ""}
      </div>`).join("")
      : `<div class="center"><div class="big">🔍</div>No matches for “${esc(q)}”.<div class="small muted" style="margin-top:6px">Try fewer or shorter words — or browse by type on the left.</div></div>`}`;
}

// People / Concepts: every name with how many dumps it appears in.
async function paintNames(main, t) {
  main.innerHTML = `<div class="center">Loading…</div>`;
  let rows;
  try { rows = await api.get(t.id === "person" ? "/people" : "/concepts"); }
  catch (e) { main.innerHTML = `<div class="center">Couldn't load: ${esc(e.message)}</div>`; return; }
  const paint = (filter = "") => {
    const list = rows.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
    $("#names", main).innerHTML = list.length ? list.map((r) => `
      <a class="name-row" href="#search/type/${t.id}/${encodeURIComponent(r.name)}">
        <span class="grow"><b>${esc(r.name)}</b><span class="small muted"> · last ${relTime(r.last_at)}</span></span>
        <span class="times" title="appears in ${r.count} dump${r.count === 1 ? "" : "s"}">${r.count}×</span></a>`).join("")
      : `<div class="center small">${rows.length ? "No match." : `No ${t.label.toLowerCase()} yet — they're picked up from your dumps.`}</div>`;
  };
  main.innerHTML = `<h1 class="page">${esc(t.label)}</h1>
    <p class="sub">${rows.length} ${rows.length === 1 ? "entry" : "entries"}. The number is how many dumps each appears in — pick one to read them.</p>
    ${rows.length > 8 ? `<input type="text" id="name-filter" class="add-content" placeholder="Filter…" autocomplete="off" style="margin-bottom:10px">` : ""}
    <div class="card names" id="names"></div>`;
  paint();
  $("#name-filter", main)?.addEventListener("input", (e) => paint(e.target.value));
}

// One person or concept: every dump that mentions them.
async function paintEntry(main, t, name) {
  main.innerHTML = `<div class="center">Loading…</div>`;
  let dumps;
  try { dumps = await api.get(`/${t.id === "person" ? "people" : "concepts"}/${encodeURIComponent(name)}`); }
  catch (e) { main.innerHTML = `<div class="center">Couldn't load: ${esc(e.message)}</div>`; return; }
  main.innerHTML = `<a class="btn ghost small" href="#search/type/${t.id}" style="margin-bottom:12px">← All ${esc(t.label.toLowerCase())}</a>
    <h1 class="page">${GLYPH[t.id]} ${esc(name)}</h1>
    <p class="sub">Appears in ${dumps.length} dump${dumps.length === 1 ? "" : "s"}, newest first.</p>
    ${dumps.map((d) => `
      <a class="card click dump-card" href="#history/${d.id}">
        <b>${esc(d.title)}</b> <span class="small muted">${fmtDate(d.created_at)}</span>
        <p class="small" style="margin-top:6px">${esc(d.raw_text)}${d.raw_text.length >= 160 ? "…" : ""}</p>
      </a>`).join("") || `<div class="center">Nothing mentions this yet.</div>`}`;
}

// Tasks / Goals / Ideas / Concerns / custom types: the items themselves.
async function paintItems(main, t) {
  main.innerHTML = `<div class="center">Loading…</div>`;
  let rows;
  try { rows = await api.get("/browse/items/" + encodeURIComponent(t.id)); }
  catch (e) { main.innerHTML = `<div class="center">Couldn't load: ${esc(e.message)}</div>`; return; }
  main.innerHTML = `<h1 class="page">${esc((t.icon ? t.icon + " " : "") + t.label)}</h1>
    <p class="sub">${rows.length} across your dumps.${t.id === "task" ? ` Manage them in <a href="#tasks">Tasks</a>.` : ""}</p>
    ${rows.length ? `<div class="card">${rows.map((i) => `
      <div class="task-row ${i.done ? "done" : ""}"><div class="body grow"><span class="content">${esc(i.content)}</span>
        <div class="detail small muted">${i.dump_id ? `from <a href="#history/${i.dump_id}">${esc(i.dump_title || "dump")}</a>` : "added by you"} · ${relTime(i.created_at)}</div></div></div>`).join("")}</div>`
      : `<div class="center">Nothing here yet.</div>`}`;
}
