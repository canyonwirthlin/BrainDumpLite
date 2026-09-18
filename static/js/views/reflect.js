// Daily / weekly reflections.
import { $, $$, md } from "../ui.js";
import { api } from "../api.js";

export function render(ctx) {
  ctx.setTitle("Reflect");
  $("#view").innerHTML = `
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
