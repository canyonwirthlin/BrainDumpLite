// Left rail + top bar. Views call ctx.setTitle(title, slotHtml) to own the
// top bar's middle slot; the right cluster (AI pill, update pill) is global.
import { $, $$, ICONS, PROVIDER_NAMES, esc } from "./ui.js";
import { api } from "./api.js";
import { state, on, refreshStatus } from "./state.js";
import { setTitleHandler, go } from "./router.js";

export const NAV = [
  { id: "capture", label: "Capture" }, { id: "graph", label: "Graph" }, { id: "search", label: "Search" },
  { id: "today", label: "Today" }, { id: "history", label: "History" }, { id: "tasks", label: "Tasks" },
  { id: "inbox", label: "Inbox" }, { id: "reflect", label: "Reflect" },
];

export function mountShell() {
  $("#rail").innerHTML = `
    <a class="brain" href="#capture" title="BrainDump Lite">${ICONS.brain}</a>
    ${NAV.map((n) => `<a class="nav" data-v="${n.id}" href="#${n.id}" title="${n.label}">${ICONS[n.id]}<span>${n.label}</span>${n.id === "inbox" ? `<i class="nbadge" id="inbox-badge" hidden></i>` : ""}</a>`).join("")}
    <div class="grow"></div>
    <span class="ai-dot" id="ai-dot" title="AI off"></span>
    <a class="nav" data-v="settings" href="#settings" title="Settings">${ICONS.settings}<span>Settings</span><i class="badge" id="rail-badge" hidden></i></a>`;
  on("route", ({ name }) => $$("#rail .nav").forEach((a) => a.classList.toggle("active", a.dataset.v === name)));
  on("status", paintStatus);
  on("status", (st) => { if (st.locked) showLock(); else hideLock(); });
  setTitleHandler(setTitle);
  paintStatus(state.status);
  initIdleLock();
  document.addEventListener("keydown", (e) => {
    if (isLocked()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault(); go("capture"); setTimeout(() => $("#dump-text")?.focus(), 50);
    }
  });
}

export function setTitle(title, slotHtml = "") {
  $("#title").textContent = title;
  $("#topbar-slot").innerHTML = slotHtml;
  document.title = title === "Capture" ? "BrainDump Lite" : `${title} · BrainDump Lite`;
}

function paintStatus(status) {
  const nb = $("#inbox-badge");
  if (nb) { const n = status.inbox_pending || 0; nb.hidden = !n; nb.textContent = n > 99 ? "99+" : n; }
  const pill = $("#ai-pill"), dot = $("#ai-dot");
  if (!pill || !dot) return;
  if (status.ai) {
    pill.className = "pill on"; pill.textContent = `● ${PROVIDER_NAMES[status.provider] || status.provider}`; pill.title = status.model || "";
    dot.classList.add("on"); dot.title = pill.textContent;
  } else {
    pill.className = "pill off"; pill.textContent = "○ AI off"; pill.title = "";
    dot.classList.remove("on"); dot.title = "AI off";
  }
}

export function setUpdate(version) {
  const pill = $("#update-pill"), badge = $("#rail-badge");
  if (version) { pill.textContent = `⬆ v${esc(version)}`; pill.style.display = ""; badge.hidden = false; }
  else { pill.style.display = "none"; badge.hidden = true; }
}


// ── App lock overlay (Phase 4) ───────────────────────────────────────────────
// The backend refuses /api calls while locked (423); this overlay is the UI
// half. Idle for 10 minutes → lock again (only when a passphrase is set).
const IDLE_MS = 10 * 60 * 1000;
let idleTimer = null;

export const isLocked = () => !!$("#lock");

export function showLock() {
  if ($("#lock")) return;
  const el = document.createElement("div");
  el.id = "lock";
  el.innerHTML = `<form class="lock-card" id="lock-form">
      <div class="brain-mark">${ICONS.brain}</div>
      <h2>BrainDump Lite is locked</h2>
      <input type="password" id="lock-pass" placeholder="Passphrase" autocomplete="current-password" autofocus>
      <button class="btn" type="submit">Unlock</button>
      <div class="small muted" id="lock-msg"></div>
    </form>`;
  document.body.appendChild(el);
  $("#lock-form").onsubmit = async (e) => {
    e.preventDefault();
    const pass = $("#lock-pass").value;
    try {
      const r = await fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
      if (!r.ok) { $("#lock-msg").textContent = r.status === 401 ? "Wrong passphrase." : "Couldn't unlock."; $("#lock-pass").select(); return; }
      hideLock();
      await refreshStatus();
      location.reload();
    } catch { $("#lock-msg").textContent = "Couldn't reach the app."; }
  };
  setTimeout(() => $("#lock-pass")?.focus(), 50);
}

export function hideLock() { $("#lock")?.remove(); }

export async function lockNow() {
  try { await api.post("/lock/now"); } catch {}
  showLock();
}

function initIdleLock() {
  const bump = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (state.status.lock_set && !isLocked()) lockNow(); }, IDLE_MS);
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(ev, bump, { passive: true });
  bump();
}
