// Settings (sections + Advanced arrive in Task 6).
import { $, $$, esc, toast } from "../ui.js";
import { api } from "../api.js";
import { state, clearPoll, refreshStatus } from "../state.js";
import { native, showWhatsNew, checkForUpdates } from "../native.js";
import { setActive, importTheme, deleteTheme, exportUrl, BUILTIN_IDS } from "../theme.js";

const PROVIDER_META = [
  { id: "builtin", name: "Built-in", desc: "Free · runs on this PC", help: "Runs a small AI model directly on this computer — GPU-accelerated, no account, no cost, and nothing you write ever leaves your machine. One-time model download (2–5 GB), then it works offline." },
  { id: "anthropic", name: "Claude", desc: "Anthropic API key", help: "Get a key at console.anthropic.com → API Keys. Costs cents/day at normal use." },
  { id: "openai", name: "OpenAI", desc: "OpenAI API key", help: "Get a key at platform.openai.com → API Keys. Also enables semantic search embeddings." },
  { id: "local", name: "Self-hosted", desc: "LM Studio / Ollama", help: "Point at any OpenAI-compatible server. Nothing ever leaves your machine." },
  { id: "off", name: "Off", desc: "No AI", help: "Dumps are stored raw. You can turn AI on any time — old dumps stay as they are." },
];

export async function render(ctx) {
  $("#view").innerHTML = `<div class="center">Loading…</div>`;
  const s = await api.get("/settings");
  const cur = () => s.provider;
  const paint = () => {
    const meta = PROVIDER_META.find((p) => p.id === cur());
    $("#view").innerHTML = `
      <h1>Settings</h1>
      <p class="sub">Make it yours — theme, AI provider, voice.</p>
      <h2>Appearance</h2>
      <div class="themes" style="margin-bottom:12px">${state.themes.map((t) => `
        <button class="theme-swatch ${t.id === state.activeTheme ? "active" : ""}" data-theme="${t.id}" title="${esc(t.name)}">
          <div class="sw"><i style="background:${t.colors.bg}"></i><i style="background:${t.colors.panel}"></i><i style="background:${t.colors.accent}"></i></div>
          <span>${esc(t.name)}</span></button>`).join("")}
      </div>
      <div class="row" style="margin:0 0 24px">
        <label class="btn ghost small">Import theme… <input type="file" id="theme-file" accept=".json,application/json" hidden></label>
        <a class="btn ghost small" href="${exportUrl(state.activeTheme)}" download>Export current</a>
        ${BUILTIN_IDS.includes(state.activeTheme) ? "" : `<button class="btn danger small" id="theme-del">Delete current</button>`}
        <span class="small muted" id="theme-msg"></span>
      </div>
      <h2>AI provider</h2>
      <p class="small muted" style="margin-bottom:12px">Your dumps only ever go to the provider you choose.</p>
      <div class="providers">${PROVIDER_META.map((p) => `
        <button class="provider ${p.id === cur() ? "active" : ""}" data-p="${p.id}">
          <b>${p.name}</b><span>${p.desc}</span></button>`).join("")}
      </div>
      <div class="card">
        <p class="small muted" style="margin-bottom:14px">${meta.help}</p>
        ${cur() === "builtin" ? `<div id="engine-panel"><div class="center"><span class="spin"></span></div></div>` : ""}
        ${cur() === "anthropic" || cur() === "openai" ? `
          <div class="field"><label>API key</label>
            <input type="password" id="f-key" value="${esc(s.api_key)}" placeholder="${cur() === "anthropic" ? "sk-ant-…" : "sk-…"}"></div>` : ""}
        ${cur() === "local" ? `
          <div class="field"><label>Server URL</label>
            <input type="text" id="f-url" value="${esc(s.base_url)}" placeholder="http://localhost:1234/v1"></div>` : ""}
        ${cur() !== "off" && cur() !== "builtin" ? `
          <div class="field"><label>Chat model</label>
            <div class="row" style="margin:0">
              <input type="text" id="f-model" class="grow" value="${esc(s.model)}" placeholder="${esc(s.defaults[cur()]?.model || "model id")}">
              <button class="btn ghost" id="f-list">List</button>
            </div></div>
          ${cur() !== "anthropic" ? `
          <div class="field"><label>Embedding model <span class="muted">(optional — enables semantic search)</span></label>
            <input type="text" id="f-embed" value="${esc(s.embed_model)}" placeholder="${cur() === "openai" ? "text-embedding-3-small" : "e.g. text-embedding-nomic-embed-text-v1.5"}"></div>` : ""}` : ""}
        <div class="field"><label>Voice model (local Whisper — audio never leaves this machine)</label>
          <select id="f-whisper">${["tiny", "base", "small"].map((w) =>
            `<option ${w === s.whisper_model ? "selected" : ""}>${w}</option>`).join("")}</select></div>
        <div class="row">
          <button class="btn" id="save">Save</button>
          <button class="btn ghost" id="test">Test connection</button>
          <div class="grow"></div>
        </div>
        <div id="test-out"></div>
      </div>
      <h2>About</h2>
      <div class="card">
        <p class="small" style="margin-bottom:12px">BrainDump Lite <b>v${esc(state.status.version || "?")}</b> · ${native ? "native app" : "browser mode"}</p>
        <div class="row" style="margin:0">
          <button class="btn ghost" id="about-whatsnew">What's new</button>
          ${native ? `<button class="btn ghost" id="about-update">Check for updates</button>` : ""}
        </div>
      </div>
      <p class="small muted">Data lives in <code>${esc(state.status.data_dir || "")}</code> — delete that folder to wipe everything.</p>`;
    $$(".theme-swatch").forEach((b) => b.onclick = async () => { await setActive(b.dataset.theme); paint(); });
    $("#theme-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const t = await importTheme(f); await setActive(t.id); paint(); toast(`Imported "${t.name}"`); }
      catch (err) { $("#theme-msg").textContent = err.message; }
    };
    if ($("#theme-del")) $("#theme-del").onclick = async () => { await deleteTheme(state.activeTheme); await setActive("midnight"); paint(); };
    $$(".provider").forEach((b) => b.onclick = async () => {
      clearPoll();  // engine-panel poll
      s.provider = b.dataset.p;
      const d = s.defaults[s.provider] || {};
      s.base_url = d.base_url || ""; s.model = d.model || ""; s.embed_model = d.embed_model || "";
      paint();
    });
    const gather = () => ({
      provider: s.provider,
      api_key: $("#f-key")?.value ?? s.api_key,
      base_url: $("#f-url")?.value ?? s.base_url,
      model: $("#f-model")?.value ?? s.model,
      embed_model: $("#f-embed")?.value ?? s.embed_model,
      whisper_model: $("#f-whisper").value,
    });
    $("#about-whatsnew").onclick = () => showWhatsNew(state.status.version);
    if ($("#about-update")) $("#about-update").onclick = () => checkForUpdates({ silent: false });
    $("#save").onclick = async () => {
      const saved = await api.put("/settings", gather());
      Object.assign(s, saved);
      await refreshStatus();
      $("#test-out").innerHTML = `<div class="test-result ok">Saved.</div>`;
    };
    $("#test").onclick = async () => {
      $("#test-out").innerHTML = `<div class="test-result"><span class="spin"></span> Testing…</div>`;
      await api.put("/settings", gather());
      await refreshStatus();
      const r = await api.post("/settings/test");
      $("#test-out").innerHTML = `<div class="test-result ${r.ok ? "ok" : "bad"}">${esc(r.message)}</div>`;
    };
    if ($("#f-list")) $("#f-list").onclick = async () => {
      await api.put("/settings", gather());
      try {
        const { models } = await api.get("/models");
        const pick = prompt("Available models:\n\n" + models.join("\n") + "\n\nCopy one into the model field.", $("#f-model").value);
        if (pick) $("#f-model").value = pick.trim();
      } catch (e) { toast("Could not list models: " + e.message, true); }
    };
    if (cur() === "builtin") paintEnginePanel();
  };
  paint();
}

// ── Built-in AI engine panel (inside Settings) ───────────────────────────────

const ENGINE_PHASES = {
  queued: "Starting setup…",
  engine: "Downloading AI engine",
  model: "Downloading model",
  embed: "Downloading semantic-search model",
  starting: "Loading model into memory…",
};
let enginePrevPhase = null;

async function paintEnginePanel() {
  const box = $("#engine-panel");
  if (!box) return;  // user navigated away — route() clears the poll timer
  let es;
  try { es = await api.get("/engine/status"); }
  catch (e) { box.innerHTML = `<div class="test-result bad">Engine status failed: ${esc(e.message)}</div>`; return; }

  const ph = es.setup.phase;
  const busy = !!ENGINE_PHASES[ph];
  const vramGb = es.gpu.vram_mb ? Math.round(es.gpu.vram_mb / 1024) : 0;
  const gpuLine = es.gpu.name
    ? `🎮 ${esc(es.gpu.name)} — about ${vramGb} GB VRAM. Models it can't fit run on the CPU instead (slower).`
    : `🎮 No GPU detected — models will run on the CPU. Slower, but it works.`;

  const rows = es.models.map((m) => {
    const gb = (m.size_mb / 1024).toFixed(1);
    let btn;
    if (m.active && es.server.running && !busy) btn = `<button class="btn ghost small" disabled>Running ✓</button>`;
    else if (m.downloaded) btn = `<button class="btn ghost small" data-em="${m.id}" ${busy ? "disabled" : ""}>${m.active ? "Start" : "Use this"}</button>`;
    else btn = `<button class="btn small" data-em="${m.id}" ${busy ? "disabled" : ""}>Get · ${gb} GB</button>`;
    return `
      <div class="engine-model ${m.active ? "active" : ""}">
        <div class="grow">
          <b>${esc(m.label)}</b>
          ${m.recommended ? `<span class="chip due">⭐ recommended for this PC</span>` : ""}
          ${m.downloaded ? `<span class="chip">downloaded</span>` : ""}
          <div class="small muted">${esc(m.blurb)} · needs ~${m.vram_gb} GB VRAM</div>
        </div>
        ${btn}
        ${m.downloaded && !m.active ? `<button class="iconbtn no" title="Delete downloaded file" data-del="${m.id}">🗑</button>` : ""}
      </div>`;
  }).join("");

  let foot = "";
  if (busy) {
    const pct = es.setup.pct;
    const mb = es.setup.total_mb ? ` — ${es.setup.done_mb} / ${es.setup.total_mb} MB` : "";
    foot = `<div class="engine-progress">
      <div class="small">${ENGINE_PHASES[ph]}${es.setup.message ? ": " + esc(es.setup.message) : ""}${mb}</div>
      <div class="progress ${pct == null ? "indet" : ""}"><i style="width:${pct == null ? 40 : pct}%"></i></div>
      <div class="small muted" style="margin-top:4px">You can keep using the app — this runs in the background.</div>
    </div>`;
  } else if (ph === "error") {
    foot = `<div class="test-result bad">Setup failed: ${esc(es.setup.message)}<br>Press a model button to retry — downloads resume where they left off.</div>`;
  }

  box.innerHTML = `
    <div class="small muted" style="margin-bottom:8px">${gpuLine}</div>
    ${rows}
    ${foot}
    <p class="small muted" style="margin:12px 0 0">One-time download per model; it's saved for next time. A tiny semantic-search model (~0.15 GB) is included automatically.</p>`;

  $$("[data-em]", box).forEach((b) => b.onclick = async () => {
    try { await api.post("/engine/setup", { model: b.dataset.em }); }
    catch (e) { toast(e.message, true); return; }
    paintEnginePanel();
  });
  $$("[data-del]", box).forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this downloaded model file?")) return;
    try { await api.del("/engine/models/" + b.dataset.del); }
    catch (e) { toast(e.message, true); }
    paintEnginePanel();
  });

  // Poll while setup runs; celebrate exactly once when it lands.
  const prev = enginePrevPhase;
  enginePrevPhase = ph;  // set BEFORE any await — overlapping paints must not re-toast
  if (busy) {
    if (!state.pollTimer) state.pollTimer = setInterval(paintEnginePanel, 1200);
  } else {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (ENGINE_PHASES[prev] && ph === "done") {
      toast("Built-in AI is ready 🎉");
      await refreshStatus();
    }
  }
}
