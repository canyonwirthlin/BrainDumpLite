// Capture stage, processing progress and voice recording.
import { $, $$, esc, toast, MODES, STAGES } from "../ui.js";
import { go } from "../router.js";
import { attach as attachWikilinks } from "../wikilinks.js";
import { api } from "../api.js";
import { state, clearPoll } from "../state.js";
import { renderReview } from "./review.js";

export function render(ctx) {
  ctx.setTitle("Capture");
  $("#view").innerHTML = `
    <div class="glow"></div>
    <h1 class="hero">What's on your mind?</h1>
    <p class="sub">Dump it all — tasks, worries, ideas. The AI sorts it out.</p>
    ${state.status.ai ? "" : `<div class="banner">AI is off — dumps are saved raw without processing.
      <a href="#settings">Connect a key in Settings</a> to unlock the magic.</div>`}
    <div class="modes">${MODES.map((m) => `
      <button class="mode-chip ${m.id === state.curMode ? "active" : ""}" data-mode="${m.id}">
        ${m.icon} ${m.label}</button>`).join("")}
    </div>
    <textarea id="dump-text" class="editor" placeholder="Type, paste, or hit the mic and just talk…">${esc(state.draft)}</textarea>
    <div class="row">
      ${state.status.whisper ? `<button class="mic" id="mic" title="Record voice">🎙️</button>
        <span class="muted small" id="rec-status"></span>` : ""}
      <div class="grow"></div>
      <button class="btn ghost" id="talk-btn" title="Have a live conversation instead of a one-shot dump" ${["therapy", "brainstorm"].includes(state.curMode) ? "" : "hidden"}>Talk it through →</button>
      <button class="btn" id="dump-btn">Dump it →</button>
    </div>
    <div class="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to dump</div>`;
  $$(".mode-chip").forEach((b) => b.onclick = () => {
    state.curMode = b.dataset.mode;
    $$(".mode-chip").forEach((x) => x.classList.toggle("active", x === b));
    $("#talk-btn").hidden = !["therapy", "brainstorm"].includes(state.curMode);
  });
  $("#talk-btn").onclick = async () => {
    if (!state.status.ai) { toast("Turn on an AI provider in Settings to have a conversation.", true); return; }
    try {
      const s = await api.post("/sessions", { mode: state.curMode });
      const text = $("#dump-text").value.trim();
      if (text) sessionStorage.setItem("bdl-session-opener", text);
      go("session/" + s.id);
    } catch (e) { toast(e.message, true); }
  };
  $("#dump-text").oninput = (e) => { state.draft = e.target.value; };
  attachWikilinks($("#dump-text"));
  $("#dump-text").onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitDump(); }
  };
  $("#dump-btn").onclick = submitDump;
  if ($("#mic")) $("#mic").onclick = () => toggleRecording();
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

export function renderProcessing(id, container = $("#view"), onReady = null) {
  container.innerHTML = `
    <h1>Processing…</h1>
    <p class="sub">${state.status.ai ? "The pipeline is chewing on your dump." : "Saving (AI off — raw mode)."}</p>
    <div class="card"><div class="stages" id="stages"></div></div>`;
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
