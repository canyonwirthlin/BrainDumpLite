// Capture stage, processing progress and voice recording.
import { $, $$, esc, toast, md, MODES, modeOf, STAGES, kindBadge, toneChip } from "../ui.js";
import { go } from "../router.js";
import { attach as attachWikilinks } from "../wikilinks.js";
import { api } from "../api.js";
import { state, clearPoll } from "../state.js";
import { renderReview } from "./review.js";

export function render(ctx) {
  ctx.setTitle("Capture");
  $("#view").innerHTML = `
    <div class="glow" id="cap-glow"></div>
    <div class="capture" id="cap">
      <h1 class="hero" id="cap-hero"></h1>
      <p class="sub" id="cap-sub"></p>
      <a href="#stats" class="streak-badge" id="streak-badge" hidden></a>
      ${state.status.ai ? "" : `<div class="banner">AI is off — dumps are saved raw without processing.
        <a href="#settings">Connect a key in Settings</a> to unlock the magic.</div>`}
      <div class="modes" role="tablist">${MODES.map((m) => `
        <button class="mode-chip" role="tab" data-mode="${m.id}" style="--mode:${m.color}">${m.icon} ${m.label}</button>`).join("")}
      </div>
      <div class="mode-info" id="mode-info" aria-live="polite"></div>
      <div id="cap-body"></div>
    </div>`;
  $$(".mode-chip").forEach((b) => b.onclick = () => { state.curMode = b.dataset.mode; paintMode(); });
  paintMode();
  paintStreakBadge();
}

// Everything that changes with the mode: colour, headline, the explainer, and the input itself.
// Brainstorm and Therapy are conversations, so (with AI on) they get a chat window instead of
// a blank page; Freeform and Execution stay one-shot editors, Execution styled as a checklist.
function paintMode() {
  const m = modeOf(state.curMode);
  const chat = m.chat && state.status.ai;
  const cap = $("#cap");
  cap.dataset.mode = m.id;
  cap.style.setProperty("--mode", m.color);
  $("#cap-glow").style.setProperty("--mode", m.color);
  $$(".mode-chip").forEach((b) => { const on = b.dataset.mode === m.id; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("#cap-hero").textContent = m.hero;
  $("#cap-sub").textContent = m.sub;
  $("#mode-info").innerHTML = `<div class="mi-art">${m.art}</div>
    <div><b>${m.icon} ${esc(m.label)}</b><p>${esc(m.about)}</p>
      <span class="mi-how">${esc(chat || !m.chat ? m.how : "Chat needs AI — saved as a one-shot dump for now")}</span></div>`;

  $("#cap-body").innerHTML = `${chat ? `<div class="chatbox">
      <div class="cb-thread"><div class="bubble assistant">${esc(m.opener)}</div></div>
      <div class="cb-composer">` : ""}
    <textarea id="dump-text" class="editor ${m.id === "execution" ? "tasklist" : ""} ${chat ? "chat-input" : ""}" placeholder="${esc(m.placeholder)}">${esc(state.draft)}</textarea>
    <div class="row">
      ${state.status.whisper ? `<button class="mic" id="mic" title="Record voice">🎙️</button>
        <span class="muted small" id="rec-status"></span>` : ""}
      <div class="grow"></div>
      ${chat ? `<button class="btn ghost" id="dump-btn" title="Skip the conversation and save this as a one-shot dump">Just save it</button>
        <button class="btn" id="talk-btn">Start talking →</button>`
             : `<button class="btn" id="dump-btn">Dump it →</button>`}
    </div>
    ${chat ? "</div></div>" : ""}
    <div class="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to ${chat ? "start the conversation" : "dump"}${m.id === "execution" ? " · one task per line works best" : ""}</div>`;

  const ta = $("#dump-text");
  ta.oninput = (e) => { state.draft = e.target.value; };
  attachWikilinks(ta);
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chat ? startTalk() : submitDump(); }
  };
  $("#dump-btn").onclick = submitDump;
  if ($("#talk-btn")) $("#talk-btn").onclick = startTalk;
  if ($("#mic")) $("#mic").onclick = () => toggleRecording();
}

async function startTalk() {
  try {
    const s = await api.post("/sessions", { mode: state.curMode });
    const text = $("#dump-text").value.trim();
    if (text) sessionStorage.setItem("bdl-session-opener", text);
    state.draft = "";
    go("session/" + s.id);
  } catch (e) { toast(e.message, true); }
}

async function paintStreakBadge() {
  let s;
  try { s = await api.get("/streaks"); } catch { return; }
  const el = $("#streak-badge");
  if (!el) return;  // navigated away before this landed
  el.hidden = false;
  el.classList.toggle("lit", s.current_streak > 0);
  el.classList.toggle("at-risk", s.at_risk);
  el.textContent = s.current_streak > 0
    ? `🔥 ${s.current_streak}-day streak${s.at_risk ? " — dump today to keep it" : ""}`
    : "Start a streak today →";
}

async function submitDump() {
  const text = $("#dump-text").value.trim();
  if (!text) return;
  $("#dump-btn").disabled = true;
  try {
    const { id } = await api.post("/dumps", { text, mode: state.curMode });
    state.draft = "";
    renderProcessing(id);
  } catch (e) {
    toast("Failed to save dump: " + e.message, true);
    $("#dump-btn").disabled = false;
  }
}

const AI_OUTPUT_KEY = "bdl-show-ai-output";
const showAiOutput = () => { try { return localStorage.getItem(AI_OUTPUT_KEY) === "1"; } catch { return false; } };
const setShowAiOutput = (v) => { try { localStorage.setItem(AI_OUTPUT_KEY, v ? "1" : "0"); } catch {} };

// What the pipeline has produced so far, as each field lands (see app/pipeline.py's
// per-stage _set calls) — off by default, since most people just want the result.
function drawAiOutput(d) {
  const box = $("#ai-output");
  if (!box) return;
  const parts = [];
  if (d.clean_text) parts.push(`<div class="ao-field"><h3>Cleaned text</h3><p>${esc(d.clean_text)}</p></div>`);
  if (d.title || d.summary) parts.push(`<div class="ao-field"><h3>Title &amp; summary</h3>
    ${d.title ? `<p><b>${esc(d.title)}</b></p>` : ""}${d.summary ? md(d.summary) : ""}${toneChip(d.tone)}</div>`);
  if ((d.people || []).length || (d.concepts || []).length) parts.push(`<div class="ao-field"><h3>People &amp; concepts</h3>
    <div class="wl">${(d.concepts || []).map((c) => `<span class="wl-chip">${esc(c)}</span>`).join("")}
    ${(d.people || []).map((p) => `<span class="wl-chip p">@${esc(p)}</span>`).join("")}</div></div>`);
  if ((d.items || []).length) parts.push(`<div class="ao-field"><h3>Extracted items</h3>
    ${d.items.map((it) => `<div class="ao-item">${kindBadge(it.kind)} ${esc(it.content)}</div>`).join("")}</div>`);
  box.innerHTML = parts.length ? parts.join("") : `<p class="small muted">Nothing from the AI yet…</p>`;
}

export function renderProcessing(id, container = $("#view"), onReady = null) {
  container.innerHTML = `
    <h1>Processing…</h1>
    <p class="sub">${state.status.ai ? "The pipeline is chewing on your dump." : "Saving (AI off — raw mode)."}</p>
    <div class="card"><div class="stages" id="stages"></div></div>
    ${state.status.ai ? `<details class="card ao-wrap" id="ao-details" ${showAiOutput() ? "open" : ""}>
      <summary>Show AI output as it arrives</summary>
      <div id="ai-output" class="ao-body"><p class="small muted">Nothing from the AI yet…</p></div>
    </details>` : ""}`;
  if ($("#ao-details")) $("#ao-details").ontoggle = (e) => setShowAiOutput(e.target.open);
  const draw = (stage, statusVal) => {
    const idx = STAGES.findIndex(([k]) => k === stage);
    $("#stages").innerHTML = STAGES.map(([k, label], i) => {
      const done = statusVal === "ready" || (idx >= 0 && i < idx);
      const now = k === stage && statusVal === "processing";
      return `<div class="stage ${done ? "done" : ""} ${now ? "now" : ""}">
        <div class="dot">${done ? "✓" : now ? '<span class="spin"></span>' : ""}</div>${label}</div>`;
    }).join("");
  };
  draw(null, "pending");
  state.pollTimer = setInterval(async () => {
    try {
      const d = await api.get("/dumps/" + id);
      draw(d.stage, d.status);
      drawAiOutput(d);
      if (d.status === "ready") {
        clearInterval(state.pollTimer); state.pollTimer = null;
        if (onReady) onReady(d); else renderReview(d);
      } else if (d.status === "failed") {
        clearInterval(state.pollTimer); state.pollTimer = null;
        container.innerHTML = `<h1>Hmm.</h1><div class="card">
          <p>Processing failed: <span class="muted">${esc(d.error || "unknown error")}</span></p>
          <p class="small muted" style="margin-top:8px">Your dump is saved — find it in History.</p>
          <div class="row"><a class="btn ghost" href="#history">History</a>
          <a class="btn" href="#capture">New dump</a></div></div>`;
      }
    } catch {}
  }, 900);
}

let mediaRec = null, chunks = [], recTimer = null;

export async function toggleRecording(targetSel = "#dump-text") {
  const btn = $("#mic"), statusEl = $("#rec-status");
  if (mediaRec && mediaRec.state === "recording") {
    mediaRec.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => chunks.push(e.data);
    mediaRec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      btn.classList.remove("rec");
      statusEl.textContent = "Transcribing… (first run downloads the model)";
      const fd = new FormData();
      fd.append("file", new Blob(chunks, { type: mediaRec.mimeType }), "audio.webm");
      try {
        const { text } = await api.post("/transcribe", fd);
        const ta = $(targetSel);
        if (ta && text) {
          ta.value = (ta.value ? ta.value.trimEnd() + " " : "") + text;
          if (targetSel === "#dump-text") state.draft = ta.value;
        }
        statusEl.textContent = text ? "" : "Heard nothing — try again closer to the mic.";
      } catch (e) {
        statusEl.textContent = "Transcription failed: " + e.message;
      }
    };
    mediaRec.start();
    btn.classList.add("rec");
    const t0 = Date.now();
    recTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      statusEl.textContent = `Recording ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} — click to stop`;
    }, 500);
  } catch (e) {
    statusEl.textContent = "Mic unavailable: " + e.message;
  }
}
