// Shared search helpers: saved + recent searches (stored in the vault) and the task-search box.
// Used by views/search.js (the Search tab) and views/tasks.js (the search bar in Tasks).
import { esc } from "./ui.js";
import { api } from "./api.js";

const OLD_KEYS = { saved: "bdl-saved-searches", recent: "bdl-recent-searches" };
let lists = { saved: [], recent: [] };

const readOld = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

// Load the lists from the vault; the first time, fold in whatever the old localStorage version kept.
export async function loadSearchLists() {
  try {
    const old = { saved: readOld(OLD_KEYS.saved), recent: readOld(OLD_KEYS.recent) };
    if (old.saved.length || old.recent.length) {
      lists = await api.post("/search/migrate", old);
      try { localStorage.removeItem(OLD_KEYS.saved); localStorage.removeItem(OLD_KEYS.recent); } catch {}
    } else lists = await api.get("/search/lists");
  } catch {}
  return lists;
}
export const savedList = () => lists.saved;
export const recentList = () => lists.recent;
export const isSaved = (q) => lists.saved.some((x) => x.toLowerCase() === q.toLowerCase());
const set = async (p) => { try { lists = await p; } catch {} };
export const rememberSearch = (q) => set(api.post("/search/recent", { query: q }));
export const clearRecent = () => set(api.del("/search/recent"));
export const toggleSaved = (q) => set(api.post(isSaved(q) ? "/search/saved/remove" : "/search/saved", { query: q }));

// The same search box as the Search tab (type, Enter or Search; suggestions from saved + recent).
// onQuery(q) is called with the trimmed text ("" when cleared).
export function searchBoxHtml(id, value = "", placeholder = "Search…") {
  const opts = [...new Set([...lists.saved, ...lists.recent])].map((q) => `<option value="${esc(q)}">`).join("");
  return `<span class="row" style="gap:6px"><input type="text" id="${id}" class="topbar-input" list="${id}-list" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">
    <datalist id="${id}-list">${opts}</datalist><button class="btn small" id="${id}-go">Search</button></span>`;
}
export function bindSearchBox(root, id, onQuery) {
  const input = root.querySelector("#" + id), go = root.querySelector("#" + id + "-go");
  if (!input || !go) return;
  const run = () => onQuery(input.value.trim());
  go.onclick = run;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
  input.oninput = () => { if (!input.value.trim()) onQuery(""); };
}

// Ids of tasks/goals/ideas matching q with the Search tab's engine (stems, prefixes, typo tolerance).
export async function searchTaskIds(q) {
  const r = await api.get("/search/tasks?q=" + encodeURIComponent(q));
  return { ids: new Set(r.ids), corrected: r.corrected || {} };
}
