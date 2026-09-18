// Applies a theme (from /api/themes) as CSS custom properties on <html>.
// index.html re-applies the cached vars before first paint, so no flash.
import { api } from "./api.js";
import { state, emit } from "./state.js";

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
