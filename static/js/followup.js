// AI follow-up question card on a dump's result screen, plus its Settings switch.
// reviewHtml() renders an empty <div id="followup" data-dump="…">; mountFollowup() fills it in the
// background so a slow or absent AI never delays the screen.
import { $, esc, toast } from "./ui.js";
import { api } from "./api.js";

export const followupSlot = (d) => (d.status === "ready" ? `<div id="followup" data-dump="${esc(d.id)}"></div>` : "");

export async function mountFollowup(root, reload) {
  const box = $("#followup", root);
  if (!box) return;
  const id = box.dataset.dump;
  let f;
  try { f = await api.get(`/dumps/${id}/followup`); } catch { return; }
  if (!box.isConnected || f.state !== "open" || !f.question) return;
  box.innerHTML = `<div class="card followup">
    <h2>A question</h2>
    <p style="margin:0 0 10px">${esc(f.question)}</p>
    <textarea id="fu-text" rows="3" placeholder="Answer here, or skip it. It's added to this dump." style="width:100%"></textarea>
    <label class="small muted" style="display:flex;gap:6px;align-items:center;margin-top:8px">
      <input type="checkbox" id="fu-extract"> Also look for new tasks and ideas in my answer</label>
    <div class="row">
      <button class="btn" id="fu-send">Add to dump</button>
      <button class="btn ghost" id="fu-skip">Dismiss</button>
    </div></div>`;
  $("#fu-skip", box).onclick = async () => {
    try { await api.post(`/dumps/${id}/followup/dismiss`, {}); } catch {}
    box.innerHTML = "";
  };
  $("#fu-send", box).onclick = async () => {
    const text = $("#fu-text", box).value.trim();
    if (!text) { toast("Write an answer first", true); return; }
    $("#fu-send", box).disabled = true;
    try {
      const r = await api.post(`/dumps/${id}/followup/answer`, { text, extract: $("#fu-extract", box).checked });
      toast(r.items_added ? `Added to your dump, plus ${r.items_added} new item${r.items_added === 1 ? "" : "s"}` : "Added to your dump");
      if (reload) reload(); else box.innerHTML = "";
    } catch (e) { $("#fu-send", box).disabled = false; toast("Couldn't save: " + e.message, true); }
  };
}

// Settings → AI switch. Hidden when there's no AI to ask with.
export async function mountFollowupSetting(box) {
  if (!box) return;
  let s;
  try { s = await api.get("/followup/settings"); } catch { return; }
  if (!s.ai_available) return;
  box.innerHTML = `<div class="card"><div class="row" style="margin:0">
    <div class="grow"><b>Ask me a follow-up question</b>
      <div class="small muted">After a dump, the AI may ask one short question about something vague. Your answer is added
        to the dump. It never blocks saving, and you can always dismiss it.</div></div>
    <label class="sw"><input type="checkbox" id="followup-on" ${s.enabled ? "checked" : ""}><i></i></label></div></div>`;
  $("#followup-on", box).onchange = async (e) => {
    const want = e.target.checked;
    try { await api.put("/followup/settings", { enabled: want }); toast(want ? "Follow-up questions on" : "Follow-up questions off"); }
    catch (err) { e.target.checked = !want; toast("Couldn't save: " + err.message, true); }
  };
}
