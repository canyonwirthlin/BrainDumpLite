// History list + dump detail (master/detail arrives in Task 7).
import { $, $$, esc, fmtDate, MODES } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { reviewHtml, bindItemRows } from "./review.js";
import { renderProcessing } from "./capture.js";

export function render(ctx) {
  ctx.setTitle("History");
  return ctx.params[0] ? renderDumpDetail(ctx.params[0]) : renderHistory();
}

async function renderHistory() {
  $("#view").innerHTML = `<h1>History</h1><p class="sub">Every dump, newest first.</p><div id="list" class="center">Loading…</div>`;
  const dumps = await api.get("/dumps");
  if (!dumps.length) {
    $("#list").innerHTML = `<div class="center"><div class="big">🌱</div>Nothing here yet.<br><br><a class="btn" href="#capture">Make your first dump</a></div>`;
    return;
  }
  $("#list").className = "";
  $("#list").innerHTML = dumps.map((d) => {
    const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
    return `<div class="card click" onclick="location.hash='dump/${d.id}'">
      <div class="dump-row">
        <span class="status-dot ${d.status}"></span>
        <div class="grow">
          <b>${esc(d.title || (d.raw_text || "").slice(0, 60) || "Untitled")}</b>
          <div class="meta">${mode.icon} ${fmtDate(d.created_at)} · ${d.item_count} item${d.item_count === 1 ? "" : "s"}
            ${d.status === "processing" ? " · processing…" : d.status === "failed" ? " · failed" : ""}</div>
        </div>
      </div></div>`;
  }).join("");
}

async function renderDumpDetail(id) {
  $("#view").innerHTML = `<div class="center">Loading…</div>`;
  let d;
  try { d = await api.get("/dumps/" + id); }
  catch { $("#view").innerHTML = `<div class="center">Dump not found. <a href="#history">Back</a></div>`; return; }
  if (d.status === "processing" || d.status === "pending") { renderProcessing(id); return; }
  $("#view").innerHTML = reviewHtml(d, { showBack: true });
  bindItemRows($("#view"), d.items, () => renderDumpDetail(id));
  if ($("#approve-all")) $("#approve-all").onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) {
      await api.patch("/items/" + it.id, { status: "approved" });
      it.status = "approved";
    }
    $$("#items .item:not(.rejected) .ok").forEach((b) => b.classList.add("active"));
  };
  if ($("#delete-dump")) $("#delete-dump").onclick = async () => {
    if (!confirm("Delete this dump and its items?")) return;
    await api.del("/dumps/" + id);
    location.hash = "history";
  };
}
