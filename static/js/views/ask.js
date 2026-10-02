// Ask your brain: a chat over your dumps. Answers cite sources as [n]; each citation opens that dump.
// The conversation is kept in memory for the session (module scope), never stored.
import { $, esc, fmtDate, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";

let turns = [];  // [{role:"user"|"assistant", content, sources?}]

// Escape first, then turn [n] markers into links to the matching source's dump.
function linkCites(text, sources) {
  return esc(text).replace(/\[(\d+)\]/g, (m, n) => {
    const s = (sources || []).find((x) => x.n === Number(n));
    return s ? `<a class="chip cite" href="#history/${esc(s.id)}" title="${esc(s.title)}">${n}</a>` : m;
  }).replace(/\n/g, "<br>");
}

function paintTurn(t) {
  if (t.role === "user") return `<div class="card" style="margin-left:auto;max-width:80%;background:var(--accent-soft, transparent)">${esc(t.content)}</div>`;
  const src = (t.sources || []).filter((s) => s.cited).concat((t.sources || []).filter((s) => !s.cited));
  return `<div class="card"><div>${linkCites(t.content, t.sources)}</div>
    ${src.length ? `<div class="small muted" style="margin:10px 0 4px">Sources</div>
      ${src.map((s) => `<a class="card click" href="#history/${esc(s.id)}" style="display:block;margin:4px 0;${s.cited ? "" : "opacity:.65"}">
        <b>[${s.n}] ${esc(s.title)}</b> <span class="small muted">${fmtDate ? esc(fmtDate(s.created_at)) : ""}</span>
        <div class="small muted">${esc(s.snippet)}</div></a>`).join("")}` : ""}</div>`;
}

export function render(ctx) {
  ctx.setTitle("Ask", "");
  const off = !state.status.ai;
  $("#view").innerHTML = `<h1 class="page">Ask your brain</h1>
    <p class="sub">Questions answered only from your own dumps, with the sources cited.</p>
    ${off ? `<div class="card">AI is off. <a href="#settings/ai">Set up a model</a> to ask questions about your dumps.</div>` : ""}
    <div id="ask-log" style="display:grid;gap:10px;margin:14px 0"></div>
    <div style="display:flex;gap:8px"><input type="text" id="ask-q" class="topbar-input" style="flex:1" placeholder="e.g. what did I decide about the dentist?" autocomplete="off" ${off ? "disabled" : ""}>
      <button class="btn" id="ask-go" ${off ? "disabled" : ""}>Ask</button>
      <button class="btn small" id="ask-clear" ${turns.length ? "" : "hidden"}>New chat</button></div>`;
  const log = $("#ask-log");
  const paint = () => { log.innerHTML = turns.map(paintTurn).join(""); $("#ask-clear").hidden = !turns.length; };
  paint();
  let busy = false;
  const send = async () => {
    const q = $("#ask-q").value.trim();
    if (!q || busy) return;
    busy = true; $("#ask-go").disabled = true;
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    turns.push({ role: "user", content: q });
    $("#ask-q").value = "";
    paint();
    log.insertAdjacentHTML("beforeend", `<div class="center small muted" id="ask-wait">Thinking…</div>`);
    try {
      const r = await api.post("/ask", { question: q, history });
      turns.push({ role: "assistant", content: r.answer, sources: r.sources });
    } catch (e) {
      toast(e.message || "Couldn't ask", true);
      turns.pop();
      $("#ask-q").value = q;
    }
    busy = false; $("#ask-go").disabled = false;
    paint();
    $("#ask-q").focus();
  };
  $("#ask-go").onclick = send;
  $("#ask-q").onkeydown = (e) => { if (e.key === "Enter") send(); };
  $("#ask-clear").onclick = () => { turns = []; paint(); };
  if (!off) $("#ask-q").focus();
}
