// Stats → Model comparison: per model (or model x stage) numbers from /api/stats/models, with a
// side-by-side view for the models the user ticks. Only shows what the runs table can support.
import { $, $$, esc } from "../ui.js";
import { api } from "../api.js";

const fmtMs = (ms) => ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms";
const fmtPct = (v) => v == null ? "—" : Math.round(v * 100) + "%";
const fmtNum = (v, d = 0) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

// key, heading, value formatter, which direction wins (1 = higher is better, -1 = lower), bar scale
const COLS = [
  { k: "runs", h: "runs", f: (r) => fmtNum(r.runs), dir: 0 },
  { k: "success_rate", h: "ok", f: (r) => fmtPct(r.success_rate), dir: 1, bar: true },
  { k: "fallback_rate", h: "fell back", f: (r) => fmtPct(r.fallback_rate), dir: -1, bar: true,
    tip: "Cleanup or classify calls that failed, so the app used your raw text or simple heuristics" },
  { k: "median_ms", h: "median", f: (r) => fmtMs(r.median_ms), dir: -1, bar: true },
  { k: "p90_ms", h: "p90", f: (r) => fmtMs(r.p90_ms), dir: -1, bar: true },
  { k: "tokens_per_sec", h: "tok/s", f: (r) => fmtNum(r.tokens_per_sec, 1), dir: 1, bar: true,
    tip: "Output tokens per second of wall time (prompt processing included)" },
  { k: "avg_out_tokens", h: "avg out", f: (r) => fmtNum(r.avg_out_tokens, 0), dir: 0,
    tip: "Average output tokens per call" },
  { k: "approval_rate", h: "kept", f: (r) => fmtPct(r.approval_rate), dir: 1, bar: true,
    tip: "Share of this model's classified tasks and ideas that you approved rather than rejected" },
];

const label = (r, byStage) => `${r.provider}/${r.model}${byStage ? " · " + r.stage : ""}`;
const keyOf = (r) => `${r.provider}/${r.model}/${r.stage || ""}`;

function injectStyle() {
  if ($("#mc-style")) return;
  const s = document.createElement("style");
  s.id = "mc-style";
  s.textContent = `
  .mc-ctl { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 0 0 12px; }
  .mc-ctl select { font-size: 12px; padding: 3px 8px; border-radius: 999px; }
  .mc-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .mc-table td.mc-name { text-align: left; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mc-table th[data-sort] { cursor: pointer; white-space: nowrap; user-select: none; }
  .mc-table th[data-sort]:hover, .mc-table th.sorted { color: var(--accent); }
  .mc-table td, .mc-table th { white-space: nowrap; }
  .mc-table td.mc-pick, .mc-table th.mc-pick { width: 26px; padding-right: 0; }
  .mc-table input[type=checkbox] { accent-color: var(--accent); width: 15px; height: 15px; vertical-align: middle; }
  .mc-table td.mc-pick, .mc-table th.mc-pick { position: sticky; left: 0; background: var(--panel); z-index: 1; }
  .mc-table td.mc-name, .mc-table th.mc-nm { position: sticky; left: 26px; background: var(--panel); z-index: 1; max-width: 150px; }
  .mc-table tr.sel td { background: color-mix(in srgb, var(--accent) 14%, var(--panel)); }
  .mc-small { color: var(--amber); font-size: 11px; margin-left: 4px; }
  .mc-metric { margin: 12px 0 4px; font-size: 12px; color: var(--dim); }
  .mc-metric b { color: var(--text); font-weight: 600; }
  .mc-bar-row { display: grid; grid-template-columns: minmax(90px, 44%) 1fr 56px; gap: 8px; align-items: center; font-size: 12.5px; margin: 3px 0; }
  .mc-bar-row .bar-label { color: var(--text); }
  .mc-bar-row.best .bar-track i { background: var(--green); }
  .mc-bar-row.best .bar-val { color: var(--green); }
  .mc-notes { margin-top: 10px; }
  .mc-notes summary { cursor: pointer; font-size: 12px; color: var(--dim); }
  .mc-notes ul { margin: 6px 0 0 18px; padding: 0; font-size: 12px; color: var(--dim); line-height: 1.5; }
  `;
  document.head.appendChild(s);
}

export function mount(box) {
  injectStyle();
  const st = { days: 30, stage: "", byStage: false, sort: "runs", desc: true, picked: new Set(), auto: true };
  let data = null;
  const clearPicks = () => { st.picked.clear(); st.auto = true; };

  const load = async () => {
    box.innerHTML = `<div class="sec">Model comparison</div><div class="center"><span class="spin"></span></div>`;
    try {
      data = await api.get(`/stats/models?days=${st.days}` + (st.stage ? `&stage=${encodeURIComponent(st.stage)}` : ""));
    } catch (e) { box.innerHTML = `<div class="sec">Model comparison</div><div class="card small muted">Couldn't load model comparison: ${esc(e.message)}</div>`; return; }
    draw();
  };

  const rowsNow = () => {
    const rows = [...(st.byStage ? data.by_stage : data.models)];
    const val = (r) => { const v = r[st.sort]; return v == null ? null : v; };
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;            // blanks always last
      if (y == null) return -1;
      return st.desc ? y - x : x - y;
    });
    return rows;
  };

  const compareCard = (rows) => {
    const sel = rows.filter((r) => st.picked.has(keyOf(r)));
    if (data.models.length < 2) return "";
    if (sel.length < 2) return `<div class="card"><h2>Side by side</h2><p class="small muted">Tick two or more rows above to compare them.</p></div>`;
    const blocks = COLS.filter((c) => c.bar).map((c) => {
      const vals = sel.map((r) => r[c.k]);
      const have = vals.filter((v) => v != null);
      if (!have.length) return `<div class="mc-metric"><b>${esc(c.h)}</b> · no data for these models</div>`;
      const max = Math.max(...have, 1e-9);
      const best = c.dir > 0 ? Math.max(...have) : Math.min(...have);
      const tie = have.every((v) => v === have[0]);
      return `<div class="mc-metric"><b>${esc(c.h)}</b> · ${c.dir > 0 ? "higher" : "lower"} is better${c.tip ? " — " + esc(c.tip) : ""}</div>` +
        sel.map((r) => {
          const v = r[c.k];
          return `<div class="mc-bar-row ${!tie && v != null && v === best ? "best" : ""}" title="${esc(label(r, st.byStage))}: ${esc(c.f(r))}">
            <span class="bar-label">${esc(label(r, st.byStage))}</span>
            <span class="bar-track"><i style="width:${v == null ? 0 : Math.max(2, Math.round(100 * v / max))}%"></i></span>
            <span class="bar-val mono">${esc(c.f(r))}</span></div>`;
        }).join("");
    }).join("");
    return `<div class="card"><h2>Side by side <span class="small muted">(${sel.length} selected)</span></h2>${blocks}</div>`;
  };

  const draw = () => {
    const rows = rowsNow();
    if (st.auto && st.picked.size === 0) {   // first paint: the two busiest models
      (st.byStage ? data.by_stage : data.models).slice(0, 2).forEach((r) => st.picked.add(keyOf(r)));
    }
    const ranges = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All"]]
      .map(([d, t]) => `<button class="chip ${st.days === d ? "on" : ""}" data-mc-days="${d}">${t}</button>`).join("");
    const stageSel = `<select id="mc-stage" aria-label="Stage"><option value="">All stages</option>${
      data.stages.map((s) => `<option value="${esc(s)}" ${st.stage === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
    const view = `<button class="chip ${st.byStage ? "" : "on"}" data-mc-view="0">By model</button><button class="chip ${st.byStage ? "on" : ""}" data-mc-view="1">By model and stage</button>`;
    let body;
    if (!data.models.length) {
      body = `<p class="small muted">No model calls in this window yet. Dump something with AI on and come back.</p>`;
    } else {
      const head = COLS.map((c) => `<th data-sort="${c.k}" class="${st.sort === c.k ? "sorted" : ""}" ${c.tip ? `title="${esc(c.tip)}"` : ""}>${c.h}${st.sort === c.k ? (st.desc ? " ▾" : " ▴") : ""}</th>`).join("");
      const trs = rows.map((r) => `<tr class="${st.picked.has(keyOf(r)) ? "sel" : ""}">
        <td class="mc-pick"><input type="checkbox" data-pick="${esc(keyOf(r))}" aria-label="Compare ${esc(label(r, st.byStage))}" ${st.picked.has(keyOf(r)) ? "checked" : ""}></td>
        <td class="mc-name" title="${esc(label(r, st.byStage))}">${esc(label(r, st.byStage))}${r.local ? ` <span class="small muted">on-device</span>` : ""}${r.runs < 5 ? `<span class="mc-small" title="Few runs, so treat the numbers loosely">few runs</span>` : ""}</td>
        ${COLS.map((c) => `<td class="mono">${esc(c.f(r))}</td>`).join("")}</tr>`).join("");
      body = `<div class="mc-wrap"><table class="stat-table mc-table"><tr><th class="mc-pick"></th><th class="mc-nm" data-sort="name" style="cursor:default">model</th>${head}</tr>${trs}</table></div>` +
        (data.models.length < 2 ? `<p class="small muted" style="margin-top:8px">You need at least two models to compare. Switch model in Settings → AI, use the app for a while, and they will appear here side by side.</p>` : "");
    }
    box.innerHTML = `<div class="sec">Model comparison</div>
      <div class="card"><div class="mc-ctl">${ranges}${stageSel}</div><div class="mc-ctl">${view}</div>${body}
        <details class="mc-notes"><summary>What these numbers mean, and what is missing</summary><ul>${data.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>
      </div>${compareCard(rows)}`;
    $$("[data-mc-days]", box).forEach((b) => b.onclick = () => { st.days = +b.dataset.mcDays; clearPicks(); load(); });
    $$("[data-mc-view]", box).forEach((b) => b.onclick = () => { st.byStage = b.dataset.mcView === "1"; clearPicks(); draw(); });
    const sel = $("#mc-stage", box);
    if (sel) sel.onchange = () => { st.stage = sel.value; clearPicks(); load(); };
    $$("th[data-sort]", box).forEach((th) => th.onclick = () => {
      const k = th.dataset.sort;
      if (k === "name") return;
      if (st.sort === k) st.desc = !st.desc; else { st.sort = k; st.desc = COLS.find((c) => c.k === k).dir >= 0; }
      draw();
    });
    $$("[data-pick]", box).forEach((cb) => cb.onchange = () => {
      st.auto = false;
      if (cb.checked) st.picked.add(cb.dataset.pick); else st.picked.delete(cb.dataset.pick);
      draw();
    });
  };

  load();
}
