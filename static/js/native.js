// Tauri bridge: external links, updater UI, What's New. Degrades to no-ops in a browser.
import { $, esc, md, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { setUpdate } from "./shell.js";

// ── Native shell bridge (Tauri) ──────────────────────────────────────────────
// Inside the native app Tauri injects window.__TAURI__ (withGlobalTauri in
// src-tauri/tauri.conf.json). In a plain browser it's undefined and everything
// here degrades gracefully.
export const native = window.__TAURI__ || null;

export function openExternal(url) {
  if (native) native.opener.openUrl(url).catch((e) => toast("Couldn't open link: " + (e.message || e), true));
  else window.open(url, "_blank", "noopener");
}

let pendingUpdate = null;

export async function checkForUpdates({ silent = true } = {}) {
  if (!native) { if (!silent) toast("Updates are only available in the installed app."); return; }
  try {
    const u = await native.updater.check();
    if (!u) { if (!silent) toast("You're on the latest version."); return; }
    pendingUpdate = u;
    setUpdate(u.version);
    if (!silent) showUpdateModal();
  } catch (e) {
    if (!silent) toast("Update check failed: " + (e.message || e), true);
  }
}

export function showUpdateModal() {
  const u = pendingUpdate;
  if (!u) return;
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">
    <h2>What's new in v${esc(u.version)}</h2>
    ${md(u.body || "No notes for this release.")}
    <div class="progress" style="display:none"><i></i></div>
    <div class="row">
      <button class="btn" id="upd-go">Install and restart</button>
      <button class="btn ghost" id="upd-later">Later</button>
    </div></div>`;
  document.body.appendChild(bg);
  $("#upd-later", bg).onclick = () => bg.remove();
  $("#upd-go", bg).onclick = async () => {
    const go = $("#upd-go", bg), bar = $(".progress", bg), fill = $(".progress i", bg);
    go.disabled = true; go.textContent = "Downloading…"; bar.style.display = "";
    let total = 0, got = 0;
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength || 0;
        else if (ev.event === "Progress") { got += ev.data.chunkLength; if (total) fill.style.width = Math.round(100 * got / total) + "%"; }
        else if (ev.event === "Finished") { fill.style.width = "100%"; go.textContent = "Installing…"; }
      });
      await native.process.relaunch();
    } catch (e) {
      toast("Update failed: " + (e.message || e), true);
      go.disabled = false; go.textContent = "Install and restart";
    }
  };
}


// ── What's New (hand-written CHANGELOG.md, served by /api/changelog) ────────

export function maybeShowWhatsNew() {
  const cur = state.status.version;
  if (!cur) return;
  let seen = null;
  try { seen = localStorage.getItem("bdl-seen-version"); } catch {}
  try { localStorage.setItem("bdl-seen-version", cur); } catch {}
  if (seen && seen !== cur) showWhatsNew(cur);   // first-ever run: store silently
}

export async function showWhatsNew(version) {
  let entries = [];
  try { entries = (await api.get("/changelog")).entries; } catch {}
  const e = entries.find((x) => x.version === version) || entries[0];
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">
    <h2>What's new in v${esc(version)}</h2>
    ${e ? md(e.body) : `<p class="muted">No notes for this version.</p>`}
    <div class="row"><button class="btn" id="wn-ok">Nice</button></div></div>`;
  document.body.appendChild(bg);
  $("#wn-ok", bg).onclick = () => bg.remove();
}

export function initNative() {
  // WebView2 would otherwise open http(s) links inside the app window.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    if (!/^(https?:|mailto:)/i.test(a.getAttribute("href") || "")) return;  // #hash routes stay in-app
    e.preventDefault();
    openExternal(a.href);
  });
  $("#update-pill").onclick = showUpdateModal;
}


// ── Idle nudge (Phase 4): one native notification per launch when nothing was
// captured for 3 days and the user opted in (Settings → Data → Notifications).
export async function maybeNudge() {
  if (!native?.notification) return;
  let on = false;
  try { on = localStorage.getItem("bdl-nudge") === "1"; } catch {}
  if (!on) return;
  const last = state.status.last_dump_at ? new Date(state.status.last_dump_at) : null;
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  if (days !== null && days < 3) return;
  try {
    let ok = await native.notification.isPermissionGranted();
    if (!ok) ok = (await native.notification.requestPermission()) === "granted";
    if (!ok) return;
    native.notification.sendNotification({
      title: "BrainDump Lite",
      body: days === null ? "Nothing captured yet — anything on your mind?" : `It's been ${days} days — anything on your mind?`,
    });
  } catch (e) { console.warn("nudge failed", e); }
}
