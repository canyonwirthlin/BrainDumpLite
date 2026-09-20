// Shared helpers + constants. Pure functions only; no app state here.
import { state } from "./state.js";
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Capture modes. `chat` modes open a live conversation (needs AI); the others are one-shot dumps.
// `color` tints the whole capture screen (chips, glow, bubbles) so the modes read as different places.
const art = (body) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const MODES = [
  { id: "freeform", icon: "🌀", label: "Freeform", color: "var(--accent)", chat: false,
    hero: "What's on your mind?", sub: "Dump it all — tasks, worries, ideas. The AI sorts it out.",
    about: "Write, paste or talk with no structure at all. The AI tidies the text, then pulls out tasks, ideas, people and topics.",
    how: "One-shot · saved as a dump", placeholder: "Type, paste, or hit the mic and just talk…",
    art: art('<path d="M5 30c5-13 9 9 15-4s9 9 15-4 5 3 8-2"/><path d="M8 14h14M8 20h8" opacity=".5"/>') },
  { id: "brainstorm", icon: "💡", label: "Brainstorm", color: "var(--amber)", chat: true,
    hero: "What are we building?", sub: "Think out loud with a creative partner that builds on every idea.",
    about: "A live back-and-forth with an idea partner. It adds an unexpected angle, suggests one small thing to try, then asks what's next.",
    how: "Live chat · saved when you end it", placeholder: "Throw an idea, a problem or a half-formed thought…",
    opener: "Got an idea, a problem or a half-formed thought? Throw it at me — I'll build on it and push it somewhere new.",
    art: art('<path d="M24 6a10 10 0 0 0-5 18.5V30h10v-5.5A10 10 0 0 0 24 6z"/><path d="M20 35h8M21 39h6M24 1v2M9 9l1.5 1.5M39 9l-1.5 1.5M3 20h2M43 20h2"/>') },
  { id: "therapy", icon: "🫂", label: "Therapy", color: "var(--green)", chat: true,
    hero: "How are you doing?", sub: "A calm, private place to talk things through.",
    about: "A gentle conversation. It reflects the feeling it hears and asks one open question at a time. It's an AI, not a therapist — no diagnosing or advice.",
    how: "Live chat · saved when you end it", placeholder: "Say what's on your mind. Take your time…",
    opener: "I'm here. What's on your mind today? Take your time — I'll listen and ask one question at a time.",
    art: art('<path d="M8 8h22a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H20l-7 6v-6H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z"/><path d="M38 19h2a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-2v5l-6-5h-8" opacity=".55"/><path d="M19 22c-4-2.5-5.5-4.5-5.5-6.3a2.6 2.6 0 0 1 5.5-.9 2.6 2.6 0 0 1 5.5.9c0 1.8-1.5 3.8-5.5 6.3z"/>') },
  { id: "execution", icon: "⚡", label: "Execution", color: "var(--accent-2)", chat: false,
    hero: "What needs doing?", sub: "List it out — get tasks with dates and a first step for each.",
    about: "For getting things done. List what needs doing, one per line; each becomes a task you can date, check off and send to your calendar in Tasks.",
    how: "One-shot · saved as a dump", placeholder: "One thing per line — call the dentist Friday, finish the report, …",
    art: art('<rect x="5" y="8" width="9" height="9" rx="2.5"/><path d="M7.5 12.5l2 2 3-4"/><path d="M20 12.5h22"/><rect x="5" y="22" width="9" height="9" rx="2.5"/><path d="M7.5 26.5l2 2 3-4"/><path d="M20 26.5h16"/><rect x="5" y="36" width="9" height="9" rx="2.5"/><path d="M20 40.5h12" opacity=".5"/>') },
];
export const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
export const PROVIDER_NAMES = { builtin: "Built-in AI", anthropic: "Claude", openai: "OpenAI", gemini: "Gemini", local: "Self-hosted", off: "AI off" };
export const STAGES = [
  ["cleanup", "Cleaning transcript"], ["classify", "Extracting items"],
  ["embed", "Embedding"], ["link", "Linking to past dumps"],
];

export function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 20);  // not rAF — throttled tabs never fire it
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
}

export const fmtDate = (iso) => new Date(iso).toLocaleString(undefined,
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso) => new Date(iso + "T00:00").toLocaleDateString(undefined,
  { weekday: "short", month: "short", day: "numeric" });
export const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// "just now", "5m ago", "3h ago", "yesterday", "Sep 9"
export function relTime(iso) {
  const d = new Date(iso), now = new Date(), s = (now - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400 && d.getDate() === now.getDate()) return Math.floor(s / 3600) + "h ago";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Minimal markdown-ish rendering: bullets + paragraphs.
export function md(text) {
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

// Modal helper: returns {el, close}. Caller fills `.modal` and binds buttons.
export function modal(innerHtml) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">${innerHtml}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  return { el: bg, close };
}

// 18px stroke icons for the rail and palette.
export const ICONS = {
  brain: `<svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zm6 0a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z"/></svg>`,
  capture: `<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>`,
  history: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  today: `<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.5"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>`,
  graph: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8 7l8 1M8 8l2 8M16 10l-6 8"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>`,
  reflect: `<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24"><path d="M4 13l2-8h12l2 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/></svg>`,
  stats: `<svg viewBox="0 0 24 24"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
};

// Windows-11-style window control glyphs for the custom titlebar (native.js).
export const WIN_ICONS = {
  min: `<svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg>`,
  max: `<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>`,
  restore: `<svg viewBox="0 0 10 10"><rect x="1" y="2.5" width="6.5" height="6"/><path d="M2.5 2.5V1h6.5v6H8"/></svg>`,
  close: `<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8"/></svg>`,
};

// ── Phase 3: item types, tone, trust, time chips ─────────────────────────────
const TOKEN_COLORS = { accent: "var(--accent)", green: "var(--green)", amber: "var(--amber)", red: "var(--red)", blue: "#60a5fa", dim: "var(--dim)" };
export const colorCss = (c) => TOKEN_COLORS[c] || c || "var(--dim)";

export function typeOf(kind) {
  return state.types.find((t) => t.id === kind) || { id: kind, label: kind, icon: "", color: "dim" };
}

export function kindBadge(kind) {
  const t = typeOf(kind);
  return `<span class="kind" style="--kc:${colorCss(t.color)}" title="${esc(t.hint || t.label)}">${t.icon ? t.icon + " " : ""}${esc(t.label)}</span>`;
}

export const TONE_ICONS = { calm: "🌿", hopeful: "🌤️", excited: "⚡", neutral: "•", reflective: "🪞", anxious: "😬", frustrated: "😤", overwhelmed: "🌊", low: "🌧️" };
export function toneChip(tone) {
  if (!tone || !tone.label) return "";
  return `<span class="tone" data-valence="${tone.valence ?? 0}" title="valence ${tone.valence ?? 0}, energy ${tone.energy ?? 1}">${TONE_ICONS[tone.label] || ""} ${esc(tone.label)}</span>`;
}

export function trustBadge(provider) {
  if (!provider) return "";
  const local = provider === "builtin" || provider === "local";
  const cls = provider === "off" ? "raw" : local ? "local" : "cloud";
  const label = provider === "off" ? "raw" : local ? "on-device" : "cloud";
  const title = provider === "off" ? "Saved without AI processing" : local ? `Processed on this PC (${provider})` : `Text was sent to ${provider}`;
  return `<span class="trust ${cls}" title="${title}">${label}</span>`;
}

export function timeChips(it) {
  let out = "";
  if (it.est_minutes) out += `<span class="chip est" title="Estimated effort">~${it.est_minutes >= 60 ? (it.est_minutes / 60) + "h" : it.est_minutes + "m"}</span>`;
  if (it.urgency >= 2) out += `<span class="urg u${it.urgency}" title="${it.urgency === 3 ? "Needs attention today" : "This week"}${it.time_hint ? " · " + esc(it.time_hint) : ""}"></span>`;
  return out;
}
