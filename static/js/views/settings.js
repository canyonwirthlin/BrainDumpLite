// Settings: sectioned (Appearance, AI, Voice, Data, About) with a per-section
// "Advanced" switch — the standing progressive-disclosure rule for every settings screen.
import { $, $$, esc, toast, colorCss } from "../ui.js";
import { api } from "../api.js";
import { state, clearPoll, refreshStatus, loadTypes } from "../state.js";
import { native, showWhatsNew, checkForUpdates } from "../native.js";
import { setActive, importTheme, deleteTheme, exportUrl, setDensity, setMotion, BUILTIN_IDS } from "../theme.js";

const SECTIONS = [["appearance", "Appearance"], ["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["about", "About"]];
const advOn = (s) => { try { return localStorage.getItem("bdl-adv-" + s) === "1"; } catch { return false; } };
const setAdv = (s, v) => { try { localStorage.setItem("bdl-adv-" + s, v ? "1" : "0"); } catch {} };

export async function render(ctx) {
  const section = SECTIONS.some(([id]) => id === ctx.params[0]) ? ctx.params[0] : "appearance";
  ctx.setTitle("Settings");
  ctx.setLayout("full");
  $("#view").innerHTML = `<div class="split settings has-detail">
    <nav class="master subnav">${SECTIONS.map(([id, label]) => `<a href="#settings/${id}" class="${id === section ? "on" : ""}">${label}</a>`).join("")}</nav>
    <div class="detail body" id="sec"><div class="center">Loading…</div></div></div>`;
  let s;
  try { s = await api.get("/settings"); } catch (e) { $("#sec").innerHTML = `<div class="center">Couldn't load settings: ${esc(e.message)}</div>`; return; }
  const paint = { appearance: sectionAppearance, ai: sectionAI, voice: sectionVoice, data: sectionData, about: sectionAbout }[section];
  paint($("#sec"), s);
}

// Section header with the Advanced switch; hasAdv=false hides the switch.
function head(box, section, title, hasAdv, repaint) {
  const on = advOn(section);
  box.innerHTML = `<div class="h"><h2>${title}</h2><div class="grow"></div>
    ${hasAdv ? `<label class="sw">Advanced <input type="checkbox" id="adv" ${on ? "checked" : ""}><i></i></label>` : ""}</div><div id="body"></div>`;
  if (hasAdv) $("#adv", box).onchange = (e) => { setAdv(section, e.target.checked); repaint(); };
  return { on, body: $("#body", box) };
}

// ── Appearance ───────────────────────────────────────────────────────────────

function sectionAppearance(box, s) {
  const { on, body } = head(box, "appearance", "Appearance", true, () => sectionAppearance(box, s));
  const root = document.documentElement;
  body.innerHTML = `
    <p class="small muted" style="margin-bottom:12px">Pick a theme, or import a theme JSON file.</p>
    <div class="themes">${state.themes.map((t) => `
      <button class="theme-swatch ${t.id === state.activeTheme ? "active" : ""}" data-theme="${t.id}" title="${esc(t.name)}">
        <div class="sw-colors"><i style="background:${t.colors.bg}"></i><i style="background:${t.colors.panel}"></i><i style="background:${t.colors.accent}"></i></div>
        <span>${esc(t.name)}</span></button>`).join("")}
    </div>
    <div class="row" style="margin:12px 0 0">
      <label class="btn ghost small">Import theme… <input type="file" id="theme-file" accept=".json,application/json" hidden></label>
      <a class="btn ghost small" href="${exportUrl(state.activeTheme)}" download>Export current</a>
      ${BUILTIN_IDS.includes(state.activeTheme) ? "" : `<button class="btn danger small" id="theme-del">Delete current</button>`}
      <span class="small muted" id="theme-msg"></span>
    </div>
    ${on ? `<div class="adv">
      <div class="sec" style="margin-top:0">Advanced</div>
      <div class="field"><label>Density</label>
        <select id="f-density"><option value="comfortable" ${root.dataset.density !== "compact" ? "selected" : ""}>Comfortable</option><option value="compact" ${root.dataset.density === "compact" ? "selected" : ""}>Compact</option></select></div>
      <div class="field"><label>Motion</label>
        <select id="f-motion"><option value="auto" ${root.dataset.motion !== "reduce" ? "selected" : ""}>Follow system</option><option value="reduce" ${root.dataset.motion === "reduce" ? "selected" : ""}>Reduce animations</option></select></div>
    </div>` : ""}`;
  $$(".theme-swatch", body).forEach((b) => b.onclick = async () => { await setActive(b.dataset.theme); sectionAppearance(box, s); });
  $("#theme-file", body).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const t = await importTheme(f); await setActive(t.id); sectionAppearance(box, s); toast(`Imported "${t.name}"`); }
    catch (err) { $("#theme-msg", body).textContent = err.message; }
  };
  if ($("#theme-del", body)) $("#theme-del", body).onclick = async () => { await deleteTheme(state.activeTheme); await setActive("midnight"); sectionAppearance(box, s); };
  if ($("#f-density", body)) $("#f-density", body).onchange = (e) => setDensity(e.target.value);
  if ($("#f-motion", body)) $("#f-motion", body).onchange = (e) => setMotion(e.target.value);
}

// ── AI ───────────────────────────────────────────────────────────────────────

const PROVIDER_META = [
  { id: "builtin", name: "Built-in", desc: "Free · runs on this PC", help: "Runs a small AI model directly on this computer — GPU-accelerated, no account, no cost, and nothing you write ever leaves your machine. One-time model download (2–5 GB), then it works offline." },
  { id: "anthropic", name: "Claude", desc: "Anthropic API key", help: "Get a key at console.anthropic.com → API Keys. Costs cents/day at normal use." },
  { id: "openai", name: "OpenAI", desc: "OpenAI API key", help: "Get a key at platform.openai.com → API Keys. Also enables semantic search embeddings." },
  { id: "local", name: "Self-hosted", desc: "LM Studio / Ollama", help: "Point at any OpenAI-compatible server. Nothing ever leaves your machine." },
  { id: "off", name: "Off", desc: "No AI", help: "Dumps are stored raw. You can turn AI on any time — old dumps stay as they are." },
];

function sectionAI(box, s) {
  const { on, body } = head(box, "ai", "AI provider", true, () => sectionAI(box, s));
  const cur = s.provider;
  const meta = PROVIDER_META.find((p) => p.id === cur) || PROVIDER_META[4];
  const cloud = cur === "anthropic" || cur === "openai";
  const engineDir = (state.status.data_dir || "%LOCALAPPDATA%\\BrainDumpLite") + "\\engine";
  body.innerHTML = `
    <p class="small muted" style="margin-bottom:12px">Your dumps only ever go to the provider you choose.</p>
    <div class="providers">${PROVIDER_META.map((p) => `
      <button class="provider ${p.id === cur ? "active" : ""}" data-p="${p.id}"><b>${p.name}</b><span>${p.desc}</span></button>`).join("")}
    </div>
    <div class="card">
      <p class="small muted" style="margin-bottom:14px">${meta.help}</p>
      ${cur === "builtin" ? `<div id="engine-panel"><div class="center"><span class="spin"></span></div></div>` : ""}
      ${cloud ? `<div class="field"><label>API key</label>
        <input type="password" id="f-key" value="${esc(s.api_key)}" placeholder="${cur === "anthropic" ? "sk-ant-…" : "sk-…"}"></div>` : ""}
      ${cur === "local" && !on ? `<p class="small muted">Server URL and model live under <b>Advanced</b>.</p>` : ""}
      ${on && cur !== "off" ? `<div class="adv">
        <div class="sec" style="margin-top:0">Advanced</div>
        ${cur === "builtin" ? `
          <div class="field"><label>Engine folder</label><div class="ro">${esc(engineDir)}</div></div>
          <div class="field"><label>Ports</label><div class="ro">chat 8790 · embed 8820 · app ${esc(location.port || "80")}</div></div>
          <div class="field"><label>Context window</label><div class="ro">4096 tokens</div></div>` : `
          ${cur === "local" ? `<div class="field"><label>Server URL</label>
            <input type="text" id="f-url" value="${esc(s.base_url)}" placeholder="http://localhost:1234/v1"></div>` : ""}
          <div class="field"><label>Chat model</label>
            <div class="row" style="margin:0">
              <input type="text" id="f-model" class="grow" value="${esc(s.model)}" placeholder="${esc(s.defaults[cur]?.model || "model id")}">
              <button class="btn ghost small" id="f-list">List</button>
            </div></div>
          ${cur !== "anthropic" ? `<div class="field"><label>Embedding model <span class="muted">(optional — enables semantic search)</span></label>
            <input type="text" id="f-embed" value="${esc(s.embed_model)}" placeholder="${cur === "openai" ? "text-embedding-3-small" : "e.g. text-embedding-nomic-embed-text-v1.5"}"></div>` : ""}`}
      </div>` : ""}
      ${cur !== "builtin" ? `<div class="row">
        <button class="btn" id="save">Save</button>
        ${cur !== "off" ? `<button class="btn ghost" id="test">Test connection</button>` : ""}
      </div>
      <div id="test-out"></div>` : ""}
    </div>
    ${on ? `<div class="sec">Extraction types</div>
    <p class="small muted" style="margin-bottom:10px">What the AI looks for in every dump. Add your own, rename, recolor; built-ins can't be removed.</p>
    <div class="card" id="types-editor"></div>` : ""}`;
  if (on) paintTypesEditor($("#types-editor", body));
  $$(".provider", body).forEach((b) => b.onclick = async () => {
    clearPoll();
    s.provider = b.dataset.p;
    const d = s.defaults[s.provider] || {};
    s.base_url = d.base_url || ""; s.model = d.model || ""; s.embed_model = d.embed_model || "";
    try { Object.assign(s, await api.put("/settings", { provider: s.provider })); await refreshStatus(); }
    catch (e) { toast("Couldn't switch provider: " + e.message, true); }
    sectionAI(box, s);
  });
  const gather = () => ({
    provider: s.provider,
    api_key: $("#f-key", body)?.value ?? s.api_key,
    base_url: $("#f-url", body)?.value ?? s.base_url,
    model: $("#f-model", body)?.value ?? s.model,
    embed_model: $("#f-embed", body)?.value ?? s.embed_model,
  });
  if ($("#save", body)) $("#save", body).onclick = async () => {
    try { Object.assign(s, await api.put("/settings", gather())); await refreshStatus(); $("#test-out", body).innerHTML = `<div class="test-result ok">Saved.</div>`; }
    catch (e) { $("#test-out", body).innerHTML = `<div class="test-result bad">${esc(e.message)}</div>`; }
  };
  if ($("#test", body)) $("#test", body).onclick = async () => {
    $("#test-out", body).innerHTML = `<div class="test-result"><span class="spin"></span> Testing…</div>`;
    try {
      Object.assign(s, await api.put("/settings", gather()));
      await refreshStatus();
      const r = await api.post("/settings/test");
      $("#test-out", body).innerHTML = `<div class="test-result ${r.ok ? "ok" : "bad"}">${esc(r.message)}</div>`;
    } catch (e) { $("#test-out", body).innerHTML = `<div class="test-result bad">${esc(e.message)}</div>`; }
  };
  if ($("#f-list", body)) $("#f-list", body).onclick = async () => {
    await api.put("/settings", gather());
    try {
      const { models } = await api.get("/models");
      const pick = prompt("Available models:\n\n" + models.join("\n") + "\n\nCopy one into the model field.", $("#f-model", body).value);
      if (pick) $("#f-model", body).value = pick.trim();
    } catch (e) { toast("Could not list models: " + e.message, true); }
  };
  if (cur === "builtin") paintEnginePanel();
}

// ── Voice ────────────────────────────────────────────────────────────────────

function sectionVoice(box, s) {
  const { body } = head(box, "voice", "Voice", false, () => sectionVoice(box, s));
  body.innerHTML = `
    <div class="card">
      <div class="field"><label>Voice model (local Whisper — audio never leaves this machine)</label>
        <select id="f-whisper">${["tiny", "base", "small"].map((w) => `<option ${w === s.whisper_model ? "selected" : ""}>${w}</option>`).join("")}</select></div>
      <p class="small muted">tiny is fastest, small is most accurate. The model downloads once on first use.</p>
      <div class="row"><button class="btn" id="save">Save</button><span class="small muted" id="voice-msg"></span></div>
    </div>`;
  $("#save", body).onclick = async () => {
    try { Object.assign(s, await api.put("/settings", { whisper_model: $("#f-whisper", body).value })); $("#voice-msg", body).textContent = "Saved."; }
    catch (e) { toast(e.message, true); }
  };
}

// ── Data ─────────────────────────────────────────────────────────────────────

function sectionData(box, s) {
  const { body } = head(box, "data", "Data", false, () => sectionData(box, s));
  const path = state.status.data_dir || "";
  body.innerHTML = `
    <div class="card">
      <div class="field"><label>Your vault lives in</label><div class="ro">${esc(path)}</div></div>
      <div class="row" style="margin:0">
        <button class="btn ghost small" id="reveal">${native ? "Reveal in Explorer" : "Copy path"}</button>
      </div>
      <p class="small muted" style="margin-top:12px">Everything — dumps, settings, downloaded AI models — is inside that folder. Delete it to wipe the app.</p>
    </div>`;
  $("#reveal", body).onclick = async () => {
    if (native) { try { await native.opener.revealItemInDir(path); } catch (e) { toast("Couldn't open Explorer: " + (e.message || e), true); } }
    else { try { await navigator.clipboard.writeText(path); toast("Path copied"); } catch { toast(path); } }
  };
}

// ── About ────────────────────────────────────────────────────────────────────

function sectionAbout(box, s) {
  const { body } = head(box, "about", "About", false, () => sectionAbout(box, s));
  body.innerHTML = `
    <div class="card">
      <p class="small" style="margin-bottom:12px">BrainDump Lite <b>v${esc(state.status.version || "?")}</b> · ${native ? "native app" : "browser mode"}</p>
      <div class="row" style="margin:0">
        <button class="btn ghost" id="about-whatsnew">What's new</button>
        ${native ? `<button class="btn ghost" id="about-update">Check for updates</button>` : ""}
      </div>
    </div>`;
  $("#about-whatsnew", body).onclick = () => showWhatsNew(state.status.version);
  if ($("#about-update", body)) $("#about-update", body).onclick = () => checkForUpdates({ silent: false });
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


// ── Extraction types editor (Settings → AI → Advanced) ───────────────────────

const TYPE_COLORS = ["accent", "green", "amber", "red", "blue", "dim"];

async function paintTypesEditor(box) {
  if (!box) return;
  await loadTypes();
  const rows = state.types.map((t) => `
    <div class="type-row ${t.enabled ? "" : "off"}" data-id="${t.id}">
      <select class="t-color" title="Color">${TYPE_COLORS.map((c) => `<option value="${c}" ${t.color === c ? "selected" : ""}>${c}</option>`).join("")}${TYPE_COLORS.includes(t.color) ? "" : `<option value="${esc(t.color)}" selected>${esc(t.color)}</option>`}</select>
      <span class="kind" style="--kc:${colorCss(t.color)}">${t.icon ? t.icon + " " : ""}${esc(t.label)}</span>
      <input class="t-icon" value="${esc(t.icon)}" placeholder="icon" title="Emoji" maxlength="4">
      <input class="t-label" value="${esc(t.label)}" placeholder="Label" maxlength="30">
      <input class="t-hint grow" value="${esc(t.hint)}" placeholder="Rule shown to the model, e.g. 'a question the user wants answered'" maxlength="200">
      <label class="sw" title="${t.builtin ? "Built-in types are always on" : "Enabled"}"><input type="checkbox" class="t-on" ${t.enabled ? "checked" : ""} ${t.builtin ? "disabled" : ""}><i></i></label>
      ${t.builtin ? `<span class="small muted" style="width:52px;text-align:center">built-in</span>` : `<button class="iconbtn no t-del" title="Delete (its items become notes)">✕</button>`}
    </div>`).join("");
  box.innerHTML = `${rows}
    <div class="type-row add">
      <input class="t-new-label" placeholder="New type, e.g. Question" maxlength="30">
      <input class="t-new-hint grow" placeholder="How to recognise it (optional)" maxlength="200">
      <button class="btn small" id="t-add">Add type</button>
    </div>
    <div class="small muted" id="t-msg"></div>`;
  const msg = (m, bad) => { $("#t-msg", box).textContent = m; $("#t-msg", box).className = "small " + (bad ? "bad" : "muted"); };
  const save = async (row, fields) => {
    try { await api.put("/item-types/" + row.dataset.id, fields); await paintTypesEditor(box); }
    catch (e) { msg(e.message, true); }
  };
  $$(".type-row[data-id]", box).forEach((row) => {
    $(".t-color", row).onchange = (e) => save(row, { color: e.target.value });
    $(".t-on", row).onchange = (e) => save(row, { enabled: e.target.checked });
    for (const [cls, key] of [[".t-icon", "icon"], [".t-label", "label"], [".t-hint", "hint"]]) {
      const inp = $(cls, row);
      inp.onchange = () => save(row, { [key]: inp.value });
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    }
    const del = $(".t-del", row);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete this type? Existing items of this type become notes.`)) return;
      try { await api.del("/item-types/" + row.dataset.id); await paintTypesEditor(box); } catch (e) { msg(e.message, true); }
    };
  });
  $("#t-add", box).onclick = async () => {
    const label = $(".t-new-label", box).value.trim();
    if (!label) { msg("Give the type a name first.", true); return; }
    try { await api.post("/item-types", { label, hint: $(".t-new-hint", box).value.trim() }); await paintTypesEditor(box); toast(`Added "${label}" — the AI will look for it from the next dump on.`); }
    catch (e) { msg(e.message, true); }
  };
}
