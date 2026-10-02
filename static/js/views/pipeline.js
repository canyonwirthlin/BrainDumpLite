// Settings -> Data: "waiting for AI" queue and opt-in re-processing of existing dumps.
import { esc, toast } from "../ui.js";
import { api } from "../api.js";

let timer = null;

export async function paintPipeline(box) {
  clearTimeout(timer);
  if (!box || !box.isConnected) return;
  let s;
  try { s = await api.get("/pipeline/reprocess"); } catch (e) { box.innerHTML = `<div class="small bad">${esc(e.message)}</div>`; return; }
  const busy = s.running;
  const opts = [
    ["raw", `Dumps made without AI (${s.raw})`],
    ["other", `Dumps made by a different AI provider (${s.other})`],
    ["all", `Every dump (${s.all})`],
  ];
  box.innerHTML = `
    <p class="small muted" style="margin-bottom:10px">Switched AI model? You can run your existing dumps through the new one. Nothing is re-processed unless you ask. Titles, summaries, people and concepts are regenerated; tasks you already approved, finished or rejected are kept.</p>
    ${s.queued ? `<div class="small" style="margin-bottom:8px">${s.queued} dump${s.queued === 1 ? " is" : "s are"} waiting for AI${s.available ? " and will be processed shortly." : " - they run automatically once an AI model is on."}</div>` : ""}
    <div class="row" style="margin:0">
      <select id="rp-scope" ${busy ? "disabled" : ""}>${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
      <button class="btn small" id="rp-go" ${busy || !s.available ? "disabled" : ""}>${busy ? "Re-processing…" : "Re-process"}</button>
      ${busy ? `<button class="btn small ghost" id="rp-stop">Stop</button>` : ""}
    </div>
    <div class="small muted" style="margin-top:6px">${busy ? `${s.done + s.failed} of ${s.total} done${s.failed ? ` · ${s.failed} failed` : ""}`
      : !s.available ? "Turn on an AI model first (Settings → AI)." : ""}</div>
    ${busy ? `<div class="progress" style="margin-top:8px"><i style="width:${s.total ? Math.round(100 * (s.done + s.failed) / s.total) : 0}%"></i></div>` : ""}
    ${!busy && s.error ? `<div class="small bad" style="margin-top:6px">${esc(s.error)}</div>` : ""}`;
  const go = box.querySelector("#rp-go");
  if (go) go.onclick = async () => {
    const sel = box.querySelector("#rp-scope");
    const n = s[sel.value];
    if (!n) { toast("Nothing to re-process in that group."); return; }
    if (!confirm(`Re-process ${n} dump${n === 1 ? "" : "s"} with ${s.provider}? This uses your AI model for each one and replaces their titles, summaries and unreviewed suggestions.`)) return;
    try { await api.post("/pipeline/reprocess", { scope: sel.value, confirm: true }); } catch (e) { toast(e.message, true); }
    paintPipeline(box);
  };
  const stop = box.querySelector("#rp-stop");
  if (stop) stop.onclick = async () => { await api.post("/pipeline/reprocess/cancel"); paintPipeline(box); };
  if (busy) timer = setTimeout(() => paintPipeline(box), 1500);
}
