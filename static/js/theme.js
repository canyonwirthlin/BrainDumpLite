// Applies a theme (from /api/themes) as CSS custom properties on <html>.
// index.html re-applies the cached vars before first paint, so no flash.
import { api } from "./api.js";
import { state, emit, on } from "./state.js";

const KEYS = ["bg", "rail", "panel", "panel2", "line", "text", "dim", "accent", "accent2", "accentSoft", "green", "red", "amber"];
const CSS = { panel2: "--panel-2", accent2: "--accent-2", accentSoft: "--accent-soft" };
export const BUILTIN_IDS = ["midnight", "ocean", "forest", "ember", "paper", "sakura"];

export function cssVars(theme) {
  const out = {};
  for (const k of KEYS) out[CSS[k] || "--" + k] = theme.colors[k];
  out["--radius"] = (theme.radius || 12) + "px";
  return out;
}

export function apply(theme) {
  const root = document.documentElement;
  const vars = cssVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  try {
    localStorage.setItem("bdl-theme", theme.id);
    localStorage.setItem("bdl-theme-css", JSON.stringify({ id: theme.id, scheme: theme.scheme, vars }));
  } catch {}
  state.activeTheme = theme.id;
  emit("theme", theme);
}

// ── Editor support ──────────────────────────────────────────────────────────
// Live preview paints the whole app with an unsaved theme. It never touches
// localStorage or the server, and any navigation puts the real theme back, so an
// abandoned edit can't stick.
let previewing = false;

export function preview(theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(theme))) root.style.setProperty(k, v);
  root.style.colorScheme = theme.scheme;
  previewing = true;
}

export function endPreview() {
  if (!previewing) return;
  previewing = false;
  const t = state.themes.find((x) => x.id === state.activeTheme);
  if (t) apply(t);
}
on("route", endPreview);

// The translucent accent tint (selected rows, ghost buttons). Mirrors themes._soft_from.
export function softFrom(accent, scheme) {
  const m = /^#([0-9a-f]{6})$/i.exec(accent || "");
  if (!m) return "rgba(139,124,246,.16)";
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${scheme === "light" ? ".12" : ".16"})`;
}

// Create (id null) or update a custom theme, then make it the active one.
export async function saveTheme(theme, id = null) {
  const body = { name: theme.name, scheme: theme.scheme, radius: theme.radius, colors: theme.colors };
  const saved = id ? await api.put("/themes/" + encodeURIComponent(id), body) : await api.post("/themes", body);
  await loadThemes();
  await setActive(saved.id);
  return saved;
}

export async function loadThemes() {
  try {
    const { active, themes } = await api.get("/themes");
    state.themes = themes;
    const t = themes.find((x) => x.id === active) || themes[0];
    if (t) apply(t);
  } catch {}  // cached vars from index.html stay in effect
}

export async function setActive(id) {
  await api.put("/themes/active", { id });
  const t = state.themes.find((x) => x.id === id);
  if (t) apply(t);
}

export async function importTheme(file) {
  let json;
  try { json = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON."); }
  const t = await api.post("/themes/import", json);
  await loadThemes();
  return t;
}

export async function deleteTheme(id) {
  await api.del("/themes/" + encodeURIComponent(id));
  await loadThemes();
}

export const exportUrl = (id) => "/api/themes/" + encodeURIComponent(id) + "/export";

// Density + motion are per-device preferences (localStorage only).
export function setDensity(v) {
  document.documentElement.dataset.density = v;
  try { localStorage.setItem("bdl-density", v); } catch {}
}
export function setMotion(v) {
  document.documentElement.dataset.motion = v;
  try { localStorage.setItem("bdl-motion", v); } catch {}
}
export function restorePrefs() {
  try {
    setDensity(localStorage.getItem("bdl-density") || "comfortable");
    setMotion(localStorage.getItem("bdl-motion") || "auto");
  } catch {}
}
