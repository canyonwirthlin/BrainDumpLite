// Keyword + semantic search.
import { $, esc, fmtDate } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";

export function render(ctx) {
  ctx.setTitle("Search");
  $("#view").innerHTML = `
    <h1>Search your brain</h1>
    <p class="sub">${state.status.ai ? "Keyword + semantic search across every dump." : "Keyword search across every dump."}</p>
    <div class="row" style="margin:0 0 16px">
      <input type="text" id="q" class="grow" placeholder="burnout, that app idea, mom's birthday…" autofocus>
      <button class="btn" id="go">Search</button>
    </div>
    <div id="results"></div>`;
  const go = async () => {
    const q = $("#q").value.trim();
    if (!q) return;
    $("#results").innerHTML = `<div class="center">Searching…</div>`;
    const rows = await api.get("/search?q=" + encodeURIComponent(q));
    $("#results").innerHTML = rows.length ? rows.map((r) => `
      <div class="card click" onclick="location.hash='dump/${r.id}'">
        <b>${esc(r.title || "Untitled")}</b>
        <span class="chip">${r.via}</span>
        <div class="meta small muted">${fmtDate(r.created_at)}</div>
        <div class="small" style="margin-top:6px">${esc(r.snippet || "").replace(/「/g, "<b>").replace(/」/g, "</b>")}</div>
      </div>`).join("")
      : `<div class="center"><div class="big">🔍</div>No matches for “${esc(q)}”.</div>`;
  };
  $("#go").onclick = go;
  $("#q").onkeydown = (e) => { if (e.key === "Enter") go(); };
}
