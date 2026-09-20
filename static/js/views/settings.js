// Settings: sectioned (Appearance, AI, Voice, Data, About) with a per-section
// "Advanced" switch — the standing progressive-disclosure rule for every settings screen.
import { $, $$, esc, toast, modal, colorCss } from "../ui.js";
import { api } from "../api.js";
import { state, clearPoll, refreshStatus, loadTypes } from "../state.js";
import { native, openExternal, showWhatsNew, checkForUpdates, isAutostartEnabled, setAutostart, saveAs, streakNotifyOn, setStreakNotify } from "../native.js";
import { setActive, importTheme, deleteTheme, exportUrl, setDensity, setMotion, BUILTIN_IDS } from "../theme.js";
import { openThemeEditor } from "../themeeditor.js";
import { resolveHex, isHex6 } from "../color.js";
import { lockNow } from "../shell.js";
import { runTool, MODE_LABEL } from "../tools.js";
import { replayTutorial } from "../onboarding.js";
import { modelOptions, geminiSetup, autoPickNote } from "../geminipicker.js";

const SECTIONS = [["appearance", "Appearance"], ["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["integrations", "Integrations"], ["extend", "Plugins & MCP"], ["about", "About"]];
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
  const paint = { appearance: sectionAppearance, ai: sectionAI, voice: sectionVoice, data: sectionData, integrations: sectionIntegrations, extend: sectionExtend, about: sectionAbout }[section];
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
  const repaint = () => sectionAppearance(box, s);
  body.innerHTML = `
    <p class="small muted" style="margin-bottom:12px">Pick a theme, edit one of your own, or import a theme JSON file.</p>
    <div class="themes">${state.themes.map((t) => `
      <div class="theme-swatch ${t.id === state.activeTheme ? "active" : ""}" data-theme="${t.id}" title="${esc(t.name)}">
        <button class="sw-pick" data-pick="${t.id}">
          <div class="sw-colors"><i style="background:${t.colors.bg}"></i><i style="background:${t.colors.panel}"></i><i style="background:${t.colors.accent}"></i></div>
          <span>${esc(t.name)}</span></button>
        <button class="sw-edit" data-edit="${t.id}" title="${BUILTIN_IDS.includes(t.id) ? "Edit a copy" : "Edit this theme"}">✎</button>
      </div>`).join("")}
    </div>
    <div class="row" style="margin:12px 0 0">
      <button class="btn ghost small" id="theme-new">+ New theme</button>
      <label class="btn ghost small">Import theme… <input type="file" id="theme-file" accept=".json,application/json" hidden></label>
      <a class="btn ghost small" href="${exportUrl(state.activeTheme)}" download>Export current</a>
      ${BUILTIN_IDS.includes(state.activeTheme) ? "" : `<button class="btn danger small" id="theme-del">Delete current</button>`}
      <span class="small muted" id="theme-msg"></span>
    </div>
    <div id="theme-editor-slot"></div>
    ${on ? `<div class="adv">
      <div class="sec" style="margin-top:0">Advanced</div>
      <div class="field"><label>Density</label>
        <select id="f-density"><option value="comfortable" ${root.dataset.density !== "compact" ? "selected" : ""}>Comfortable</option><option value="compact" ${root.dataset.density === "compact" ? "selected" : ""}>Compact</option></select></div>
      <div class="field"><label>Motion</label>
        <select id="f-motion"><option value="auto" ${root.dataset.motion !== "reduce" ? "selected" : ""}>Follow system</option><option value="reduce" ${root.dataset.motion === "reduce" ? "selected" : ""}>Reduce animations</option></select></div>
    </div>` : ""}`;
  $$("[data-pick]", body).forEach((b) => b.onclick = async () => { await setActive(b.dataset.pick); repaint(); });
  $$("[data-edit]", body).forEach((b) => b.onclick = () => {
    const t = state.themes.find((x) => x.id === b.dataset.edit);
    const editingId = BUILTIN_IDS.includes(t.id) ? null : t.id;
    $("#theme-editor-slot", body).scrollIntoView({ behavior: "smooth", block: "nearest" });
    openThemeEditor($("#theme-editor-slot", body), { base: t, editingId, onDone: () => repaint() });
  });
  $("#theme-new", body).onclick = () => {
    const base = state.themes.find((x) => x.id === state.activeTheme) || state.themes[0];
    openThemeEditor($("#theme-editor-slot", body), { base, editingId: null, onDone: () => repaint() });
  };
  $("#theme-file", body).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const t = await importTheme(f); await setActive(t.id); repaint(); toast(`Imported "${t.name}"`); }
    catch (err) { $("#theme-msg", body).textContent = err.message; }
  };
  if ($("#theme-del", body)) $("#theme-del", body).onclick = async () => { await deleteTheme(state.activeTheme); await setActive("midnight"); repaint(); };
  if ($("#f-density", body)) $("#f-density", body).onchange = (e) => setDensity(e.target.value);
  if ($("#f-motion", body)) $("#f-motion", body).onchange = (e) => setMotion(e.target.value);
}

// ── AI ───────────────────────────────────────────────────────────────────────

export const PROVIDER_META = [
  { id: "builtin", name: "Built-in", desc: "Free · runs on this PC", help: "Runs a small AI model directly on this computer — GPU-accelerated, no account, no cost, and nothing you write ever leaves your machine. One-time model download (2–5 GB), then it works offline." },
  { id: "anthropic", name: "Claude", desc: "Anthropic API key", help: "Get a key at console.anthropic.com → API Keys. Costs cents/day at normal use." },
  { id: "openai", name: "OpenAI", desc: "OpenAI API key", help: "Get a key at platform.openai.com → API Keys. Also enables semantic search embeddings." },
  { id: "gemini", name: "Gemini", desc: "Google · free tier", help: "Get a free key at aistudio.google.com → Get API key. Free quota; the app asks Google for its current models and picks the best free one for you." },
  { id: "local", name: "Self-hosted", desc: "LM Studio / Ollama", help: "Point at any OpenAI-compatible server. Nothing ever leaves your machine." },
  { id: "off", name: "Off", desc: "No AI", help: "Dumps are stored raw. You can turn AI on any time — old dumps stay as they are." },
];

function sectionAI(box, s) {
  const { on, body } = head(box, "ai", "AI provider", true, () => sectionAI(box, s));
  const cur = s.provider;
  const meta = PROVIDER_META.find((p) => p.id === cur) || PROVIDER_META[4];
  const cloud = cur === "anthropic" || cur === "openai" || cur === "gemini";
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
        <input type="password" id="f-key" value="${esc(s.api_key)}" placeholder="${cur === "anthropic" ? "sk-ant-…" : cur === "gemini" ? "AIza…" : "sk-…"}"></div>` : ""}
      ${cur === "gemini" ? `<div class="field"><label>Chat model</label>
          <div class="row" style="margin:0"><select id="f-model" class="grow"><option value="${esc(s.model)}">${esc(s.model)}</option></select>
            <button class="btn ghost small" id="g-best" title="Ask Google which free model answers best for your key">Pick best</button>
            <button class="btn ghost small" id="g-refresh">Refresh list</button></div></div>
        <div class="field"><label>Search model <span class="muted">(powers semantic search)</span></label>
          <select id="f-embed"><option value="${esc(s.embed_model)}">${esc(s.embed_model)}</option></select></div>
        <p class="small muted" id="g-msg">The list comes straight from Google, so it stays current.</p>` : ""}
      ${cur === "local" && !on ? `<p class="small muted">Server URL and model live under <b>Advanced</b>.</p>` : ""}
      ${on && cur !== "off" && cur !== "gemini" ? `<div class="adv">
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
  if (cur === "gemini") {
    const msg = $("#g-msg", body);
    const fill = async (probe) => {
      const k = $("#f-key", body).value.trim();
      if (!k) { msg.textContent = "Enter your API key first."; return; }
      msg.className = "small muted";
      msg.innerHTML = `<span class="spin"></span> ${probe ? "Checking which free models answer for your key…" : "Asking Google…"}`;
      try {
        const r = await geminiSetup(k, probe);
        const m = $("#f-model", body), e = $("#f-embed", body);
        const wantM = probe && r.model ? r.model : m.value, wantE = probe && r.embed_model ? r.embed_model : e.value;
        m.innerHTML = modelOptions(r.chat_models, wantM);
        e.innerHTML = modelOptions(r.embed_models, wantE);
        msg.className = "small " + (probe && !r.model ? "bad" : "muted");
        msg.textContent = probe ? autoPickNote(r) + " Press Save to keep it." : `${r.chat_models.length} chat and ${r.embed_models.length} search models available.`;
      } catch (err) { msg.className = "small bad"; msg.textContent = err.message; }
    };
    $("#g-refresh", body).onclick = () => fill(false);
    $("#g-best", body).onclick = () => fill(true);
    $("#f-key", body).onchange = () => fill(false);
    if (s.api_key) fill(false);
  }
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
  body.innerHTML = `<div class="center"><span class="spin"></span></div>`;
  paintData(body);
}

async function paintData(body) {
  let v = null;
  try { v = await api.get("/vault"); } catch (e) { body.innerHTML = `<div class="center">Couldn't read vault info: ${esc(e.message)}</div>`; return; }
  const mb = (v.size_bytes / 1048576).toFixed(1);
  const autostartOn = await isAutostartEnabled();
  body.innerHTML = `
    <div class="card">
      <h2>Vault</h2>
      <div class="field"><label>Your dumps, items and settings live in</label><div class="ro">${esc(v.db_path)}</div></div>
      <p class="small muted">${mb} MB · ${v.custom ? "custom location" : "default location"}. Downloaded AI models stay in <code>${esc(v.default_dir)}</code> and are not part of the vault.</p>
      <div class="row" style="margin:12px 0 0">
        <button class="btn ghost small" id="reveal">${native ? "Reveal in Explorer" : "Copy path"}</button>
        <button class="btn ghost small" id="vault-move">Move vault…</button>
        ${v.custom ? `<button class="btn ghost small" id="vault-reset">Use default location</button>` : ""}
      </div>
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p class="small muted" style="margin-bottom:12px">One zip file with everything. Keep it somewhere safe; restore it here on any PC.</p>
      <div class="row" style="margin:0">
        <a class="btn small" href="/api/backup" download>Download backup</a>
        <label class="btn ghost small">Restore from backup… <input type="file" id="restore-file" accept=".zip,application/zip" hidden></label>
        <span class="small muted" id="data-msg"></span>
      </div>
    </div>
    <div class="card">
      <h2>Markdown export &amp; import</h2>
      <p class="small muted" style="margin-bottom:12px">Every dump as an Obsidian-compatible <code>.md</code> file — frontmatter, items as a task list, concepts and people as <code>[[wikilinks]]</code>. Import a folder of notes the same way; each file becomes a dump and goes through the pipeline.</p>
      <div class="row" style="margin:0">
        <a class="btn small" id="md-export" href="/api/export/markdown.zip?wikilinks=1" download>Export all as markdown</a>
        <label class="sw" title="Render concepts/people as [[wikilinks]]"><input type="checkbox" id="md-wiki" checked><i></i> wikilinks</label>
        <label class="btn ghost small">Import markdown files… <input type="file" id="md-import" accept=".md,.txt,text/markdown,text/plain" multiple hidden></label>
        <span class="small muted" id="md-msg"></span>
      </div>
    </div>
    <div class="card">
      <h2>Vaults</h2>
      <p class="small muted" style="margin-bottom:10px">Keep separate vaults (Work, Personal…) and switch between them. A vault in a Dropbox/OneDrive/Drive folder syncs by itself.</p>
      <div id="vault-list"></div>
      <div class="row" style="margin:10px 0 0">
        <input type="text" id="pv-name" placeholder="Name" style="width:140px">
        <button class="btn ghost small" id="pv-create">Create new…</button>
        <button class="btn ghost small" id="pv-add">Add existing…</button>
        <span class="small muted" id="pv-msg"></span>
      </div>
    </div>
    <div class="card">
      <h2>Git mirror</h2>
      <p class="small muted" style="margin-bottom:10px">Point at a folder that is a git repository you own. "Sync now" writes every dump as markdown plus a backup zip into it, commits, and pushes — readable version history for free.</p>
      <div id="git-panel"><span class="spin"></span></div>
    </div>
    <div class="card">
      <h2>App lock</h2>
      <p class="small muted" style="margin-bottom:12px">${state.status.lock_set
        ? "A passphrase is set. The app locks at launch and after 10 minutes idle. There is no recovery if you forget it."
        : "Optional. Ask for a passphrase at launch and after 10 minutes idle — handy if Therapy conversations get personal. No recovery if you forget it."}</p>
      <div class="row" style="margin:0;gap:8px">
        ${state.status.lock_set ? `
          <input type="password" id="lk-cur" placeholder="Current passphrase" style="width:170px">
          <input type="password" id="lk-new" placeholder="New passphrase" style="width:170px">
          <button class="btn ghost small" id="lk-change">Change</button>
          <button class="btn danger small" id="lk-remove">Remove lock</button>
          <button class="btn ghost small" id="lk-now">Lock now</button>`
        : `<input type="password" id="lk-new" placeholder="Choose a passphrase (4+ chars)" style="width:240px">
          <button class="btn small" id="lk-set">Set passphrase</button>`}
        <span class="small muted" id="lk-msg"></span>
      </div>
    </div>
    ${native ? `<div class="card">
      <h2>Startup &amp; notifications</h2>
      <label class="sw" style="font-size:13.5px;color:var(--text);margin-bottom:10px"><input type="checkbox" id="startup-on" ${autostartOn ? "checked" : ""}><i></i> Open BrainDump Lite when my computer starts</label>
      <label class="sw" style="font-size:13.5px;color:var(--text)"><input type="checkbox" id="streak-notify-on" ${streakNotifyOn() ? "checked" : ""}><i></i> Remind me about today's dump / streak, every couple hours</label>
    </div>` : ""}`;
  const msg = (m, bad) => { const el = $("#data-msg", body); el.textContent = m; el.className = "small " + (bad ? "bad" : "muted"); };
  $("#reveal", body).onclick = async () => {
    if (native) { try { await native.opener.revealItemInDir(v.db_path); } catch (e) { toast("Couldn't open Explorer: " + (e.message || e), true); } }
    else { try { await navigator.clipboard.writeText(v.db_path); toast("Path copied"); } catch { toast(v.db_path); } }
  };
  $("#vault-move", body).onclick = async () => {
    let folder = null;
    if (native && native.dialog) {
      try { folder = await native.dialog.open({ directory: true, multiple: false, title: "Choose the new vault folder" }); }
      catch (e) { toast("Couldn't open the folder picker: " + (e.message || e), true); return; }
    } else {
      folder = prompt("Folder to move the vault into (it will be created if needed):", v.dir);
    }
    if (!folder) return;
    try {
      const info = await api.post("/vault/move", { path: folder });
      toast("Vault moved to " + info.dir);
      await refreshStatus();
      paintData(body);
    } catch (e) { toast(e.message, true); }
  };
  if ($("#vault-reset", body)) $("#vault-reset", body).onclick = async () => {
    if (!confirm("Switch back to the default vault location? The copy in the custom folder stays where it is.")) return;
    try { await api.post("/vault/reset"); await refreshStatus(); paintData(body); } catch (e) { toast(e.message, true); }
  };
  // markdown export / import
  $("#md-wiki", body).onchange = (e) => { $("#md-export", body).href = "/api/export/markdown.zip?wikilinks=" + (e.target.checked ? 1 : 0); };
  $("#md-export", body).onclick = async (e) => {  // native: pick where the zip goes; browser: normal download
    e.preventDefault();
    try {
      const path = await saveAs({ defaultName: "braindump-markdown.zip", ext: "zip", label: "Markdown export (zip)", endpoint: "/export/markdown/save",
        body: { wikilinks: $("#md-wiki", body).checked }, downloadUrl: e.currentTarget.href });
      if (path) toast("Saved to " + path);
    } catch (err) { toast("Couldn't save: " + (err.message || err), true); }
  };
  $("#md-import", body).onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    const fd = new FormData(); files.forEach((f) => fd.append("files", f));
    const m = (t, bad) => { const el = $("#md-msg", body); el.textContent = t; el.className = "small " + (bad ? "bad" : "muted"); };
    m(`Importing ${files.length} file${files.length === 1 ? "" : "s"}…`);
    try {
      const r = await api.post("/import/markdown", fd);
      m(`Imported ${r.imported}, skipped ${r.skipped}. Processing in the background — watch History.`);
    } catch (err) { m(err.message, true); }
    e.target.value = "";
  };
  paintVaults(body);
  paintGit(body);
  const lkmsg = (m, bad) => { const el = $("#lk-msg", body); el.textContent = m; el.className = "small " + (bad ? "bad" : "muted"); };
  if ($("#lk-set", body)) $("#lk-set", body).onclick = async () => {
    try { await api.post("/lock/set", { passphrase: $("#lk-new", body).value }); await refreshStatus(); paintData(body); toast("App lock set"); }
    catch (e) { lkmsg(e.message, true); }
  };
  if ($("#lk-change", body)) $("#lk-change", body).onclick = async () => {
    try { await api.post("/lock/set", { passphrase: $("#lk-new", body).value, current: $("#lk-cur", body).value }); lkmsg("Passphrase changed."); $("#lk-cur", body).value = $("#lk-new", body).value = ""; }
    catch (e) { lkmsg(e.message, true); }
  };
  if ($("#lk-remove", body)) $("#lk-remove", body).onclick = async () => {
    try { await api.post("/lock/clear", { passphrase: $("#lk-cur", body).value }); await refreshStatus(); paintData(body); toast("App lock removed"); }
    catch (e) { lkmsg(e.message, true); }
  };
  if ($("#lk-now", body)) $("#lk-now", body).onclick = () => lockNow();
  if ($("#startup-on", body)) $("#startup-on", body).onchange = (e) => setAutostart(e.target.checked);
  if ($("#streak-notify-on", body)) $("#streak-notify-on", body).onchange = async (e) => {
    setStreakNotify(e.target.checked);
    if (e.target.checked && native?.notification) {
      try { if (!(await native.notification.isPermissionGranted())) await native.notification.requestPermission(); } catch {}
    }
  };
  $("#restore-file", body).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!confirm(`Replace the current vault with "${f.name}"? Everything you have now is kept as a .bak file next to the vault.`)) { e.target.value = ""; return; }
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await api.post("/restore", fd);
      msg(`Restored — ${r.dumps} dump${r.dumps === 1 ? "" : "s"}. Reloading…`);
      setTimeout(() => location.reload(), 900);
    } catch (err) { msg(err.message, true); }
    e.target.value = "";
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
        <button class="btn ghost" id="about-tutorial">Replay tutorial</button>
        ${native ? `<button class="btn ghost" id="about-update">Check for updates</button>` : ""}
      </div>
    </div>`;
  $("#about-whatsnew", body).onclick = () => showWhatsNew(state.status.version);
  $("#about-tutorial", body).onclick = () => replayTutorial();
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
const browseState = { q: "", vram: 0 };

export async function paintEnginePanel() {
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

  const q = (browseState.q || "").toLowerCase();
  // Same headroom rule the backend uses for its recommendation (Windows itself holds some VRAM).
  const fitsGpu = (m) => es.gpu.vram_mb >= m.vram_gb * 1024 - 600;
  const shown = es.models.filter((m) => (!browseState.vram || m.vram_gb <= browseState.vram) &&
    (!q || [m.label, m.blurb, m.family, m.license].some((s) => (s || "").toLowerCase().includes(q)) || (m.tags || []).some((t) => t.includes(q))))
    .sort((a, b) => a.vram_gb - b.vram_gb);  // stable: catalog order breaks ties within a tier
  const rows = shown.map((m) => {
    const gb = (m.size_mb / 1024).toFixed(1);
    const specs = [
      m.params && `${m.params}${m.arch === "moe" ? " · mixture-of-experts" : ""}`,
      m.quant, `${gb} GB download`, `needs ~${m.vram_gb} GB VRAM`,
      m.ram_gb && `${m.ram_gb} GB RAM if run on the CPU`,
      m.context_k && `${m.context_k}K native context`, m.license,
    ].filter(Boolean).map(esc).join(" · ");
    const spill = es.gpu.vram_mb && !fitsGpu(m)
      ? `<div class="small model-warn">Bigger than your GPU's memory — it will split between GPU and RAM and run slower.</div>` : "";
    const caveats = (m.caveats || []).length
      ? `<ul class="small muted model-caveats">${m.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
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
          ${(m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
          <div class="small muted">${esc(m.blurb)}</div>
          <div class="small muted model-specs">${specs}</div>
          ${spill}${caveats}
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
    <div class="row browse" style="margin:0 0 8px">
      <input type="text" id="mb-q" class="grow" placeholder="Search models…" value="${esc(browseState.q || "")}" style="padding:6px 10px;font-size:12.5px">
      ${[0, 4, 6, 8, 12, 16, 24].map((v) => `<button class="chip ${browseState.vram === v ? "on" : ""}" data-vram="${v}">${v ? "≤ " + v + " GB" : "Any VRAM"}</button>`).join("")}
      <button class="btn ghost small" id="mb-refresh" title="Fetch the latest curated list">↻ Check for new models</button>
    </div>
    ${rows || `<div class="small muted" style="padding:8px 0">No models match.</div>`}
    ${foot}
    <p class="small muted" style="margin:12px 0 0">One-time download per model; it's saved for next time. A tiny semantic-search model (~0.15 GB) is included automatically.</p>
    <p class="small muted" style="margin:6px 0 0">VRAM and RAM figures are estimates for full GPU offload or a CPU-only run. Every model runs with an 8K context here, whatever its native window. Only models that answer directly are listed; ones that think out loud first would burn the response budget.</p>`;

  const qEl = $("#mb-q", box);
  qEl.oninput = () => { browseState.q = qEl.value; const pos = qEl.selectionStart; paintEnginePanel(); setTimeout(() => { const el = $("#mb-q"); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }, 0); };
  $$("[data-vram]", box).forEach((b) => b.onclick = () => { browseState.vram = +b.dataset.vram; paintEnginePanel(); });
  $("#mb-refresh", box).onclick = async () => {
    try { const c = await api.get("/catalog?refresh=1"); toast(`Catalog v${c.version} — ${c.chat_models.length} models`); paintEnginePanel(); }
    catch (e) { toast("Couldn't refresh the catalog: " + e.message, true); }
  };
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

async function paintTypesEditor(box) {
  if (!box) return;
  await loadTypes();
  const hex = (c) => resolveHex(c, "#8b93a8");
  const rows = state.types.map((t) => `
    <div class="type-row ${t.enabled ? "" : "off"}" data-id="${t.id}">
      <span class="te-color" style="gap:4px"><input type="color" class="t-color" title="Color" value="${hex(t.color)}"><input type="text" class="t-hex" value="${hex(t.color)}" maxlength="7" spellcheck="false"></span>
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
    const colorEl = $(".t-color", row), hexEl = $(".t-hex", row);
    colorEl.oninput = () => { hexEl.value = colorEl.value; };
    colorEl.onchange = () => save(row, { color: colorEl.value });
    hexEl.onchange = () => {
      const v = hexEl.value.trim().startsWith("#") ? hexEl.value.trim() : "#" + hexEl.value.trim();
      if (!/^#[0-9a-f]{6}$/i.test(v)) { msg("Color must be #rrggbb.", true); return; }
      colorEl.value = v;
      save(row, { color: v });
    };
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


// ── Vault profiles (Phase 6) ─────────────────────────────────────────────────

async function pickFolder(promptText, fallback) {
  if (native && native.dialog) {
    try { return await native.dialog.open({ directory: true, multiple: false, title: promptText }); }
    catch (e) { toast("Couldn't open the folder picker: " + (e.message || e), true); return null; }
  }
  return prompt(promptText, fallback || "");
}

async function paintVaults(body) {
  const box = $("#vault-list", body); if (!box) return;
  let list;
  try { list = await api.get("/profiles"); } catch (e) { box.innerHTML = `<span class="small bad">${esc(e.message)}</span>`; return; }
  box.innerHTML = list.map((p) => `<div class="type-row">
      <b style="width:140px">${esc(p.name)}${p.active ? ` <span class="tag">active</span>` : ""}</b>
      <span class="small muted grow" style="font-family:var(--mono)">${esc(p.dir)}${p.exists === false ? " (no vault yet)" : ""}</span>
      ${p.active ? "" : `<button class="btn ghost small" data-switch="${esc(p.name)}">Switch</button>`}
      ${p.default || p.active ? "" : `<button class="iconbtn no" title="Forget (files stay)" data-forget="${esc(p.name)}">✕</button>`}
    </div>`).join("");
  const msg = (m, bad) => { const el = $("#pv-msg", body); el.textContent = m; el.className = "small " + (bad ? "bad" : "muted"); };
  $$("[data-switch]", box).forEach((b) => b.onclick = async () => {
    if (!confirm(`Switch to the "${b.dataset.switch}" vault? The app reloads.`)) return;
    try { await api.post("/profiles/switch", { name: b.dataset.switch }); location.reload(); } catch (e) { msg(e.message, true); }
  });
  $$("[data-forget]", box).forEach((b) => b.onclick = async () => {
    try { await api.post("/profiles/remove", { name: b.dataset.forget }); paintVaults(body); } catch (e) { msg(e.message, true); }
  });
  const nameOf = () => $("#pv-name", body).value.trim();
  $("#pv-create", body).onclick = async () => {
    const name = nameOf(); if (!name) { msg("Give the vault a name first.", true); return; }
    const dir = await pickFolder("Choose an empty folder for the new vault"); if (!dir) return;
    try { await api.post("/profiles/create", { name, dir }); $("#pv-name", body).value = ""; msg(`Created "${name}". Switch to it when you're ready.`); paintVaults(body); }
    catch (e) { msg(e.message, true); }
  };
  $("#pv-add", body).onclick = async () => {
    const name = nameOf(); if (!name) { msg("Give the vault a name first.", true); return; }
    const dir = await pickFolder("Choose a folder that already contains braindump.db"); if (!dir) return;
    try { await api.post("/profiles/add", { name, dir }); $("#pv-name", body).value = ""; msg(`Added "${name}".`); paintVaults(body); }
    catch (e) { msg(e.message, true); }
  };
}

// ── Git mirror (Phase 6) ─────────────────────────────────────────────────────

async function paintGit(body) {
  const box = $("#git-panel", body); if (!box) return;
  let g;
  try { g = await api.get("/gitsync"); } catch (e) { box.innerHTML = `<span class="small bad">${esc(e.message)}</span>`; return; }
  if (!g.git_available) { box.innerHTML = `<p class="small muted">git isn't installed (or not on PATH). Install it from git-scm.com to use the mirror.</p>`; return; }
  box.innerHTML = `
    <div class="row" style="margin:0">
      <span class="small muted grow" style="font-family:var(--mono)">${g.configured ? esc(g.dir) : "No repository chosen"}</span>
      <button class="btn ghost small" id="git-pick">${g.configured ? "Change folder…" : "Choose repository…"}</button>
      ${g.configured ? `<button class="btn small" id="git-sync">Sync now</button><button class="btn ghost small" id="git-off">Disconnect</button>` : ""}
    </div>
    ${g.last_sync ? `<div class="small muted" style="margin-top:8px">Last sync ${esc(new Date(g.last_sync).toLocaleString())}</div>` : ""}
    <pre class="git-log" id="git-log" ${g.last_log ? "" : "hidden"}>${esc(g.last_log || "")}</pre>`;
  const showLog = (t) => { const el = $("#git-log", body); el.hidden = false; el.textContent = t; };
  $("#git-pick", body).onclick = async () => {
    const dir = await pickFolder("Choose a folder that is a git repository", g.dir); if (!dir) return;
    try { await api.post("/gitsync/configure", { dir }); paintGit(body); } catch (e) { toast(e.message, true); }
  };
  if ($("#git-sync", body)) $("#git-sync", body).onclick = async () => {
    $("#git-sync", body).disabled = true; showLog("Syncing…");
    try { const r = await api.post("/gitsync/now", {}); showLog(r.log); toast(r.pushed === false ? "Committed, but push failed — see the log" : "Synced"); }
    catch (e) { showLog(e.message); }
    finally { $("#git-sync", body).disabled = false; }
  };
  if ($("#git-off", body)) $("#git-off", body).onclick = async () => { await api.post("/gitsync/configure", { dir: null }); paintGit(body); };
}


// ── Integrations (Phase 8) ───────────────────────────────────────────────────
async function sectionIntegrations(box, s) {
  const { on, body } = head(box, "integrations", "Integrations", true, () => sectionIntegrations(box, s));
  body.innerHTML = `<div class="center">Loading…</div>`;
  let i;
  try { i = await api.get("/integrations"); } catch (e) { body.innerHTML = `<div class="center">${esc(e.message)}</div>`; return; }
  const g = i.google, t = i.todoist;
  body.innerHTML = `
    <p class="small muted" style="margin-bottom:14px">Connected services only ever receive what you approve in the <a href="#inbox">Inbox</a> or send yourself.
      Tokens are stored ${i.secrets === "dpapi" ? "encrypted with Windows DPAPI (tied to your Windows account)" : "<b>unencrypted</b> on this platform"}.</p>
    <div class="card">
      <div class="row" style="margin:0">
        <div class="grow"><b>📅 Google Calendar</b>
          <div class="small muted">${g.connected ? `Connected${g.account ? " as " + esc(g.account) : ""}. New dated tasks and events show up in the Inbox; “Plan my day” uses your free time.` : "One-click sign-in. Push-only, plus reading your day for the planner."}</div></div>
        ${g.connected ? `<button class="btn ghost" id="g-off">Disconnect</button>`
          : `<button class="btn" id="g-on" ${g.client_id ? "" : `disabled title="Add a Google OAuth client id under Advanced first"`}>Sign in with Google</button>`}
      </div>
      ${on ? `<div class="sec">OAuth client (Advanced)</div>
        <p class="small muted">Create a <b>Desktop app</b> OAuth client in Google Cloud Console (Calendar API enabled), then paste it here. The secret is optional for desktop clients with PKCE.</p>
        <div class="row" style="margin-top:8px">
          <input type="text" id="g-cid" class="grow" placeholder="Client id (…apps.googleusercontent.com)" value="${esc(g.client_id || "")}">
          <input type="password" id="g-sec" placeholder="${g.has_secret ? "Client secret (saved)" : "Client secret (optional)"}">
          <button class="btn ghost small" id="g-save">Save</button>
        </div>` : ""}
    </div>
    <div class="card">
      <div class="row" style="margin:0">
        <div class="grow"><b>✅ Todoist</b>
          <div class="small muted">${t.connected ? "Connected. New tasks are proposed in the Inbox; “Send to…” pushes any task." : "Paste a personal API token from Todoist → Settings → Integrations → Developer."}</div></div>
        ${t.connected ? `<button class="btn ghost" id="td-off">Disconnect</button>` : ""}
      </div>
      ${t.connected ? "" : `<div class="row" style="margin-top:8px">
        <input type="password" id="td-tok" class="grow" placeholder="Todoist API token">
        <button class="btn small" id="td-save">Connect</button></div>`}
    </div>`;
  const again = () => sectionIntegrations(box, s);
  $("#g-on", body)?.addEventListener("click", async () => {
    try {
      const r = await api.post("/integrations/google/connect");
      openExternal(r.url);
      toast("Finish signing in in your browser, then come back here.");
      const poll = setInterval(async () => { const j = await api.get("/integrations"); if (j.google.connected) { clearInterval(poll); toast("Google Calendar connected"); again(); } }, 2000);
      setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
    } catch (e) { toast(e.message, true); }
  });
  $("#g-off", body)?.addEventListener("click", async () => { await api.post("/integrations/google/disconnect"); toast("Disconnected"); again(); });
  $("#g-save", body)?.addEventListener("click", async () => {
    await api.put("/integrations/google/client", { client_id: $("#g-cid", body).value, client_secret: $("#g-sec", body).value });
    toast("Saved"); again();
  });
  $("#td-save", body)?.addEventListener("click", async () => {
    const b = $("#td-save", body); b.disabled = true;
    try { await api.put("/integrations/todoist", { token: $("#td-tok", body).value }); toast("Todoist connected"); again(); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  });
  $("#td-off", body)?.addEventListener("click", async () => { await api.put("/integrations/todoist", { token: "" }); toast("Disconnected"); again(); });
}

// ── Plugins & MCP (Phase 9) ──────────────────────────────────────────────────
async function sectionExtend(box, s) {
  const { on, body } = head(box, "extend", "Plugins & MCP", true, () => sectionExtend(box, s));
  body.innerHTML = `<div class="center">Loading…</div>`;
  let servers = [], plugins = [], examples = [], folder = "";
  try {
    [servers, plugins, examples, folder] = await Promise.all([
      api.get("/mcp/servers"), api.get("/plugins"), api.get("/plugins/examples").catch(() => []),
      api.get("/plugins/folder").then((r) => r.path).catch(() => ""),
    ]);
  } catch (e) { body.innerHTML = `<div class="center">${esc(e.message)}</div>`; return; }
  const again = () => sectionExtend(box, s);
  const installed = new Set(plugins.map((p) => p.id));

  body.innerHTML = `
    <div class="sec" style="margin-top:0">MCP servers</div>
    <p class="small muted">Connect a Model Context Protocol server and its tools show up here. Paste the same
      <code>mcpServers</code> block you would give any other desktop client. Servers run as programs on this
      machine with your permissions.</p>
    ${servers.length ? `<div class="card">${servers.map(serverRow).join("")}</div>` : ""}
    <div class="card">
      <div class="sec" style="margin-top:0">Add a server</div>
      <textarea id="mcp-cfg" class="editor" rows="5" spellcheck="false" placeholder='{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Notes"] } } }'></textarea>
      <div class="row"><div class="grow"></div><button class="btn small" id="mcp-add">Add</button></div>
    </div>
    ${on ? `<div class="card">
      <div class="sec" style="margin-top:0">Tools in chat</div>
      <div class="row" style="margin:0">
        <div class="grow small muted">After each reply in a conversation, let the AI propose one tool call.
          You confirm every call unless its tool is set to “AI may run”. Off by default — small local models propose poorly.</div>
        <label class="sw"><input type="checkbox" id="tools-chat" ${s.tools_in_chat ? "checked" : ""}><i></i></label>
      </div></div>` : ""}

    <div class="sec">Plugins</div>
    <p class="small muted">Plugins are folders of Python that run <b>inside the app with your permissions</b>, like a
      code-editor extension. Only enable code you trust. <a href="#" id="plug-docs">How to write one</a>.</p>
    ${plugins.length ? `<div class="card">${plugins.map(pluginRow).join("")}</div>`
      : `<div class="card small muted">No plugins installed yet.</div>`}
    ${examples.filter((e) => !installed.has(e.id)).length ? `<div class="card">
      <div class="sec" style="margin-top:0">Included examples</div>
      ${examples.filter((e) => !installed.has(e.id)).map((e) => `<div class="row" style="margin:6px 0">
        <div class="grow"><b>${esc(e.name)}</b> <span class="small muted">${esc(e.description)}</span></div>
        <button class="btn ghost small" data-example="${esc(e.path)}">Install</button></div>`).join("")}</div>` : ""}
    <div class="row">
      <input type="text" id="plug-path" class="grow" placeholder="Path to a plugin folder or .zip">
      <button class="btn ghost small" id="plug-install">Install</button>
      <button class="btn ghost small" id="plug-reload">Reload all</button>
    </div>
    ${folder ? `<p class="small muted" style="margin-top:8px">Plugins folder: <code>${esc(folder)}</code></p>` : ""}`;

  $("#mcp-add", body).onclick = async () => {
    const t = $("#mcp-cfg", body).value.trim();
    if (!t) return;
    try { const r = await api.post("/mcp/servers", { config: t }); toast(`Added ${r.added.join(", ")}`); again(); }
    catch (e) { toast(e.message, true); }
  };
  if ($("#tools-chat", body)) $("#tools-chat", body).onchange = async (e) => {
    await api.put("/settings", { tools_in_chat: e.target.checked });
    toast(e.target.checked ? "The AI may propose tool calls in conversations" : "Tools in chat off");
  };
  $("#plug-docs", body).onclick = (e) => { e.preventDefault(); openExternal("https://github.com/canyonwirthlin/BrainDumpLite/blob/master/docs/plugins.md"); };
  $$("[data-example]", body).forEach((b) => b.onclick = () => installPlugin(b.dataset.example, again));
  $("#plug-install", body).onclick = () => installPlugin($("#plug-path", body).value.trim(), again);
  $("#plug-reload", body).onclick = async () => { await api.post("/plugins/reload"); toast("Plugins reloaded"); again(); };

  $$("[data-srv]", body).forEach((el) => {
    const name = el.dataset.srv;
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); again(); } catch (e) { toast(e.message, true); } };
    $(".srv-start", el)?.addEventListener("click", () => act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/start`), "Started"));
    $(".srv-stop", el)?.addEventListener("click", () => act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/stop`), "Stopped"));
    $(".srv-enable", el)?.addEventListener("change", (e) => act(() => api.put(`/mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled: e.target.checked })));
    $(".srv-remove", el)?.addEventListener("click", () => {
      if (confirm(`Remove '${name}'? Its tools disappear from the app; the program itself is untouched.`)) act(() => api.del("/mcp/servers/" + encodeURIComponent(name)), "Removed");
    });
    $$("[data-tool]", el).forEach((row) => {
      const tool = servers.find((x) => x.name === name).tools.find((t) => t.name === row.dataset.tool);
      $(".t-run", row).onclick = () => runTool({ ...tool, server: name });
      $(".t-mode", row).onchange = async (e) => {
        try { await api.put(`/mcp/tools/${encodeURIComponent(name)}/${encodeURIComponent(tool.name)}/mode`, { mode: e.target.value }); }
        catch (err) { toast(err.message, true); }
      };
    });
  });

  $$("[data-plug]", body).forEach((el) => {
    const pid = el.dataset.plug;
    $(".p-enable", el).onchange = async (e) => {
      if (e.target.checked && !confirm(`Enable '${pid}'?\n\nIt runs inside BrainDump Lite with your permissions and is not sandboxed.`)) { e.target.checked = false; return; }
      try { await api.put(`/plugins/${encodeURIComponent(pid)}/enabled`, { enabled: e.target.checked }); again(); }
      catch (err) { toast(err.message, true); }
    };
    $(".p-remove", el).onclick = async () => {
      if (!confirm(`Delete the '${pid}' folder from your plugins directory?`)) return;
      await api.del("/plugins/" + encodeURIComponent(pid)); toast("Removed"); again();
    };
    $$("[data-act]", el).forEach((b) => b.onclick = async () => {
      try { const r = await api.post(`/plugins/${encodeURIComponent(pid)}/actions/${encodeURIComponent(b.dataset.act)}`, { args: {} });
        modal(`<h2>${esc(b.textContent)}</h2><pre class="toolout">${esc(JSON.stringify(r, null, 2))}</pre>`);
      } catch (e) { toast(e.message, true); }
    });
  });
}

async function installPlugin(path, again) {
  if (!path) return toast("Give a folder or .zip path first", true);
  try { const r = await api.post("/plugins/install", { path }); toast(`Installed ${r.name} — enable it to run it`); again(); }
  catch (e) { toast(e.message, true); }
}

function serverRow(s) {
  const dot = s.error ? "bad" : s.running ? "on" : "";
  return `<div class="srv" data-srv="${esc(s.name)}">
    <div class="row" style="margin:0">
      <span class="dot ${dot}" title="${s.error ? "error" : s.running ? "running" : "stopped"}"></span>
      <div class="grow"><b>${esc(s.name)}</b>
        <div class="small muted mono">${esc(s.command)} ${esc((s.args || []).join(" ")).slice(0, 90)}</div>
        ${s.error ? `<div class="small bad">${esc(s.error).slice(0, 200)}</div>` : ""}
        ${s.env_keys.length ? `<div class="small muted">env: ${s.env_keys.map(esc).join(", ")}</div>` : ""}</div>
      <label class="sw" title="Enabled"><input type="checkbox" class="srv-enable" ${s.enabled ? "checked" : ""}><i></i></label>
      ${s.running ? `<button class="btn ghost small srv-stop">Stop</button>` : `<button class="btn ghost small srv-start">Start</button>`}
      <button class="iconbtn srv-remove" title="Remove">✕</button>
    </div>
    ${s.tools.length ? `<div class="tools">${s.tools.map((t) => `
      <div class="trow" data-tool="${esc(t.name)}">
        <span class="grow"><b class="mono">${esc(t.name)}</b> <span class="small muted">${esc(t.description).slice(0, 110)}</span></span>
        <select class="t-mode">${Object.entries(MODE_LABEL).map(([v, l]) => `<option value="${v}" ${t.mode === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <button class="btn ghost small t-run">Run</button>
      </div>`).join("")}</div>`
      : `<div class="small muted" style="margin-top:6px">${s.running ? "This server offers no tools." : "Start it to see its tools."}</div>`}
  </div>`;
}

function pluginRow(p) {
  return `<div class="srv" data-plug="${esc(p.id)}">
    <div class="row" style="margin:0">
      <span class="dot ${p.error ? "bad" : p.loaded ? "on" : ""}"></span>
      <div class="grow"><b>${esc(p.name)}</b> <span class="small muted mono">v${esc(p.version)}</span>
        <div class="small muted">${esc(p.description || "")}</div>
        ${p.permissions.length ? `<div class="small muted">wants: ${p.permissions.map((x) => `<span class="chip">${esc(x)}</span>`).join(" ")}</div>` : ""}
        ${p.error ? `<pre class="toolout bad">${esc(p.error).slice(0, 400)}</pre>` : ""}</div>
      <label class="sw"><input type="checkbox" class="p-enable" ${p.enabled ? "checked" : ""}><i></i></label>
      <button class="iconbtn p-remove" title="Delete">✕</button>
    </div>
    ${p.actions.length ? `<div class="row" style="margin:8px 0 0">${p.actions.map((a) =>
      `<button class="btn ghost small" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>` : ""}
  </div>`;
}
