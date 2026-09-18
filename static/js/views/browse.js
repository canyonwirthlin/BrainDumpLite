// Concept / person browser: every dump that mentions it (master) + the selected dump (detail).
// Routes: #graph/concept/<name>/<dumpId?> and #graph/person/<name>/<dumpId?>.
import { $, esc, relTime, MODES, toneChip, trustBadge } from "../ui.js";
import { api } from "../api.js";
import { paintDetail } from "./history.js";

export async function render(ctx) {
  const [kind, name, id] = ctx.params;
  const label = kind === "person" ? "Person" : "Concept";
  ctx.setTitle(`${label}: ${name}`, `<a class="btn ghost small" href="#graph">← Graph</a>`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split ${id ? "has-detail" : ""}" id="hist">
    <div class="master"><div id="hist-list" class="center">Loading…</div></div>
    <div class="detail" id="hist-detail"></div></div>`;
  let dumps;
  try { dumps = await api.get(`/${kind === "person" ? "people" : "concepts"}/${encodeURIComponent(name)}`); }
  catch (e) { $("#hist-list").textContent = "Couldn't load: " + e.message; return; }
  const base = `#graph/${kind}/${encodeURIComponent(name)}`;
  $("#hist-list").className = "";
  $("#hist-list").innerHTML = `<div class="small muted" style="padding:12px 16px 4px">${dumps.length} dump${dumps.length === 1 ? "" : "s"} mention <b>${esc(name)}</b></div>` +
    (dumps.length ? dumps.map((d) => {
      const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
      return `<a class="drow ${d.id === id ? "sel" : ""}" href="${base}/${d.id}">
        <b>${esc(d.title)}</b>
        <div class="m"><span>${relTime(d.created_at)}</span><span class="tag">${mode.label}</span><span>${d.item_count} item${d.item_count === 1 ? "" : "s"}</span>${toneChip(d.tone)}${trustBadge(d.provider)}</div>
        <p>${esc(d.raw_text)}</p></a>`;
    }).join("") : `<div class="center">Nothing mentions this yet.</div>`);
  const wide = window.matchMedia("(min-width: 960px)").matches;
  if (!id && wide && dumps.length) { location.replace(`${base}/${dumps[0].id}`); return; }
  if (id) await paintDetail(id, base);
}
