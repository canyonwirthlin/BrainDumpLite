// Search + Browse. Left: every node type with how many entries it has (People, Concepts, then
// Tasks, Goals, Ideas…). Right: search results, a type's entries, or one entry's dumps.
// Routes: #search · #search/q/<text> · #search/type/<id> · #search/type/<id>/<name>
import { $, $$, esc, fmtDate, relTime, kindBadge, colorCss, modal, toast } from "../ui.js";
import { api } from "../api.js";
import { go } from "../router.js";
import { state } from "../state.js";

const GLYPH = { person: "🧑", concept: "💡" };

const searchChips = (list, attr) => list.map((q) => `<a class="chip" href="#search/q/${encodeURIComponent(q)}" ${attr}="${esc(q)}">${esc(q)}</a>`).join("");
const VIA = { keyword: "words", items: "in an item", semantic: "by meaning", both: "words + meaning", name: "by name" };

export async function render(ctx) {
  const [mode, a, b] = ctx.params;
  const query = mode === "q" ? a || "" : "";
  ctx.setTitle("Search", `<input type="text" id="q" class="topbar-input" list="recent-q" placeholder="a name, a topic, a half-remembered phrase…" value="${esc(query)}" autocomplete="off">
    <datalist id="recent-q">${[...new Set([...savedList(), ...recentList()])].map((q) => `<option value="${esc(q)}">`).join("")}</datalist>
    <button class="btn small" id="go">Search</button>`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split has-detail" id="search">
    <div class="master" id="browse-types"><div class="center small">Loading…</div></div>
    <div class="detail" id="search-main"></div></div>`;
  const run = () => { const q = $("#q").value.trim(); go(q ? "search/q/" + encodeURIComponent(q) : "search"); };
  $("#go").onclick = run;
  $("#q").onkeydown = (e) => { if (e.key === "Enter") run(); };
  if (!query) $("#q").focus();

  let types = [], hints = {};
  try { types = await api.get("/browse"); } catch {}
  try { hints = await api.get("/merge/hints"); } catch {}   // likely-duplicate counts for the badge
  const active = mode === "type" ? a : null;
  $("#browse-types").innerHTML = `<div class="glist"><div class="glist-sep" style="margin-top:0">Browse</div>
    ${types.map((t) => `<a href="#search/type/${encodeURIComponent(t.id)}" class="grow-row ${t.id === active ? "on" : ""}">
      <span><i class="legend-dot" style="background:${colorCss(t.color)}"></i> ${esc((t.icon ? t.icon + " " : "") + t.label)}</span><span class="count">${hints[t.id] ? `<span class="chip due" title="${hints[t.id]} likely duplicate${hints[t.id] === 1 ? "" : "s"} - open to merge">⚠ ${hints[t.id]}</span> ` : ""}${t.count}</span></a>`).join("")}</div>
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
    ${paintSaved()}
    <div class="center" style="padding-top:30px"><div class="big">🔍</div>Search above, or pick a type on the left to browse it.</div>`;
  bindSaved(main);
}

// Saved searches (★, kept until you remove them) and the last few you ran, as one-click chips.
function paintSaved() {
  const saved = savedList(), recent = recentList().filter((q) => !saved.some((x) => x.toLowerCase() === q.toLowerCase()));
  if (!saved.length && !recent.length) return "";
  return `<div class="card" id="saved-searches">
    ${saved.length ? `<div class="small muted" style="margin-bottom:6px">★ Saved searches</div><div class="ent-strip">${saved.map((q) => `<span class="chip"><a href="#search/q/${encodeURIComponent(q)}">${esc(q)}</a> <button class="legend-edit" data-unsave="${esc(q)}" title="Remove">✕</button></span>`).join("")}</div>` : ""}
    ${recent.length ? `<div class="small muted" style="margin:${saved.length ? "12px" : "0"} 0 6px">Recent <button class="legend-edit" id="clear-recent" title="Clear recent searches">clear</button></div><div class="ent-strip">${searchChips(recent, "data-recent")}</div>` : ""}
  </div>`;
}

function bindSaved(main) {
  $$("[data-unsave]", main).forEach((b) => b.onclick = async () => { await toggleSaved(b.dataset.unsave); b.closest("#saved-searches").outerHTML = paintSaved(); bindSaved(main); });
  const clr = $("#clear-recent", main);
  if (clr) clr.onclick = async () => { await clearRecent(); $("#saved-searches").outerHTML = paintSaved(); bindSaved(main); };
}

async function paintResults(main, q) {
  main.innerHTML = `<div class="center">Searching…</div>`;
  let r;
  try { r = await api.get("/search?q=" + encodeURIComponent(q)); }
  catch (e) { main.innerHTML = `<div class="center">Search failed: ${esc(e.message)}</div>`; return; }
  const fixes = Object.entries(r.corrected || {});
  rememberSearch(q);
  main.innerHTML = `<h1 class="page">Results for “${esc(q)}” <button class="btn ghost small" id="save-search" title="Keep this search on your Search page">${isSaved(q) ? "★ Saved" : "☆ Save search"}</button></h1>
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
  $("#save-search", main).onclick = async (e) => { await toggleSaved(q); e.target.textContent = isSaved(q) ? "★ Saved" : "☆ Save search"; };
}

// People / Concepts: every name with how many dumps it appears in. Tick two or more (or accept a
// "looks like duplicates" suggestion) and merge them into one node.
async function paintNames(main, t) {
  main.innerHTML = `<div class="center">Loading…</div>`;
  let rows, dupes = [];
  try { rows = await api.get(t.id === "person" ? "/people" : "/concepts"); }
  catch (e) { main.innerHTML = `<div class="center">Couldn't load: ${esc(e.message)}</div>`; return; }
  try { dupes = await api.get("/merge/suggestions?kind=" + t.id); } catch {}
  const picked = new Set();
  const paint = (filter = "") => {
    const list = rows.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
    $("#names", main).innerHTML = list.length ? list.map((r) => `
      <div class="name-row">
        <input type="checkbox" class="pick" data-name="${esc(r.name)}" ${picked.has(r.name) ? "checked" : ""} aria-label="Select ${esc(r.name)} to merge">
        <a class="grow" href="#search/type/${t.id}/${encodeURIComponent(r.name)}"><b>${esc(r.name)}</b><span class="small muted"> · last ${relTime(r.last_at)}</span></a>
        <span class="times" title="appears in ${r.count} dump${r.count === 1 ? "" : "s"}">${r.count}×</span></div>`).join("")
      : `<div class="center small">${rows.length ? "No match." : `No ${t.label.toLowerCase()} yet — they're picked up from your dumps.`}</div>`;
    $$(".pick", main).forEach((c) => c.onchange = () => { c.checked ? picked.add(c.dataset.name) : picked.delete(c.dataset.name); bar(); });
  };
  const bar = () => {
    $("#merge-bar", main).hidden = picked.size < 2;
    $("#merge-count", main).textContent = picked.size;
  };
  main.innerHTML = `<h1 class="page">${esc(t.label)}</h1>
    <p class="sub">${rows.length} ${rows.length === 1 ? "entry" : "entries"}. The number is how many dumps each appears in — pick one to read them. See the same thing twice? Tick both and merge.</p>
    <div class="row" style="margin:0 0 10px"><button class="btn small" id="scan-go" title="Checks spelling, nicknames, abbreviations and (with an AI model on) meaning. Nothing merges until you say so.">🔍 Scan for duplicates</button><span class="small muted" id="scan-status"></span></div>
    <div id="scan-results"></div>
    ${dupes.length ? `<div class="card dupes"><div class="small muted" style="margin-bottom:6px">Looks like duplicates</div>${dupes.map((g, i) => `
      <div class="row" style="margin:4px 0"><span class="grow">${g.map((e) => `<b>${esc(e.name)}</b> <span class="small muted">${e.count}×</span>`).join(" &nbsp;+&nbsp; ")}</span>
        <button class="btn ghost small" data-dupe="${i}">Merge…</button></div>`).join("")}</div>` : ""}
    ${rows.length > 8 ? `<input type="text" id="name-filter" class="add-content" placeholder="Filter…" autocomplete="off" style="margin-bottom:10px">` : ""}
    <div class="card names" id="names"></div>
    <div class="merge-bar" id="merge-bar" hidden><span><b id="merge-count">0</b> selected</span>
      <button class="btn small" id="merge-go">Merge into one…</button><button class="btn ghost small" id="merge-clear">Clear</button></div>`;
  paint();
  $("#name-filter", main)?.addEventListener("input", (e) => paint(e.target.value));
  $("#merge-clear", main).onclick = () => { picked.clear(); paint($("#name-filter", main)?.value || ""); bar(); };
  $("#merge-go", main).onclick = () => mergeDialog(t, [...picked].map((n) => rows.find((r) => r.name === n)).filter(Boolean), () => go("search/type/" + t.id));
  $("#scan-go", main).onclick = () => runScan(main, t);
  $$("[data-dupe]", main).forEach((b) => b.onclick = () => mergeDialog(t, dupes[+b.dataset.dupe], () => go("search/type/" + t.id)));
}

// The deep scan: spelling, nicknames, initials, meaning, and an AI second opinion when a model is on.
// Each result can be merged or dismissed ("not the same") - dismissed pairs never come back.
async function runScan(main, t) {
  const btn = $("#scan-go", main), status = $("#scan-status", main), box = $("#scan-results", main);
  btn.disabled = true; btn.textContent = "Scanning…"; status.textContent = "This can take a little while if an AI model is checking meaning.";
  box.innerHTML = "";
  let r;
  try { r = await api.post("/merge/scan", { kind: t.id }); }
  catch (e) { status.textContent = "Scan failed: " + e.message; btn.disabled = false; btn.textContent = "🔍 Scan for duplicates"; return; }
  btn.disabled = false; btn.textContent = "🔍 Scan again"; status.textContent = "";
  const level = (c) => (c >= 0.8 ? ["High", "ok"] : c >= 0.7 ? ["Likely", "due"] : ["Maybe", ""]);
  const notes = (r.notes || []).map((n) => `<div class="small muted" style="margin-top:6px">${esc(n)}</div>`).join("");
  const undo = `<div class="small" style="margin-top:8px"><a href="#" id="reset-dismissed">Show the ones I marked "not the same" again</a></div>`;
  const bindUndo = () => { const a = $("#reset-dismissed", box); if (a) a.onclick = async (e) => { e.preventDefault(); try { const x = await api.post("/merge/dismiss/reset"); toast(x.cleared ? "Cleared - scan again to see them" : "Nothing had been dismissed"); } catch (err) { toast(err.message, true); } }; };
  if (!r.groups.length) { box.innerHTML = `<div class="card"><b>No duplicates found</b> <span class="small muted">among ${r.checked} ${esc(t.label.toLowerCase())}.</span>${notes}${undo}</div>`; bindUndo(); return; }
  box.innerHTML = `<div class="card dupes"><div class="small muted" style="margin-bottom:6px">${r.groups.length} possible duplicate${r.groups.length === 1 ? "" : "s"} · ${r.checked} ${esc(t.label.toLowerCase())} checked${r.ai_reviewed ? " · AI-reviewed" : ""}</div>
    ${r.groups.map((g, i) => { const [lv, cls] = level(g.confidence); return `
      <div class="scan-hit" data-i="${i}"><div class="row" style="margin:4px 0">
        <span class="grow">${g.members.map((e) => `<b>${esc(e.name)}</b> <span class="small muted">${e.count}×</span>`).join(" &nbsp;+&nbsp; ")}
          <div class="small muted" style="margin-top:2px"><span class="chip ${cls}">${lv}</span> ${esc(g.reason)}${g.ai === "confirmed" ? " · ✓ AI agrees" : ""}</div></span>
        <button class="btn ghost small" data-merge="${i}">Merge…</button>
        <button class="btn ghost small" data-no="${i}" title="Don't suggest these together again">Not the same</button></div></div>`; }).join("")}${notes}${undo}</div>`;
  bindUndo();
  $$("[data-merge]", box).forEach((b) => b.onclick = () => {
    const g = r.groups[+b.dataset.merge];
    mergeDialog(t, g.members, () => go("search/type/" + t.id));
  });
  $$("[data-no]", box).forEach((b) => b.onclick = async () => {
    const g = r.groups[+b.dataset.no];
    try { await api.post("/merge/dismiss", { kind: t.id, names: g.members.map((m) => m.name) }); } catch (e) { toast(e.message, true); return; }
    b.closest(".scan-hit").remove();
  });
}

// Choose which name survives (or type a new one), then fold the rest into it.
function mergeDialog(t, group, done) {
  const best = [...group].sort((a, b) => b.count - a.count || a.name.length - b.name.length)[0];
  const m = modal(`<h2>Merge ${esc(t.label.toLowerCase())}</h2>
    <p class="small muted" style="margin:0 0 10px">Every dump that mentions any of these will mention the one you keep instead, and new dumps that use the old wording land on it too.</p>
    ${group.map((e) => `<label class="merge-opt"><input type="radio" name="keep" value="${esc(e.name)}" ${e === best ? "checked" : ""}> <b>${esc(e.name)}</b> <span class="small muted">${e.count}×</span></label>`).join("")}
    <label class="merge-opt"><input type="radio" name="keep" value="" id="keep-new"> Or a new name:
      <input type="text" id="new-name" maxlength="60" placeholder="type a name" style="margin-left:6px;flex:1"></label>
    <div class="row" style="margin:14px 0 0"><div class="grow small bad" id="merge-err"></div>
      <button class="btn ghost small" id="merge-cancel">Cancel</button><button class="btn small" id="merge-do">Merge</button></div>`);
  $("#new-name", m.el).onfocus = () => { $("#keep-new", m.el).checked = true; };
  $("#merge-cancel", m.el).onclick = m.close;
  $("#merge-do", m.el).onclick = async () => {
    const chosen = $("input[name=keep]:checked", m.el);
    const target = chosen.value || $("#new-name", m.el).value.trim();
    if (!target) { $("#merge-err", m.el).textContent = "Type the new name first."; return; }
    try {
      const r = await api.post("/merge", { kind: t.id, sources: group.map((e) => e.name), target });
      m.close();
      toast(`Merged into “${r.name}” — ${r.merged_dumps} dump${r.merged_dumps === 1 ? "" : "s"} updated`);
      done();
    } catch (e) { $("#merge-err", m.el).textContent = e.message; }
  };
}

// One person or concept: every dump that mentions them.
async function paintEntry(main, t, name) {
  main.innerHTML = `<div class="center">Loading…</div>`;
  let dumps;
  try { dumps = await api.get(`/${t.id === "person" ? "people" : "concepts"}/${encodeURIComponent(name)}`); }
  catch (e) { main.innerHTML = `<div class="center">Couldn't load: ${esc(e.message)}</div>`; return; }
  main.innerHTML = `<div class="row" style="margin:0 0 12px"><a class="btn ghost small" href="#search/type/${t.id}">← All ${esc(t.label.toLowerCase())}</a>
      <div class="grow"></div><button class="btn ghost small" id="merge-into" title="This is the same as another ${esc(t.label.toLowerCase())} entry">Merge into another…</button></div>
    <h1 class="page">${GLYPH[t.id]} ${esc(name)}</h1>
    <p class="sub">Appears in ${dumps.length} dump${dumps.length === 1 ? "" : "s"}, newest first.</p>
    ${dumps.map((d) => `
      <a class="card click dump-card" href="#history/${d.id}">
        <b>${esc(d.title)}</b> <span class="small muted">${fmtDate(d.created_at)}</span>
        <p class="small" style="margin-top:6px">${esc(d.raw_text)}${d.raw_text.length >= 160 ? "…" : ""}</p>
      </a>`).join("") || `<div class="center">Nothing mentions this yet.</div>`}`;
  $("#merge-into", main).onclick = async () => {
    let all;
    try { all = await api.get(t.id === "person" ? "/people" : "/concepts"); } catch { return; }
    const others = all.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    const m = modal(`<h2>Merge “${esc(name)}” into…</h2>
      <input type="text" id="mi-filter" placeholder="Filter…" autocomplete="off" style="width:100%;margin-bottom:8px">
      <div class="merge-list" id="mi-list"></div>`);
    const paint = (f = "") => {
      $("#mi-list", m.el).innerHTML = others.filter((e) => e.name.toLowerCase().includes(f.toLowerCase())).slice(0, 60).map((e) =>
        `<button class="name-row" data-to="${esc(e.name)}"><span class="grow"><b>${esc(e.name)}</b></span><span class="times">${e.count}×</span></button>`).join("") || `<div class="small muted">No match.</div>`;
      $$("[data-to]", m.el).forEach((b) => b.onclick = async () => {
        try {
          const r = await api.post("/merge", { kind: t.id, sources: [name], target: b.dataset.to });
          m.close(); toast(`Merged into “${r.name}”`); go(`search/type/${t.id}/${encodeURIComponent(r.name)}`);
        } catch (e) { toast(e.message, true); }
      });
    };
    paint();
    $("#mi-filter", m.el).oninput = (e) => paint(e.target.value);
    $("#mi-filter", m.el).focus();
  };
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
