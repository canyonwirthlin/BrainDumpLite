// Model pickers for the Gemini provider. The lists come from Google's own model
// endpoint via /api/gemini/setup, so nothing here names a model: Google retires and
// renames them too often. Shared by onboarding and Settings → AI.
import { esc } from "./ui.js";
import { api } from "./api.js";

// <option>s for a list of {id, label, note}; keeps `current` selected even if Google no longer lists it.
export function modelOptions(list, current) {
  const listed = list.some((m) => m.id === current);
  return (listed || !current ? "" : `<option value="${esc(current)}" selected>${esc(current)} — current (no longer listed)</option>`)
    + list.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.label || m.id)}${m.note ? " · " + esc(m.note) : ""}</option>`).join("");
}

// probe=true asks Google which free models really answer for this key (a few tiny calls);
// probe=false just lists. Resolves to the /gemini/setup result; rejects with Google's message.
export const geminiSetup = (apiKey, probe) => api.post("/gemini/setup", { api_key: apiKey, probe });

export function autoPickNote(r) {
  if (r.model) return "Picked automatically: the newest free model that answered with your key. Change it any time.";
  return "None of Google's free models answered with this key (its free quota may be switched off). Pick one below, or check the key.";
}
