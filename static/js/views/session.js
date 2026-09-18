// Conversational capture: a streaming chat with the therapy/brainstorm persona,
// plus a right panel of items noticed so far. Ending saves everything as one dump.
import { $, $$, esc, md, toast, kindBadge, MODES } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { go } from "../router.js";
import { toggleRecording } from "./capture.js";
import { attach as attachWikilinks } from "../wikilinks.js";
import { formHtml, readForm, schemaFor } from "../tools.js";

let pollTimer = null;

export async function render(ctx) {
  const sid = ctx.params[0];
  if (!sid) { go("capture"); return; }
  let s;
  try { s = await api.get("/sessions/" + sid); }
  catch { ctx.setTitle("Conversation"); $("#view").innerHTML = `<div class="center">Session not found. <a href="#capture">Back</a></div>`; return; }
  if (s.status === "ended" && s.dump_id) { location.replace("#history/" + s.dump_id); return; }
  const mode = MODES.find((m) => m.id === s.mode) || { icon: "💬", label: s.mode };
  ctx.setTitle(`${mode.icon} ${mode.label} conversation`,
    `<button class="btn small" id="sess-end">End &amp; save</button><button class="btn ghost small" id="sess-discard">Discard</button>`);
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split right has-detail" id="sess">
    <div class="detail chat">
      <div class="bubbles" id="bubbles">${s.transcript.length ? s.transcript.map(bubble).join("")
        : `<div class="center small muted">${s.mode === "therapy" ? "Say what's on your mind. I'll listen and ask one question at a time." : "Throw an idea at me — I'll build on it and push it somewhere new."}</div>`}</div>
      <div class="composer">
        <textarea id="sess-text" class="editor" rows="3" placeholder="Type, or hit the mic and talk…"></textarea>
        <div class="row" style="margin-top:8px">
          ${state.status.whisper ? `<button class="mic" id="mic" title="Record voice">🎙️</button><span class="muted small" id="rec-status"></span>` : ""}
          <span class="small muted"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send</span>
          <div class="grow"></div>
          <button class="btn" id="sess-send">Send</button>
        </div>
      </div>
    </div>
    <aside class="master noticed">
      <div class="sec" style="margin:14px 16px 6px">Noticed so far</div>
      <div id="sess-items" class="small muted" style="padding:0 16px">Nothing yet — items show up as you talk.</div>
      <div class="small muted" style="padding:14px 16px;border-top:1px solid var(--line);margin-top:auto">Ending the conversation runs the full pipeline on the whole transcript, so the final items may differ from this preview.</div>
    </aside></div>`;
  const ta = $("#sess-text");
  attachWikilinks(ta);
  ta.focus();
  const send = () => sendMessage(sid, ta.value.trim());
  $("#sess-send").onclick = send;
  ta.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
  if ($("#mic")) $("#mic").onclick = () => toggleRecording("#sess-text");
  $("#sess-end").onclick = async () => {
    try { const { dump_id } = await api.post(`/sessions/${sid}/end`); go("history/" + dump_id); }
    catch (e) { toast(e.message, true); }
  };
  $("#sess-discard").onclick = async () => {
    if (!confirm("Discard this conversation? Nothing will be saved.")) return;
    await api.del("/sessions/" + sid);
    go("capture");
  };
  paintItems(sid, s.items);
}

function bubble(t) {
  if (t.role === "tool") return `<div class="bubble tool ${t.is_error ? "bad" : ""}">
    <div class="small"><b class="mono">🔌 ${esc(t.tool || "tool")}</b> ${esc(JSON.stringify(t.args || {}))}</div>
    <pre class="toolout">${esc(t.content)}</pre></div>`;
  return `<div class="bubble ${t.role}">${t.role === "assistant" ? md(t.content) : esc(t.content)}</div>`;
}

// The model may propose one tool call per turn; an "ask" tool waits for this card.
async function toolCard(sid, p, box) {
  const el = document.createElement("div");
  el.className = "bubble propose";
  el.innerHTML = `<div class="small"><b>🔌 Use ${esc(p.server)}/${esc(p.tool)}?</b>${p.why ? ` <span class="muted">${esc(p.why)}</span>` : ""}</div>
    ${formHtml(await schemaFor(p.server, p.tool, p.args || {}), p.args)}
    <div class="row" style="margin:8px 0 0"><div class="grow"></div>
      <button class="btn ghost small" data-no>No thanks</button><button class="btn small" data-yes>Run it</button></div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  $("[data-no]", el).onclick = () => el.remove();
  $("[data-yes]", el).onclick = async () => {
    let args;
    try { args = readForm(el); } catch (e) { toast(e.message, true); return; }
    $("[data-yes]", el).disabled = true;
    try {
      const r = await api.post(`/sessions/${sid}/tool`, { server: p.server, tool: p.tool, args });
      el.replaceWith(Object.assign(document.createElement("div"), {
        innerHTML: bubble({ role: "tool", content: r.text, tool: `${p.server}/${p.tool}`, args, is_error: r.is_error }),
      }).firstChild);
    } catch (e) { toast(e.message, true); $("[data-yes]", el).disabled = false; }
    box.scrollTop = box.scrollHeight;
  };
}

async function sendMessage(sid, text) {
  if (!text) return;
  const ta = $("#sess-text"), btn = $("#sess-send"), box = $("#bubbles");
  ta.value = ""; btn.disabled = true;
  $(".center", box)?.remove();
  box.insertAdjacentHTML("beforeend", bubble({ role: "user", content: text }));
  const live = document.createElement("div");
  live.className = "bubble assistant streaming";
  box.appendChild(live);
  box.scrollTop = box.scrollHeight;
  let full = "", proposed = null;
  startPolling(sid);
  try {
    const res = await fetch(`/api/sessions/${sid}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).detail || m; } catch {} throw new Error(m); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", event = "message";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (event === "error") throw new Error(data);
            if (event === "message") { full += data; live.textContent = full; box.scrollTop = box.scrollHeight; }
            if (event === "tool") proposed = data;
            event = "message";
          }
        }
      }
    }
    live.classList.remove("streaming");
    live.innerHTML = md(full || "…");
    if (proposed) {
      if (proposed.mode === "auto") {
        try {
          const r = await api.post(`/sessions/${sid}/tool`, { server: proposed.server, tool: proposed.tool, args: proposed.args });
          box.insertAdjacentHTML("beforeend", bubble({ role: "tool", content: r.text, tool: `${proposed.server}/${proposed.tool}`, args: proposed.args, is_error: r.is_error }));
          box.scrollTop = box.scrollHeight;
        } catch (e) { toast(e.message, true); }
      } else {
        toolCard(sid, proposed, box);
      }
    }
  } catch (e) {
    live.classList.remove("streaming");
    live.innerHTML = `<span class="muted">Couldn't get a reply: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false; ta.focus();
    setTimeout(() => stopPolling(sid), 6000);
  }
}

async function paintItems(sid, items) {
  if (items == null) { try { items = await api.get(`/sessions/${sid}/items`); } catch { return; } }
  const box = $("#sess-items");
  if (!box) { stopPolling(); return; }
  if (!items.length) return;
  box.className = "noticed-list";
  box.innerHTML = items.map((it) => `<div class="mi">${kindBadge(it.kind)} <span>${esc(it.content)}</span></div>`).join("");
}

function startPolling(sid) {
  if (pollTimer) return;
  pollTimer = setInterval(() => paintItems(sid), 3000);
}
function stopPolling(sid) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (sid) paintItems(sid);
}
