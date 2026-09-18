// History as master/detail: filterable list on the left, the selected dump on the right.
import { $, $$, esc, relTime, MODES } from "../ui.js";
import { api } from "../api.js";
import { reviewHtml, bindItemRows } from "./review.js";
import { renderProcessing } from "./capture.js";
import { go } from "../router.js";

let filterMode = "all", filterText = "";

export async function render(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle("History", `<input type="text" id="hist-q" placeholder="Filter dumps…" value="${esc(filterText)}" class="topbar-input">`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split ${id ? "has-detail" : ""}" id="hist">
    <div class="master"><div class="chips" id="hist-chips"></div><div id="hist-list" class="center">Loading…</div></div>
    <div class="detail" id="hist-detail"></div></div>`;
  let dumps;
  try { dumps = await api.get("/dumps?limit=200"); }
  catch (e) { $("#hist-list").textContent = "Couldn't load: " + e.message; return; }
  const paintList = () => {
    const modes = [["all", "All"], ...MODES.map((m) => [m.id, m.label])];
    $("#hist-chips").innerHTML = modes.map(([v, l]) => `<button class="chip ${v === filterMode ? "on" : ""}" data-m="${v}">${l}</button>`).join("");
    $$("#hist-chips .chip").forEach((b) => b.onclick = () => { filterMode = b.dataset.m; paintList(); });
    const q = filterText.toLowerCase();
    const rows = dumps.filter((d) => (filterMode === "all" || d.mode === filterMode) &&
      (!q || (d.title || "").toLowerCase().includes(q) || (d.raw_text || "").toLowerCase().includes(q)));
    $("#hist-list").className = "";
    $("#hist-list").innerHTML = rows.length ? rows.map((d) => {
      const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
      return `<a class="drow ${d.id === id ? "sel" : ""}" href="#history/${d.id}">
        <b>${esc(d.title || (d.raw_text || "").slice(0, 60) || "Untitled")}</b>
        <div class="m"><span>${relTime(d.created_at)}</span><span class="tag">${mode.label}</span><span>${d.item_count} item${d.item_count === 1 ? "" : "s"}</span>
          ${d.status === "processing" || d.status === "pending" ? "<span>processing…</span>" : d.status === "failed" ? "<span>failed</span>" : ""}</div>
        <p>${esc((d.clean_text || d.raw_text || "").slice(0, 160))}</p></a>`;
    }).join("") : `<div class="center"><div class="big">🌱</div>${dumps.length ? "No dumps match." : `Nothing here yet.<br><br><a class="btn" href="#capture">Make your first dump</a>`}</div>`;
  };
  paintList();
  const qEl = $("#hist-q");
  if (qEl) qEl.oninput = (e) => { filterText = e.target.value; paintList(); };
  const wide = window.matchMedia("(min-width: 960px)").matches;
  if (!id && wide && dumps.length) { location.replace("#history/" + dumps[0].id); return; }
  if (id) await paintDetail(id);
}

async function paintDetail(id) {
  const box = $("#hist-detail");
  if (!box) return;
  box.innerHTML = `<div class="center">Loading…</div>`;
  let d;
  try { d = await api.get("/dumps/" + id); }
  catch { box.innerHTML = `<div class="center">Dump not found. <a href="#history">Back</a></div>`; return; }
  if (d.status === "processing" || d.status === "pending") { renderProcessing(id, box); return; }
  box.innerHTML = `<a class="btn ghost small back" href="#history">← All dumps</a>` + reviewHtml(d, { detail: true });
  bindItemRows(box, d.items, () => paintDetail(id));
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
