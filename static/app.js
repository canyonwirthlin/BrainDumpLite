/* BrainDump Lite — vanilla SPA, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const api = {
  async req(method, path, body) {
    const opts = { method, headers: {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const r = await fetch("/api" + path, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  },
  get: (p) => api.req("GET", p),
  post: (p, b) => api.req("POST", p, b),
  put: (p, b) => api.req("PUT", p, b),
  patch: (p, b) => api.req("PATCH", p, b),
  del: (p) => api.req("DELETE", p),
};

const MODES = [
  { id: "freeform", icon: "🌀", label: "Freeform" },
  { id: "brainstorm", icon: "💡", label: "Brainstorm" },
  { id: "therapy", icon: "🫂", label: "Therapy" },
  { id: "execution", icon: "⚡", label: "Execution" },
];

const THEMES = [
  { id: "midnight", label: "Midnight", sw: ["#0d1017", "#151b28", "#8b7cf6"] },
  { id: "ocean", label: "Ocean", sw: ["#0a121f", "#101a2b", "#38bdf8"] },
  { id: "forest", label: "Forest", sw: ["#0c1210", "#121b17", "#4ade80"] },
  { id: "ember", label: "Ember", sw: ["#16100e", "#201613", "#fb923c"] },
  { id: "paper", label: "Paper", sw: ["#f4f5f9", "#ffffff", "#6d5ce6"] },
  { id: "sakura", label: "Sakura", sw: ["#faf3f5", "#ffffff", "#d6488f"] },
];

function setTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem("bdl-theme", id); } catch {}
}
const curTheme = () => document.documentElement.dataset.theme || "midnight";

function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 20);  // not rAF — throttled tabs never fire it
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
}
const STAGES = [
  ["cleanup", "Cleaning transcript"],
  ["classify", "Extracting items"],
  ["expand", "Thinking deeper"],
  ["embed", "Embedding"],
  ["link", "Linking to past dumps"],
];
const PROVIDER_NAMES = { builtin: "Built-in AI", anthropic: "Claude", openai: "OpenAI", local: "Self-hosted", off: "AI off" };

let status = { ai: false, whisper: false, provider: "off", model: "" };
let curMode = "freeform";
let pollTimer = null;
let draft = "";

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined,
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso + "T00:00").toLocaleDateString(undefined,
  { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Prefilled Google Calendar event link — no OAuth, user completes it there.
function gcalUrl(t) {
  const p = new URLSearchParams({ action: "TEMPLATE", text: t.content.slice(0, 120) });
  if (t.due_date) {
    const [d, tm] = t.due_date.split("T");
    const stamp = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
    if (tm) {  // timed event: YYYYMMDDTHHMMSS, 1h long
      const s = new Date(`${d}T${tm}`), e = new Date(s.getTime() + 3600000);
      const dt = (x) => `${stamp(x)}T${String(x.getHours()).padStart(2, "0")}${String(x.getMinutes()).padStart(2, "0")}00`;
      p.set("dates", `${dt(s)}/${dt(e)}`);
    } else {   // all-day: start/next-day
      const next = new Date(d + "T00:00"); next.setDate(next.getDate() + 1);
      p.set("dates", `${d.replace(/-/g, "")}/${stamp(next)}`);
    }
  }
  p.set("details", (t.detail ? "First step: " + t.detail + "\n" : "") + "From BrainDump Lite");
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

function calBtns(t) {
  return `<a class="iconbtn cal" title="Add to Google Calendar" target="_blank" rel="noopener" href="${esc(gcalUrl(t))}">📅</a>
    <a class="iconbtn cal" title="Download .ics (Apple Calendar / Outlook / Reminders)" href="/api/items/${t.id}/ics">⬇</a>`;
}

// ── Editable due date/time (used in Tasks + review rows) ─────────────────────
// Markup is an empty span; paintDue() fills it (chip or "+ date"), and clicking
// swaps in date/time inputs. Any change PATCHes the item, then reload() re-renders.
function dueWrap(it) {
  return `<span class="due-wrap" data-id="${it.id}" data-due="${esc(it.due_date || "")}"></span>`;
}

function paintDue(wrap, done) {
  const dd = wrap.dataset.due || "";
  const [d, tm] = dd.split("T");
  if (dd) {
    const overdue = !tm && d < todayIso() && !done;
    wrap.innerHTML = `<button class="chip due-open ${overdue ? "overdue" : "due"}" title="Edit date">⏰ ${fmtDay(d)}${tm ? " · " + fmtTime(tm) : ""}</button>`;
  } else {
    wrap.innerHTML = `<button class="chip due-open adddate" title="Add a date">＋ date</button>`;
  }
}

function bindDue(container, reload) {
  $$(".due-wrap", container).forEach((wrap) => {
    const done = !!wrap.closest(".task-row.done, .item.done");
    paintDue(wrap, done);
    wrap.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-due-act]")?.dataset.dueAct;
      if (e.target.closest(".due-open")) {
        const [d, tm] = (wrap.dataset.due || "").split("T");
        wrap.innerHTML = `
          <span class="due-editor">
            <input type="date" class="due-d" value="${d || ""}">
            <input type="time" class="due-t" value="${tm || ""}">
            <button class="chip mini set" data-due-act="save">Set</button>
            ${wrap.dataset.due ? `<button class="chip mini" data-due-act="clear">Clear</button>` : ""}
            <button class="chip mini" data-due-act="cancel">✕</button>
          </span>`;
        $(".due-d", wrap).focus();
        return;
      }
      if (!act) return;
      const id = wrap.dataset.id;
      try {
        if (act === "save") {
          const d = $(".due-d", wrap).value;
          const tm = $(".due-t", wrap).value;
          if (!d) { toast("Pick a date first", true); return; }
          await api.patch("/items/" + id, { due_date: tm ? `${d}T${tm}` : d });
          reload();
        } else if (act === "clear") {
          await api.patch("/items/" + id, { due_date: null });
          reload();
        } else if (act === "cancel") {
          paintDue(wrap, done);
        }
      } catch (err) { toast("Couldn't update date: " + err.message, true); }
    });
  });
}

// Minimal markdown-ish rendering: bullets + paragraphs.
function md(text) {
  const lines = esc(text).split(/\r?\n/);
  let html = "", inList = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*[•\-\*]\s+(.*)/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (ln.trim()) html += `<p>${ln}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return `<div class="md">${html}</div>`;
}

// ── Router ───────────────────────────────────────────────────────────────────

const view = () => $("#view");

function route() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const hash = location.hash.slice(1) || "capture";
  const [name, arg] = hash.split("/");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.v === name));
  // One-shot entrance animation per navigation.
  const v = view();
  v.classList.remove("fade");
  void v.offsetWidth;
  v.classList.add("fade");
  const views = {
    capture: renderCapture, history: renderHistory, dump: () => renderDumpDetail(arg),
    tasks: renderTasks, graph: renderGraph, search: renderSearch, reflect: renderReflect, settings: renderSettings,
  };
  (views[name] || renderCapture)();
}

async function refreshStatus() {
  try { status = await api.get("/status"); } catch {}
  const pill = $("#ai-pill");
  if (status.ai) {
    pill.className = "pill on";
    pill.textContent = `● ${PROVIDER_NAMES[status.provider] || status.provider}`;
    pill.title = status.model;
  } else {
    pill.className = "pill off";
    pill.textContent = "○ AI off";
  }
  $("#update-pill").style.display = status.update_ready ? "" : "none";
}

// ── Capture ──────────────────────────────────────────────────────────────────

function renderCapture() {
  view().innerHTML = `
    <h1>What's on your mind?</h1>
    <p class="sub">Dump it all — tasks, worries, ideas. The AI sorts it out.</p>
    ${status.ai ? "" : `<div class="banner">AI is off — dumps are saved raw without processing.
      <a href="#settings">Connect a key in Settings</a> to unlock the magic.</div>`}
    <div class="modes">${MODES.map((m) => `
      <button class="mode-chip ${m.id === curMode ? "active" : ""}" data-mode="${m.id}">
        ${m.icon} ${m.label}</button>`).join("")}
    </div>
    <textarea id="dump-text" placeholder="Type, paste, or hit the mic and just talk…">${esc(draft)}</textarea>
    <div class="row">
      ${status.whisper ? `<button class="mic" id="mic" title="Record voice">🎙️</button>
        <span class="muted small" id="rec-status"></span>` : ""}
      <div class="grow"></div>
      <button class="btn" id="dump-btn">Dump it →</button>
    </div>
    <div class="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to dump</div>`;
  $$(".mode-chip").forEach((b) => b.onclick = () => {
    curMode = b.dataset.mode;
    $$(".mode-chip").forEach((x) => x.classList.toggle("active", x === b));
  });
  $("#dump-text").oninput = (e) => { draft = e.target.value; };
  $("#dump-text").onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitDump(); }
  };
  $("#dump-btn").onclick = submitDump;
  if ($("#mic")) $("#mic").onclick = toggleRecording;
}

async function submitDump() {
  const text = $("#dump-text").value.trim();
  if (!text) return;
  $("#dump-btn").disabled = true;
  try {
    const { id } = await api.post("/dumps", { text, mode: curMode });
    draft = "";
    renderProcessing(id);
  } catch (e) {
    toast("Failed to save dump: " + e.message, true);
    $("#dump-btn").disabled = false;
  }
}

function renderProcessing(id) {
  view().innerHTML = `
    <h1>Processing…</h1>
    <p class="sub">${status.ai ? "The pipeline is chewing on your dump." : "Saving (AI off — raw mode)."}</p>
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
  pollTimer = setInterval(async () => {
    try {
      const d = await api.get("/dumps/" + id);
      draw(d.stage, d.status);
      if (d.status === "ready") {
        clearInterval(pollTimer); pollTimer = null;
        renderReview(d);
      } else if (d.status === "failed") {
        clearInterval(pollTimer); pollTimer = null;
        view().innerHTML = `<h1>Hmm.</h1><div class="card">
          <p>Processing failed: <span class="muted">${esc(d.error || "unknown error")}</span></p>
          <p class="small muted" style="margin-top:8px">Your dump is saved — find it in History.</p>
          <div class="row"><a class="btn ghost" href="#history">History</a>
          <a class="btn" href="#capture">New dump</a></div></div>`;
      }
    } catch {}
  }, 900);
}

// ── Review (shared by capture flow + history detail) ─────────────────────────

function itemRow(it) {
  return `
    <div class="item ${it.status === "rejected" ? "rejected" : ""}" data-id="${it.id}">
      <span class="kind ${it.kind}">${it.kind}</span>
      <div class="body">
        <div class="content">${esc(it.content)}
          ${["task", "goal", "event"].includes(it.kind) ? dueWrap(it) : ""}
          ${it.priority >= 4 ? `<span class="chip">P${it.priority}</span>` : ""}
        </div>
        ${it.detail ? `<div class="detail">↳ ${esc(it.detail)}</div>` : ""}
      </div>
      ${["task", "goal", "event"].includes(it.kind) ? calBtns(it) : ""}
      <button class="iconbtn ok ${it.status === "approved" ? "active" : ""}" title="Keep">✓</button>
      <button class="iconbtn no ${it.status === "rejected" ? "active" : ""}" title="Reject">✕</button>
    </div>`;
}

function bindItemRows(container, items, reload) {
  if (reload) bindDue(container, reload);
  $$(".item", container).forEach((el) => {
    const it = items.find((x) => x.id === el.dataset.id);
    const [ok, no] = [$(".ok", el), $(".no", el)];
    ok.onclick = async () => {
      const next = it.status === "approved" ? "suggested" : "approved";
      await api.patch("/items/" + it.id, { status: next });
      it.status = next;
      ok.classList.toggle("active", next === "approved");
      no.classList.remove("active");
      el.classList.remove("rejected");
    };
    no.onclick = async () => {
      const next = it.status === "rejected" ? "suggested" : "rejected";
      await api.patch("/items/" + it.id, { status: next });
      it.status = next;
      no.classList.toggle("active", next === "rejected");
      ok.classList.remove("active");
      el.classList.toggle("rejected", next === "rejected");
    };
  });
}

function reviewHtml(d, { showBack = false } = {}) {
  const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
  return `
    <h1>${esc(d.title || "Untitled dump")}</h1>
    <p class="sub">${mode.icon} ${mode.label} · ${fmtDate(d.created_at)}</p>
    ${d.summary ? `<div class="card">${md(d.summary)}</div>` : ""}
    ${d.reflection ? `<div class="reflection"><div class="tag">${mode.icon} ${mode.label} take</div>${md(d.reflection)}</div>` : ""}
    ${d.items.length ? `<div class="card"><h2>Extracted items <span class="muted small">(✓ keep · ✕ reject)</span></h2>
      <div id="items">${d.items.map(itemRow).join("")}</div>
      <div class="row"><button class="btn ghost" id="approve-all">Keep all</button></div></div>` : ""}
    ${d.related && d.related.length ? `<div class="card"><h2>Related dumps</h2>
      ${d.related.map((r) => `<div class="dump-row" style="padding:6px 0">
        <a href="#dump/${r.id}" class="grow">🔗 ${esc(r.title || "Untitled")}</a>
        <span class="meta">${fmtDate(r.created_at)}</span></div>`).join("")}</div>` : ""}
    <details class="card"><summary class="muted">Raw text</summary>
      <p class="small" style="margin-top:10px;white-space:pre-wrap">${esc(d.raw_text)}</p></details>
    <div class="row">
      ${showBack ? `<a class="btn ghost" href="#history">← History</a>
        <button class="btn danger" id="delete-dump">Delete</button>` : ""}
      <div class="grow"></div>
      <a class="btn" href="#capture">New dump →</a>
    </div>`;
}

function renderReview(d) {
  view().innerHTML = reviewHtml(d);
  bindItemRows(view(), d.items, async () => {
    try { renderReview(await api.get("/dumps/" + d.id)); } catch {}
  });
  if ($("#approve-all")) $("#approve-all").onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) {
      await api.patch("/items/" + it.id, { status: "approved" });
      it.status = "approved";
    }
    $$("#items .item:not(.rejected) .ok").forEach((b) => b.classList.add("active"));
  };
}

// ── History ──────────────────────────────────────────────────────────────────

async function renderHistory() {
  view().innerHTML = `<h1>History</h1><p class="sub">Every dump, newest first.</p><div id="list" class="center">Loading…</div>`;
  const dumps = await api.get("/dumps");
  if (!dumps.length) {
    $("#list").innerHTML = `<div class="center"><div class="big">🌱</div>Nothing here yet.<br><br><a class="btn" href="#capture">Make your first dump</a></div>`;
    return;
  }
  $("#list").className = "";
  $("#list").innerHTML = dumps.map((d) => {
    const mode = MODES.find((m) => m.id === d.mode) || MODES[0];
    return `<div class="card click" onclick="location.hash='dump/${d.id}'">
      <div class="dump-row">
        <span class="status-dot ${d.status}"></span>
        <div class="grow">
          <b>${esc(d.title || (d.raw_text || "").slice(0, 60) || "Untitled")}</b>
          <div class="meta">${mode.icon} ${fmtDate(d.created_at)} · ${d.item_count} item${d.item_count === 1 ? "" : "s"}
            ${d.status === "processing" ? " · processing…" : d.status === "failed" ? " · failed" : ""}</div>
        </div>
      </div></div>`;
  }).join("");
}

async function renderDumpDetail(id) {
  view().innerHTML = `<div class="center">Loading…</div>`;
  let d;
  try { d = await api.get("/dumps/" + id); }
  catch { view().innerHTML = `<div class="center">Dump not found. <a href="#history">Back</a></div>`; return; }
  if (d.status === "processing" || d.status === "pending") { renderProcessing(id); return; }
  view().innerHTML = reviewHtml(d, { showBack: true });
  bindItemRows(view(), d.items, () => renderDumpDetail(id));
  if ($("#approve-all")) $("#approve-all").onclick = async () => {
    for (const it of d.items.filter((x) => x.status === "suggested")) {
      await api.patch("/items/" + it.id, { status: "approved" });
      it.status = "approved";
    }
    $$("#items .item:not(.rejected) .ok").forEach((b) => b.classList.add("active"));
  };
  if ($("#delete-dump")) $("#delete-dump").onclick = async () => {
    if (!confirm("Delete this dump and its items?")) return;
    await api.del("/dumps/" + id);
    location.hash = "history";
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

async function renderTasks() {
  view().innerHTML = `<h1>Tasks</h1><p class="sub">Tasks and goals pulled from your dumps.</p><div id="list" class="center">Loading…</div>`;
  const tasks = await api.get("/tasks");
  if (!tasks.length) {
    $("#list").innerHTML = `<div class="center"><div class="big">🧺</div>No tasks yet — they appear when your dumps contain them.</div>`;
    return;
  }
  const today = todayIso();
  const dayOf = (t) => (t.due_date || "").split("T")[0] || null;  // date part only
  const groups = { Overdue: [], Today: [], Upcoming: [], Someday: [], Done: [] };
  for (const t of tasks) {
    const day = dayOf(t);
    if (t.done) groups.Done.push(t);
    else if (day && day < today) groups.Overdue.push(t);
    else if (day === today) groups.Today.push(t);
    else if (day) groups.Upcoming.push(t);
    else groups.Someday.push(t);
  }
  $("#list").className = "";
  $("#list").innerHTML = Object.entries(groups).filter(([, v]) => v.length).map(([g, list]) => `
    <div class="group-label">${g} · ${list.length}</div>
    <div class="card">${list.map((t) => `
      <div class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <div class="body grow">
          <span class="content">${esc(t.content)}</span>
          ${dueWrap(t)}
          ${t.priority >= 4 ? `<span class="chip">P${t.priority}</span>` : ""}
          ${t.status === "suggested" ? `<span class="chip">unreviewed</span>` : ""}
          <div class="detail small muted">from <a href="#dump/${t.dump_id}">${esc(t.dump_title || "dump")}</a></div>
        </div>
        ${calBtns(t)}
        <button class="iconbtn no" title="Reject">✕</button>
      </div>`).join("")}</div>`).join("");
  bindDue($("#list"), renderTasks);
  $$(".task-row").forEach((el) => {
    const t = tasks.find((x) => x.id === el.dataset.id);
    $("input", el).onchange = async (e) => {
      await api.patch("/items/" + t.id, { done: e.target.checked, status: "approved" });
      renderTasks();
    };
    $(".no", el).onclick = async () => {
      await api.patch("/items/" + t.id, { status: "rejected" });
      renderTasks();
    };
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

function renderSearch() {
  view().innerHTML = `
    <h1>Search your brain</h1>
    <p class="sub">${status.ai ? "Keyword + semantic search across every dump." : "Keyword search across every dump."}</p>
    <div class="row" style="margin:0 0 16px">
      <input type="text" id="q" class="grow" placeholder="burnout, that app idea, mom's birthday…" autofocus>
      <button class="btn" id="go">Search</button>
    </div>
    <div id="results"></div>`;
  const go = async () => {
    const q = $("#q").value.trim();
    if (!q) return;
    $("#results").innerHTML = `<div class="center">Searching…</div>`;
    const rows = await api.get("/search?q=" + encodeURIComponent(q));
    $("#results").innerHTML = rows.length ? rows.map((r) => `
      <div class="card click" onclick="location.hash='dump/${r.id}'">
        <b>${esc(r.title || "Untitled")}</b>
        <span class="chip">${r.via}</span>
        <div class="meta small muted">${fmtDate(r.created_at)}</div>
        <div class="small" style="margin-top:6px">${esc(r.snippet || "").replace(/「/g, "<b>").replace(/」/g, "</b>")}</div>
      </div>`).join("")
      : `<div class="center"><div class="big">🔍</div>No matches for “${esc(q)}”.</div>`;
  };
  $("#go").onclick = go;
  $("#q").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

// ── Reflect ──────────────────────────────────────────────────────────────────

function renderReflect() {
  view().innerHTML = `
    <h1>Reflect</h1>
    <p class="sub">Your second brain reads everything back to you.</p>
    ${["daily", "weekly"].map((k) => `
      <div class="card">
        <div class="row" style="margin:0 0 6px">
          <h2 class="grow">${k === "daily" ? "☀️ Today" : "📆 This week"}</h2>
          <button class="btn ghost small" data-kind="${k}" data-force="0">Generate</button>
          <button class="btn ghost small" data-kind="${k}" data-force="1" title="Ignore cache">↻</button>
        </div>
        <div id="reflect-${k}" class="muted small">Press Generate.</div>
      </div>`).join("")}`;
  $$("[data-kind]").forEach((b) => b.onclick = async () => {
    const box = $("#reflect-" + b.dataset.kind);
    box.innerHTML = `<span class="spin"></span>`;
    try {
      const r = await api.post("/reflect", { kind: b.dataset.kind, force: b.dataset.force === "1" });
      box.className = "";
      box.innerHTML = md(r.content) + (r.cached ? `<div class="small muted" style="margin-top:6px">cached — ↻ to regenerate</div>` : "");
    } catch (e) {
      box.className = "muted small";
      box.textContent = "Failed: " + e.message;
    }
  });
}

// ── Graph (Obsidian-style force-directed map — dumps, concepts, people) ──────

const GRAPH_R = { dump: 7, concept: 5, person: 5 };

// Node/label colors follow the active theme.
function graphColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  return {
    dump: v("--accent", "#8b7cf6"),
    concept: "#f59e0b",
    person: "#3b82f6",
    text: v("--text", "#e6e9f2"),
    edge: v("--dim", "#8b93a8"),
  };
}

async function renderGraph() {
  const gc = graphColors();
  view().innerHTML = `
    <h1>Brain map</h1>
    <p class="sub">Every dump, concept, and person you've mentioned. Drag nodes, scroll to zoom, click to explore.</p>
    <div class="graph-legend">
      <span><i class="dot" style="background:${gc.dump}"></i>Dumps</span>
      <span><i class="dot" style="background:${gc.concept}"></i>Concepts</span>
      <span><i class="dot" style="background:${gc.person}"></i>People</span>
    </div>
    <div class="graph-wrap card" id="graph-wrap">
      <canvas id="graph-canvas"></canvas>
      <div id="graph-info" class="graph-info" style="display:none"></div>
    </div>`;
  let data;
  try { data = await api.get("/graph"); } catch (e) {
    $("#graph-wrap").innerHTML = `<div class="center">Couldn't load the graph: ${esc(e.message)}</div>`;
    return;
  }
  if (!data.nodes.length) {
    $("#graph-wrap").innerHTML = `<div class="center">Nothing to map yet — make a few dumps first.</div>`;
    return;
  }
  mountForceGraph($("#graph-canvas"), data);
}

function mountForceGraph(canvas, data) {
  const wrap = canvas.parentElement;
  const infoBox = $("#graph-info");
  const ctx = canvas.getContext("2d");
  const GC = graphColors();
  const H = 560;
  const W = () => wrap.clientWidth;

  const degree = {};
  data.edges.forEach((e) => { degree[e.source] = (degree[e.source] || 0) + 1; degree[e.target] = (degree[e.target] || 0) + 1; });

  const nodes = data.nodes.map((n, i) => {
    const angle = (i / data.nodes.length) * Math.PI * 2;
    return {
      ...n, vx: 0, vy: 0, fx: null, fy: null,
      x: W() / 2 + Math.cos(angle) * 120 + (Math.random() - 0.5) * 30,
      y: H / 2 + Math.sin(angle) * 120 + (Math.random() - 0.5) * 30,
      r: (GRAPH_R[n.type] || 5) + Math.min(9, (degree[n.id] || 0) * 1.1),
    };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId[e.source] && byId[e.target]);

  let scale = 1, panX = 0, panY = 0, alpha = 1;
  let hoverId = null, selectedId = null;
  let needsDraw = true;
  // Window-level listeners are removed when the graph view unmounts.
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = W() + "px";
    canvas.style.height = H + "px";
    canvas.width = W() * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }
  resize();
  window.addEventListener("resize", resize, sig);

  function neighborsOf(id) {
    const s = new Set([id]);
    edges.forEach((e) => { if (e.source === id) s.add(e.target); if (e.target === id) s.add(e.source); });
    return s;
  }

  function tick() {
    // View switched away → stop the loop and drop window listeners.
    if (!canvas.isConnected) { ac.abort(); return; }
    if (alpha > 0.008) {
      const k = alpha;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 4);
          const f = (2200 / d2) * k;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      edges.forEach((e) => {
        const a = byId[e.source], b = byId[e.target];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        const target = e.type === "similar" ? 150 : 95;
        const f = (d - target) * 0.02 * k;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      });
      nodes.forEach((n) => {
        n.vx += (W() / 2 - n.x) * 0.0012 * k;
        n.vy += (H / 2 - n.y) * 0.0012 * k;
      });
      nodes.forEach((n) => {
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; return; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      });
      alpha *= 0.985;
      needsDraw = true;
    }
    // Once the physics settle, redraw only on interaction — idle cost ~0.
    if (needsDraw) { draw(); needsDraw = false; }
    requestAnimationFrame(tick);
  }

  function draw() {
    ctx.clearRect(0, 0, W(), H);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    const activeId = hoverId || selectedId;
    const hood = activeId ? neighborsOf(activeId) : null;
    edges.forEach((e) => {
      const a = byId[e.source], b = byId[e.target];
      const dim = hood && !(hood.has(e.source) && hood.has(e.target));
      const similar = e.type === "similar";
      ctx.strokeStyle = similar ? GC.dump : GC.edge;
      ctx.globalAlpha = similar ? (dim ? 0.06 : 0.5) : (dim ? 0.05 : 0.25);
      ctx.lineWidth = similar ? Math.max(0.6, (e.score || 0.5) * 2) : 1;
      ctx.setLineDash(similar ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    nodes.forEach((n) => {
      const dim = hood && !hood.has(n.id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = GC[n.type] || "#999";
      if (n.id === hoverId) { ctx.shadowColor = GC[n.type] || GC.dump; ctx.shadowBlur = 14; }
      ctx.fill();
      ctx.shadowBlur = 0;  // glow on the hovered node only — cheap for one arc
      if (n.id === selectedId) { ctx.lineWidth = 2; ctx.strokeStyle = GC.text; ctx.stroke(); }
      if (!dim && (n.r > 8 || hood)) {
        ctx.fillStyle = GC.text;
        ctx.font = "11px sans-serif";
        ctx.fillText(n.label.slice(0, 30), n.x + n.r + 4, n.y + 3);
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function toWorld(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    return { x: (cx - rect.left - panX) / scale, y: (cy - rect.top - panY) / scale };
  }
  function nodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
    }
    return null;
  }
  function showInfo(n) {
    const hood = neighborsOf(n.id);
    const dumpsHere = nodes.filter((x) => x.type === "dump" && hood.has(x.id));
    infoBox.style.display = "block";
    infoBox.innerHTML = `<b>${n.type === "concept" ? "💡" : "🧑"} ${esc(n.label)}</b>
      <div class="small muted" style="margin:6px 0">${dumpsHere.length} dump${dumpsHere.length === 1 ? "" : "s"}</div>
      ${dumpsHere.map((d) => `<div style="margin-top:3px"><a href="#dump/${d.id}">${esc(d.label)}</a></div>`).join("")}`;
  }

  let dragging = null, panning = false, lastPan = null, moved = false;
  canvas.addEventListener("mousedown", (e) => {
    moved = false;
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { dragging = n; n.fx = n.x; n.fy = n.y; alpha = Math.max(alpha, 0.3); }
    else { panning = true; lastPan = { x: e.clientX, y: e.clientY }; }
  });
  window.addEventListener("mousemove", (e) => {
    moved = true;
    if (dragging) {
      const p = toWorld(e.clientX, e.clientY);
      dragging.fx = p.x; dragging.fy = p.y;
      alpha = Math.max(alpha, 0.3);
    } else if (panning) {
      panX += e.clientX - lastPan.x; panY += e.clientY - lastPan.y;
      lastPan = { x: e.clientX, y: e.clientY };
      needsDraw = true;
    } else {
      const rect = canvas.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      const n = inside ? nodeAt(toWorld(e.clientX, e.clientY).x, toWorld(e.clientX, e.clientY).y) : null;
      const next = n ? n.id : null;
      if (next !== hoverId) { hoverId = next; needsDraw = true; }
      if (inside) canvas.style.cursor = n ? "pointer" : "grab";
    }
  }, sig);
  window.addEventListener("mouseup", () => { dragging = null; panning = false; }, sig);
  canvas.addEventListener("dblclick", (e) => {
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (n) { n.fx = null; n.fy = null; alpha = Math.max(alpha, 0.3); }
  });
  canvas.addEventListener("click", (e) => {
    if (moved && dragging === null) { /* was a pan, not a click */ }
    const p = toWorld(e.clientX, e.clientY);
    const n = nodeAt(p.x, p.y);
    if (!n) { selectedId = null; infoBox.style.display = "none"; needsDraw = true; return; }
    if (n.type === "dump") { location.hash = "dump/" + n.id; return; }
    selectedId = n.id;
    needsDraw = true;
    showInfo(n);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const next = Math.min(4, Math.max(0.25, scale * factor));
    panX = mx - (mx - panX) * (next / scale);
    panY = my - (my - panY) * (next / scale);
    scale = next;
    needsDraw = true;
  }, { passive: false });

  tick();
}

// ── Settings ─────────────────────────────────────────────────────────────────

const PROVIDER_META = [
  { id: "builtin", name: "Built-in", desc: "Free · runs on this PC", help: "Runs a small AI model directly on this computer — GPU-accelerated, no account, no cost, and nothing you write ever leaves your machine. One-time model download (2–5 GB), then it works offline." },
  { id: "anthropic", name: "Claude", desc: "Anthropic API key", help: "Get a key at console.anthropic.com → API Keys. Costs cents/day at normal use." },
  { id: "openai", name: "OpenAI", desc: "OpenAI API key", help: "Get a key at platform.openai.com → API Keys. Also enables semantic search embeddings." },
  { id: "local", name: "Self-hosted", desc: "LM Studio / Ollama", help: "Point at any OpenAI-compatible server. Nothing ever leaves your machine." },
  { id: "off", name: "Off", desc: "No AI", help: "Dumps are stored raw. You can turn AI on any time — old dumps stay as they are." },
];

async function renderSettings() {
  view().innerHTML = `<div class="center">Loading…</div>`;
  const s = await api.get("/settings");
  const cur = () => s.provider;
  const paint = () => {
    const meta = PROVIDER_META.find((p) => p.id === cur());
    view().innerHTML = `
      <h1>Settings</h1>
      <p class="sub">Make it yours — theme, AI provider, voice.</p>
      <h2>Appearance</h2>
      <div class="themes" style="margin-bottom:24px">${THEMES.map((t) => `
        <button class="theme-swatch ${t.id === curTheme() ? "active" : ""}" data-theme="${t.id}">
          <div class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</div>
          <span>${t.label}</span></button>`).join("")}
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
      <p class="small muted">Data lives in <code>${esc(status.data_dir || "")}</code> — delete that folder to wipe everything.</p>`;
    $$(".theme-swatch").forEach((b) => b.onclick = () => {
      setTheme(b.dataset.theme);
      $$(".theme-swatch").forEach((x) => x.classList.toggle("active", x === b));
    });
    $$(".provider").forEach((b) => b.onclick = async () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }  // engine-panel poll
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
    if (!pollTimer) pollTimer = setInterval(paintEnginePanel, 1200);
  } else {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (ENGINE_PHASES[prev] && ph === "done") {
      toast("Built-in AI is ready 🎉");
      await refreshStatus();
    }
  }
}

// ── Voice recording ──────────────────────────────────────────────────────────

let mediaRec = null, chunks = [], recTimer = null;

async function toggleRecording() {
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
        const ta = $("#dump-text");
        if (ta && text) {
          ta.value = (ta.value ? ta.value.trimEnd() + " " : "") + text;
          draft = ta.value;
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

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener("hashchange", route);
// Clicking a link whose hash equals the CURRENT hash fires no hashchange
// (e.g. "New dump →" right after submitting from #capture) — re-route manually.
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute("href") === (location.hash || "#capture")) {
    e.preventDefault();
    route();
  }
});
(async () => {
  await refreshStatus();
  route();
})();
