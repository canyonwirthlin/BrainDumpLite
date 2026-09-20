// History as master/detail: filterable list on the left, the selected dump on the right.
import { $, $$, esc, relTime, MODES, toneChip, trustBadge } from "../ui.js";
import { api } from "../api.js";
import { reviewHtml, bindItemRows } from "./review.js";
import { renderProcessing } from "./capture.js";
import { go } from "../router.js";
import { on } from "../state.js";
import { bindDumpEdit } from "../dumpedit.js";

let filterMode = "all", filterText = "";
let cache = [];  // the dumps behind the list, so a rename in the detail pane can update its row
on("dump:changed", ({ id, title }) => {
  const d = cache.find((x) => x.id === id);
  if (d) d.title = title;
  const row = document.querySelector(`#hist-list a[href="#history/${id}"] b`);
  if (row) row.textContent = title;
});

export async function render(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle("History", `<input type="text" id="hist-q" placeholder="Filter dumps…" value="${esc(filterText)}" class="topbar-input">`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split ${id ? "has-detail" : ""}" id="hist">
    <div class="master"><div class="chips" id="hist-chips"></div><div id="hist-list" class="center">Loading…</div></div>
    <div class="detail" id="hist-detail"></div></div>`;
  let dumps, open = [];
  try { open = await api.get("/sessions?open=1"); } catch {}
  try { dumps = await api.get("/dumps?limit=200"); }
  catch (e) { $("#hist-list").textContent = "Couldn't load: " + e.message; return; }
  cache = dumps;
  const paintList = () => {
    const modes = [["all", "All"], ...MODES.map((m) => [m.id, m.label])];
    $("#hist-chips").innerHTML = modes.map(([v, l]) => `<button class="chip ${v === filterMode ? "on" : ""}" data-m="${v}">${l}</button>`).join("");
    $$("#hist-chips .chip").forEach((b) => b.onclick = () => { filterMode = b.dataset.m; paintList(); });
    const q = filterText.toLowerCase();
    const rows = dumps.filter((d) => (filterMode === "all" || d.mode === filterMode) &&
      (!q || (d.title || "").toLowerCase().includes(q) || (d.raw_text || "").toLowerCase().includes(q)));
    $("#hist-list").className = "";
    const openRows = (filterMode === "all" && !q) ? open.map((o) => {
      const mode = MODES.find((m) => m.id === o.mode) || MODES[0];
      const last = [...o.transcript].reverse().find((t) => t.role === "user");
      return `<a class="drow sess" href="#session/${o.id}">
        <b>${mode.icon} Unfinished ${mode.label.toLowerCase()} conversation</b>
        <div class="m"><span>${relTime(o.started_at)}</span><span class="tag">conversation</span><span>${o.transcript.filter((t) => t.role === "user").length} turns</span><span class="resume">Resume →</span></div>
        <p>${esc(last ? last.content.slice(0, 160) : "Nothing said yet.")}</p></a>`;
    }).join("") : "";
    $("#hist-list").innerHTML = openRows + (rows.length ? rows.map((d) => {
      const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
      return `<a class="drow ${d.id === id ? "sel" : ""}" href="#history/${d.id}">
        <b>${esc(d.title || (d.raw_text || "").slice(0, 60) || "Untitled")}</b>
        <div class="m"><span>${relTime(d.created_at)}</span><span class="tag">${mode.label}</span><span>${d.item_count} item${d.item_count === 1 ? "" : "s"}</span>${toneChip(d.tone)}${trustBadge(d.provider)}
          ${d.status === "processing" || d.status === "pending" ? "<span>processing…</span>" : d.status === "failed" ? "<span>failed</span>" : ""}</div>
        <p>${esc((d.clean_text || d.raw_text || "").slice(0, 160))}</p></a>`;
    }).join("") : (openRows ? "" : `<div class="center"><div class="big">🌱</div>${dumps.length ? "No dumps match." : `Nothing here yet.<br><br><a class="btn" href="#capture">Make your first dump</a>`}</div>`));
  };
  paintList();
  const qEl = $("#hist-q");
  if (qEl) qEl.oninput = (e) => { filterText = e.target.value; paintList(); };
  const wide = window.matchMedia("(min-width: 960px)").matches;
  if (!id && wide && dumps.length) { location.replace("#history/" + dumps[0].id); return; }
  if (id) await paintDetail(id);
}

export async function paintDetail(id, base = "#history") {
  const box = $("#hist-detail");
  if (!box) return;
  box.innerHTML = `<div class="center">Loading…</div>`;
  let d;
  try { d = await api.get("/dumps/" + id); }
  catch { box.innerHTML = `<div class="center">Dump not found. <a href="#history">Back</a></div>`; return; }
  if (d.status === "processing" || d.status === "pending") { renderProcessing(id, box, () => paintDetail(id)); return; }
  box.innerHTML = `<a class="btn ghost small back" href="${base}">← Back</a>` + reviewHtml(d, { detail: true });
  paintBacklinks(id, $("#backlinks", box));
  const reload = () => paintDetail(id, base);
  bindItemRows(box, d.items, reload);
  bindDumpEdit(box, d, { reload, onTags: () => paintBacklinks(id, $("#backlinks", box)) });
  if ($("#approve-all", box)) $("#approve-all", box).onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) { await api.patch("/items/" + it.id, { status: "approved" }); it.status = "approved"; }
    $$("#items .item:not(.rejected) .ok", box).forEach((b) => b.classList.add("active"));
  };
  if ($("#delete-dump", box)) $("#delete-dump", box).onclick = async () => {
    if (!confirm("Delete this dump and its items?")) return;
    await api.del("/dumps/" + id);
    go("history");
  };
}


async function paintBacklinks(id, box) {
  if (!box) return;
  let b;
  try { b = await api.get(`/dumps/${id}/backlinks`); } catch { box.hidden = true; return; }
  const row = (d) => `<a class="bl" href="#history/${d.id}">${esc(d.title)} <span class="muted small">${relTime(d.created_at)}</span></a>`;
  const groups = [];
  if (b.similar.length) groups.push(`<div class="sec" style="margin-top:0">Similar dumps</div>${b.similar.map(row).join("")}`);
  for (const g of b.via_concepts) groups.push(`<div class="sec">Also about <a href="#graph/concept/${encodeURIComponent(g.name)}">${esc(g.name)}</a></div>${g.dumps.map(row).join("")}`);
  for (const g of b.via_people) groups.push(`<div class="sec">Also mentions <a href="#graph/person/${encodeURIComponent(g.name)}">${esc(g.name)}</a></div>${g.dumps.map(row).join("")}`);
  box.hidden = !groups.length;
  if (!groups.length) return;
  box.innerHTML = `<h2>Linked from</h2>${groups.join("")}`;
}
