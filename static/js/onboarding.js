// First-run setup wizard: pick an AI provider (mandatory), then an optional
// skippable tour of the app. Modeled on shell.js's #lock overlay — a
// full-screen div appended to <body>, removed once the user is through.
import { $, $$, esc, toast, ICONS } from "./ui.js";
import { api } from "./api.js";
import { state, refreshStatus } from "./state.js";
import { openExternal } from "./native.js";
import { PROVIDER_META, paintEnginePanel } from "./views/settings.js";

const COST = {
  gemini: { tag: "Free tier", cls: "free" },
  builtin: { tag: "Free", cls: "free" },
  local: { tag: "Free", cls: "free" },
  anthropic: { tag: "Paid", cls: "paid" },
  openai: { tag: "Paid", cls: "paid" },
  off: { tag: "No AI", cls: "none" },
};

// Shown in this order — free options first, cheapest to try up top.
const ORDER = ["gemini", "builtin", "local", "anthropic", "openai", "off"];
const RECOMMENDED = "gemini";
const RECOMMENDED_MODEL = "gemini-2.5-flash";

let ob = null;  // { s, provider, resolve }

export function needsOnboarding() {
  return !state.status.onboarded;
}

export function runOnboarding() {
  return new Promise(async (resolve) => {
    let s;
    try { s = await api.get("/settings"); } catch { s = { provider: "off", defaults: {} }; }
    ob = { s, provider: null, resolve };
    const el = document.createElement("div");
    el.id = "onboarding";
    document.body.appendChild(el);
    paintAi();
  });
}

function paintAi() {
  const el = $("#onboarding");
  el.innerHTML = `
    <div class="ob-wrap">
      <div class="ob-head">
        <div class="brain-mark">${ICONS.brain}</div>
        <h1>Welcome to BrainDump Lite</h1>
        <p class="sub">First, pick how it thinks. Two options below are completely free —
          you can change this anytime later in Settings → AI.</p>
      </div>
      <div class="providers ob-providers">${ORDER.map((id) => {
        const p = PROVIDER_META.find((x) => x.id === id);
        const cost = COST[id];
        return `<button class="provider ${id === ob.provider ? "active" : ""}" data-p="${id}">
          <span class="ob-tag ${cost.cls}">${cost.tag}</span>
          ${id === RECOMMENDED ? `<span class="ob-rec">★ Recommended</span>` : ""}
          <b>${esc(p.name)}</b><span>${esc(p.desc)}</span>
        </button>`;
      }).join("")}</div>
      <div id="ob-detail"></div>
      <div class="ob-foot">
        <button class="btn" id="ob-continue" disabled>Continue</button>
      </div>
    </div>`;
  $$(".provider", el).forEach((b) => b.onclick = () => selectProvider(b.dataset.p));
  paintDetail();
}

function paintDetail() {
  const box = $("#ob-detail");
  const cont = $("#ob-continue");
  if (!ob.provider) { box.innerHTML = ""; cont.disabled = true; return; }
  const p = PROVIDER_META.find((x) => x.id === ob.provider);
  const s = ob.s;
  const d = s.defaults[ob.provider] || {};

  if (ob.provider === "gemini") {
    box.innerHTML = `<div class="card">
      <div class="ob-steps">
        <div class="ob-step-item"><b>1.</b> Open <a href="#" id="ob-gemini-link">aistudio.google.com</a> and sign in with any Google account.</div>
        <div class="ob-step-item"><b>2.</b> Click <b>"Get API key" → "Create API key"</b>. It's free, no credit card.</div>
        <div class="ob-step-item"><b>3.</b> Paste the key below.</div>
      </div>
      <div class="field"><label>API key</label>
        <input type="password" id="ob-key" placeholder="AIza…" value="${esc(s.provider === "gemini" ? s.api_key : "")}"></div>
      <p class="small muted">Recommended model for this project: <b>${RECOMMENDED_MODEL}</b> — fast,
        accurate at sorting dumps into tasks/ideas, and comfortably inside Gemini's free-tier limits.
        Already set below; change it later in Settings if you like.</p>
    </div>`;
    $("#ob-gemini-link", box).onclick = (e) => { e.preventDefault(); openExternal("https://aistudio.google.com/app/apikey"); };
    const key = $("#ob-key", box);
    const update = () => { cont.disabled = !key.value.trim(); };
    key.oninput = update; update();
    cont.onclick = () => continueWith({
      provider: "gemini", api_key: key.value.trim(),
      model: RECOMMENDED_MODEL, embed_model: d.embed_model || "text-embedding-004",
    });
    return;
  }

  if (ob.provider === "anthropic" || ob.provider === "openai") {
    const consoleUrl = ob.provider === "anthropic" ? "https://console.anthropic.com/settings/keys" : "https://platform.openai.com/api-keys";
    box.innerHTML = `<div class="card">
      <div class="ob-warn">💲 <b>${esc(p.name)} charges for usage.</b> Typical use here costs a few
        cents a day, but you need a card on file with ${esc(p.name)} and there is no fixed free quota.
        If you'd rather not pay, Gemini's free tier or the built-in local model cost nothing.</div>
      <p class="small muted">${p.help}</p>
      <div class="field"><label>API key</label>
        <input type="password" id="ob-key" placeholder="${ob.provider === "anthropic" ? "sk-ant-…" : "sk-…"}" value="${esc(s.provider === ob.provider ? s.api_key : "")}"></div>
      <label class="row" style="margin-top:6px;gap:8px;align-items:flex-start">
        <input type="checkbox" id="ob-ack" style="margin-top:3px">
        <span class="small">I understand ${esc(p.name)} bills my account for usage.</span>
      </label>
      <div class="row" style="margin-top:8px"><a href="#" id="ob-console">Get an API key →</a></div>
    </div>`;
    $("#ob-console", box).onclick = (e) => { e.preventDefault(); openExternal(consoleUrl); };
    const key = $("#ob-key", box), ack = $("#ob-ack", box);
    const update = () => { cont.disabled = !(key.value.trim() && ack.checked); };
    key.oninput = update; ack.onchange = update; update();
    cont.onclick = () => continueWith({
      provider: ob.provider, api_key: key.value.trim(), model: d.model, embed_model: d.embed_model || "",
    });
    return;
  }

  if (ob.provider === "local") {
    box.innerHTML = `<div class="card">
      <p class="small muted">${p.help}</p>
      <div class="field"><label>Server URL</label>
        <input type="text" id="ob-url" value="${esc(s.provider === "local" ? s.base_url : (d.base_url || "http://localhost:1234/v1"))}" placeholder="http://localhost:1234/v1"></div>
      <div class="field"><label>Model id <span class="muted">(optional — set later in Settings once the server is running)</span></label>
        <input type="text" id="ob-model" value="${esc(s.provider === "local" ? s.model : "")}" placeholder="model id"></div>
    </div>`;
    const url = $("#ob-url", box);
    const update = () => { cont.disabled = !url.value.trim(); };
    url.oninput = update; update();
    cont.onclick = () => continueWith({
      provider: "local", base_url: url.value.trim(), model: $("#ob-model", box).value.trim(),
    });
    return;
  }

  if (ob.provider === "builtin") {
    box.innerHTML = `<div class="card">
      <p class="small muted">${p.help} Pick a model below — you can switch anytime in Settings → AI.</p>
      <div id="engine-panel"><div class="center"><span class="spin"></span></div></div>
    </div>`;
    cont.disabled = false;
    cont.onclick = () => complete();
    // Sets provider=builtin immediately so the model list/download works exactly
    // like it does in Settings, and so a reload mid-download resumes correctly.
    if (!ob.builtinArmed) {
      ob.builtinArmed = true;
      api.put("/settings", { provider: "builtin" }).then(refreshStatus).finally(() => paintEnginePanel());
    } else {
      paintEnginePanel();
    }
    return;
  }

  // off
  box.innerHTML = `<div class="card">
    <p class="small muted">${p.help} You can turn AI on anytime from Settings → AI —
      nothing you've already saved is lost either way.</p>
  </div>`;
  cont.disabled = false;
  cont.onclick = () => continueWith({ provider: "off" });
}

function selectProvider(id) {
  ob.provider = id;
  $$(".provider", $("#onboarding")).forEach((b) => b.classList.toggle("active", b.dataset.p === id));
  paintDetail();
}

async function continueWith(fields) {
  const cont = $("#ob-continue");
  cont.disabled = true;
  cont.textContent = "Saving…";
  try {
    await api.put("/settings", fields);
    await refreshStatus();
  } catch (e) {
    toast("Couldn't save: " + e.message, true);
    cont.disabled = false;
    cont.textContent = "Continue";
    return;
  }
  // Best-effort connection check for cloud providers — never blocks setup,
  // just gives an early heads-up if the key is wrong.
  if (["anthropic", "openai", "gemini"].includes(fields.provider)) {
    api.post("/settings/test").then((r) => {
      if (!r.ok) toast("Saved, but: " + r.message, true);
    }).catch(() => {});
  }
  await complete();
}

async function complete() {
  try { await api.post("/onboarding/complete"); } catch {}
  await refreshStatus();
  paintTutorial();
}

// ── Skippable tour ────────────────────────────────────────────────────────

const SLIDES = [
  { icon: "🌀", title: "Just dump it", body: "Type, paste, or hit the mic on the Capture screen and get everything out of your head. Don't organize — that's the AI's job." },
  { icon: "🗂️", title: "It sorts itself out", body: "Every dump is split into tasks, ideas, concerns, events and notes automatically, with tone and time-sensitivity picked up along the way." },
  { icon: "☀️", title: "Today & Tasks", body: "Today shows what actually matters right now. Tasks is the full list — everything you've kept, across every dump." },
  { icon: "🔎", title: "History, Search & Graph", body: "History is your timeline. Search finds anything by keyword or meaning. Graph shows how dumps connect through shared people and topics." },
  { icon: "📥", title: "Inbox proposes, you decide", body: "Suggestions like calendar events or Todoist tasks wait in the Inbox for your approval — nothing gets pushed anywhere on its own." },
  { icon: "⚙️", title: "Make it yours", body: "Settings lets you switch AI providers, customize what gets extracted, change themes, and connect integrations — anytime." },
];

function paintTutorial() {
  const el = $("#onboarding");
  let i = 0;
  const draw = () => {
    const s = SLIDES[i];
    const last = i === SLIDES.length - 1;
    el.innerHTML = `
      <div class="ob-wrap ob-tour">
        <button class="btn ghost small ob-skip" id="ob-skip">Skip tutorial</button>
        <div class="ob-slide">
          <div class="ob-slide-icon">${s.icon}</div>
          <h1>${esc(s.title)}</h1>
          <p class="sub">${esc(s.body)}</p>
        </div>
        <div class="ob-dots">${SLIDES.map((_, n) => `<i class="${n === i ? "on" : ""}"></i>`).join("")}</div>
        <div class="ob-foot">
          <button class="btn ghost" id="ob-back" ${i === 0 ? "disabled" : ""}>Back</button>
          <div class="grow"></div>
          <button class="btn" id="ob-next">${last ? "Get started" : "Next"}</button>
        </div>
      </div>`;
    $("#ob-skip", el).onclick = finish;
    $("#ob-back", el).onclick = () => { i = Math.max(0, i - 1); draw(); };
    $("#ob-next", el).onclick = () => { if (last) finish(); else { i++; draw(); } };
  };
  draw();
}

function finish() {
  try { localStorage.setItem("bdl-tutorial-seen", "1"); } catch {}
  $("#onboarding")?.remove();
  const r = ob?.resolve;
  ob = null;
  if (r) r();
}

export function replayTutorial() {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.id = "onboarding";
    document.body.appendChild(el);
    ob = { s: null, provider: null, resolve };
    paintTutorial();
  });
}
