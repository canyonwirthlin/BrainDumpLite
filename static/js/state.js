// The only mutable app state. Views import `state` and mutate its properties.
import { api } from "./api.js";

export const state = {
  status: { ai: false, whisper: false, provider: "off", model: "", version: "", data_dir: "" },
  curMode: "freeform",
  draft: "",
  pollTimer: null,
  themes: [],
  activeTheme: "midnight",
};

const subs = {};
export function on(ev, fn) { (subs[ev] ||= []).push(fn); }
export function emit(ev, data) { (subs[ev] || []).forEach((f) => f(data)); }

export function clearPoll() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

export async function refreshStatus() {
  try { state.status = await api.get("/status"); } catch {}
  emit("status", state.status);
}
