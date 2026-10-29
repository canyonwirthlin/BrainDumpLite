// Concept / person sparkline: mentions per month for the last 12 months, first / last seen, total mentions and a
// trend word. Computed entirely in the browser from the dataset the map already loaded (concept -> its dumps ->
// their created_at), so it costs no request. Shows up as an info-box section (order 10) and as a compact chart in the
// hover card (hovercard.js imports sparkBlock / summarizeMentions from here).
import { esc } from "../ui.js";
import { infoSections } from "./infobox.js";

const DAY = 864e5;
const MONTHS = 12;
const fmtMonth = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const fmtShort = (t) => new Date(t).toLocaleDateString(undefined, { month: "short" });

// api.viewState.data is the full, unfiltered dataset: index it once per load (node id -> sorted mention times) so a
// min-mentions / date-range filter doesn't make a concept look less active than it is.
const indexes = new WeakMap();
function indexOf(data) {
  let idx = indexes.get(data);
  if (idx) return idx;
  const when = new Map();
  for (const n of data.nodes) if (n.type === "dump") { const t = Date.parse(n.created_at || ""); if (!Number.isNaN(t)) when.set(n.id, t); }
  idx = new Map();
  for (const e of data.edges) {
    if (e.type !== "mention") continue;
    const t = when.get(e.source);
    if (t == null) continue;
    (idx.get(e.target) || idx.set(e.target, []).get(e.target)).push(t);
  }
  for (const list of idx.values()) list.sort((a, b) => a - b);
  indexes.set(data, idx);
  return idx;
}

/** Sorted timestamps (ms) of the dumps that mention node `id`. Falls back to the visible map when the full dataset isn't there. */
export function mentionTimes(api, id) {
  const data = api.viewState && api.viewState.data;
  if (data && data.nodes && data.edges) return indexOf(data).get(id) || [];
  const out = [];
  for (const nb of api.nbrIds[id] || []) { const m = api.byId[nb]; const t = m && m.type === "dump" ? Date.parse(m.created_at || "") : NaN; if (!Number.isNaN(t)) out.push(t); }
  return out.sort((a, b) => a - b);
}

/** { total, first, last, months: [12 counts, oldest first], monthStarts: [12 ms], trend: "rising"|"steady"|"fading"|null, recent, prior } */
export function summarizeMentions(times, now = Date.now()) {
  const d = new Date(now);
  const monthStarts = [];
  for (let i = MONTHS - 1; i >= 0; i--) monthStarts.push(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime());
  const months = new Array(MONTHS).fill(0);
  let recent = 0, prior = 0;
  for (const t of times) {
    if (t >= monthStarts[0] && t <= now + DAY) {
      let k = MONTHS - 1;
      while (k > 0 && t < monthStarts[k]) k--;
      months[k]++;
    }
    const age = (now - t) / DAY;
    if (age <= 90) recent++; else if (age <= 180) prior++;
  }
  const total = times.length;
  let trend = null;
  if (total >= 2) {
    if (recent === 0) trend = "fading";
    else if (prior === 0) trend = recent >= 3 || (recent >= 2 && recent === total) ? "rising" : "steady";   // a brand-new topic that keeps coming up
    else if (recent >= prior * 1.5 && recent - prior >= 1) trend = "rising";
    else if (recent <= prior * 0.5 && prior - recent >= 1) trend = "fading";
    else trend = "steady";
  }
  return { total, first: total ? times[0] : null, last: total ? times[total - 1] : null, months, monthStarts, trend, recent, prior };
}

export const TREND_LABEL = { rising: "Rising", steady: "Steady", fading: "Fading" };
export const TREND_ARROW = { rising: "↗", steady: "→", fading: "↘" };

/** The inline-SVG bar chart (theme colours come from graph-cards.css). `compact` = hover-card size, no axis. */
export function sparkSvg(sum, { compact = false } = {}) {
  const w = compact ? 4 : 8, gap = compact ? 2 : 3, h = compact ? 20 : 38, base = 1.5;
  const W = MONTHS * w + (MONTHS - 1) * gap;
  const max = Math.max(1, ...sum.months);
  const bars = sum.months.map((c, i) => {
    const bh = c ? Math.max(3, Math.round((c / max) * (h - 2))) : base;
    const label = `${fmtMonth(sum.monthStarts[i])}: ${c} mention${c === 1 ? "" : "s"}`;
    return `<rect class="bdl-spark-bar${c ? "" : " zero"}${i === MONTHS - 1 ? " now" : ""}" x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1.2"><title>${esc(label)}</title></rect>`;
  }).join("");
  return `<svg class="bdl-spark${compact ? " compact" : ""}" viewBox="0 0 ${W} ${h}" width="${compact ? W : "100%"}" height="${h}" preserveAspectRatio="none" role="img" aria-label="Mentions per month, last 12 months">${bars}</svg>`;
}

export function trendBadge(sum) {
  return sum.trend ? `<span class="bdl-trend ${sum.trend}"><span aria-hidden="true">${TREND_ARROW[sum.trend]}</span> ${TREND_LABEL[sum.trend]}</span>` : "";
}

/** Compact block for the hover card: tiny chart, trend, first/last seen. */
export function sparkBlock(sum) {
  if (!sum.total) return "";
  return `<div class="bdl-hc-spark">${sparkSvg(sum, { compact: true })}<div class="bdl-hc-spark-side">${trendBadge(sum)}<span class="bdl-dim">${sum.total === 1 ? "once, " + fmtMonth(sum.first) : `${fmtMonth(sum.first)} to ${fmtMonth(sum.last)}`}</span></div></div>`;
}

infoSections.push({
  id: "sparkline", order: 10,
  render(n, api) {
    if (n.type !== "concept" && n.type !== "person") return null;
    const sum = summarizeMentions(mentionTimes(api, n.id));
    if (!sum.total) return null;
    const stat = (k, v) => `<div><div class="bdl-stat-k">${k}</div><div class="bdl-stat-v">${v}</div></div>`;
    return `<div class="bdl-info-spark">
      <div class="bdl-info-spark-head"><span>Mentions per month</span>${trendBadge(sum)}</div>
      ${sparkSvg(sum)}
      <div class="bdl-spark-axis"><span>${esc(fmtShort(sum.monthStarts[0]))}</span><span>${esc(fmtShort(sum.monthStarts[MONTHS - 1]))}</span></div>
      <div class="bdl-stats">${stat("Mentions", sum.total)}${stat("First seen", esc(fmtMonth(sum.first)))}${stat("Last seen", esc(fmtMonth(sum.last)))}</div>
    </div>`;
  },
});
