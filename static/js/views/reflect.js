// Daily / weekly reflections.
import { $, $$, md, esc, relTime, toneChip } from "../ui.js";
import { api } from "../api.js";

export function render(ctx) {
  ctx.setTitle("Reflect");
  $("#view").innerHTML = `
    <div id="resurface"></div>
    <h1>Reflect</h1>
    <p class="sub">Your second brain reads everything back to you.</p>
    ${["daily", "weekly"].map((k) => `
      <div class="card">
        <div class="row" style="margin:0 0 6px">
          <h2 class="grow">${k === "daily" ? "☀️ Today" : "📆 This week"}</h2>
          <button class="btn ghost small" data-kind="${k}" data-force="0">Generate</button>
          <button class="btn ghost small" data-kind="${k}" data-force="1" title="Ignore cache">↻</button>
        </div>
        <div id="reflect-${k}" class="muted small">Press Generate.</div>
      </div>`).join("")}`;
  paintResurface();
  $$("[data-kind]").forEach((b) => b.onclick = async () => {
    const box = $("#reflect-" + b.dataset.kind);
    box.innerHTML = `<span class="spin"></span>`;
    try {
      const r = await api.post("/reflect", { kind: b.dataset.kind, force: b.dataset.force === "1" });
      box.className = "";
      box.innerHTML = md(r.content) + (r.cached ? `<div class="small muted" style="margin-top:6px">cached — ↻ to regenerate</div>` : "");
    } catch (e) {
      box.className = "muted small";
      box.textContent = "Failed: " + e.message;
    }
  });
}


async function paintResurface() {
  const box = $("#resurface");
  if (!box) return;
  let r;
  try { r = await api.get("/resurface"); } catch { return; }
  if (!r || !r.dump) return;
  box.innerHTML = `<div class="card click resurface" onclick="location.hash='history/${r.dump.id}'">
    <div class="sec" style="margin-top:0">🕰️ ${esc(r.reason)}</div>
    <b>${esc(r.dump.title)}</b> <span class="small muted">${relTime(r.dump.created_at)}</span> ${toneChip(r.dump.tone)}
    <p class="small muted" style="margin-top:6px">${esc(r.dump.raw_text)}</p></div>`;
}
