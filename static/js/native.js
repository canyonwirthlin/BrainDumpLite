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

// The window itself, for the custom titlebar (shell.js) — decorations are off
// (see tauri.conf.json), so minimize/maximize/close are ours to draw and wire up.
export const currentWindow = native ? native.window.getCurrentWindow() : null;

export const minimizeWindow = () => currentWindow?.minimize();
export const toggleMaximizeWindow = () => currentWindow?.toggleMaximize();
export const closeWindow = () => currentWindow?.close();

// "Open at system startup" (onboarding + Settings → Data). No-op in a browser.
export async function isAutostartEnabled() {
  if (!native) return false;
  try { return await native.autostart.isEnabled(); } catch { return false; }
}

export async function setAutostart(on) {
  if (!native) return;
  try { await native.autostart[on ? "enable" : "disable"](); } catch (e) { console.warn("autostart toggle failed", e); }
}

// "Quit when I close the window" (Settings → Data). Lives in the Rust shell because the
// close button is handled there; off = hide to the tray. No-op in a browser.
export async function getQuitOnClose() {
  if (!native) return false;
  try { return !!(await native.core.invoke("get_quit_on_close")); } catch { return false; }
}

export async function setQuitOnClose(on) {
  if (!native) return;
  try { await native.core.invoke("set_quit_on_close", { enabled: on }); } catch (e) { console.warn("close-behaviour toggle failed", e); }
}

export function openExternal(url) {
  if (native) native.opener.openUrl(url).catch((e) => toast("Couldn't open link: " + (e.message || e), true));
  else window.open(url, "_blank", "noopener");
}

// "Save as…": the OS Save dialog (Tauri shell), then the backend writes the file to the
// chosen path — the shell has no fs plugin, and the backend already holds the data.
// A plain browser has no native dialog, so it gets an ordinary download instead.
// Resolves to the saved path, or null if cancelled / downloaded.
export async function saveAs({ defaultName, ext, label, endpoint, body = {}, downloadUrl }) {
  if (!(native && native.dialog && native.dialog.save)) {
    const a = Object.assign(document.createElement("a"), { href: downloadUrl, download: defaultName });
    document.body.appendChild(a); a.click(); a.remove();
    return null;
  }
  const path = await native.dialog.save({ title: `Save ${label}`, defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
  if (!path) return null;
  return (await api.post(endpoint, { ...body, path })).path;
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


// ── Streak reminders: every couple hours (while the window is open OR just
// hidden to the tray — closing to tray keeps this JS running), nudge toward
// today's dump if nothing's landed yet and the setting is on (Settings →
// Data). Stays quiet once a dump lands, and outside a reasonable waking window.
const STREAK_CHECK_MS = 2 * 60 * 60 * 1000;

// On unless the user switched it off (onboarding or Settings → Data both write "0"/"1").
export function streakNotifyOn() {
  try { return localStorage.getItem("bdl-streak-notify") !== "0"; } catch { return true; }
}
export function setStreakNotify(on) {
  try { localStorage.setItem("bdl-streak-notify", on ? "1" : "0"); } catch {}
}

export function startStreakReminders() {
  checkStreakReminder();
  setInterval(checkStreakReminder, STREAK_CHECK_MS);
}

async function checkStreakReminder() {
  if (!native?.notification) return;
  if (!streakNotifyOn()) return;
  const hour = new Date().getHours();
  if (hour < 9 || hour >= 22) return;  // no 3 a.m. buzzing
  let s;
  try { s = await api.get("/streaks"); } catch { return; }
  const dumpedToday = s.current_streak > 0 && !s.at_risk;
  if (dumpedToday) return;
  try {
    let ok = await native.notification.isPermissionGranted();
    if (!ok) ok = (await native.notification.requestPermission()) === "granted";
    if (!ok) return;
    native.notification.sendNotification({
      title: "BrainDump Lite",
      body: s.current_streak > 0
        ? `🔥 Keep your ${s.current_streak}-day streak alive — dump something before the day ends.`
        : "Start today's streak — dump whatever's on your mind.",
    });
  } catch (e) { console.warn("streak reminder failed", e); }
}
