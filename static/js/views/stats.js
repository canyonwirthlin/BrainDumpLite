// Statistics: streaks, words dumped, and the model/cost/latency numbers that
// used to live under Settings → Stats.
import { $, $$, esc } from "../ui.js";
import { api } from "../api.js";

const fmtMs = (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms";
const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
const fmtInt = (n) => (n || 0).toLocaleString();

function bars(rows, key, label, fmt = fmtInt) {
  const max = Math.max(1, ...rows.map((r) => r[key] || 0));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row" title="${esc(label(r))}: ${esc(fmt(r[key] || 0))}">
    <span class="bar-label">${esc(label(r))}</span>
    <span class="bar-track"><i style="width:${Math.round(100 * (r[key] || 0) / max)}%"></i></span>
    <span class="bar-val mono">${esc(fmt(r[key] || 0))}</span></div>`).join("")}</div>`;
}

export async function render(ctx) {
  ctx.setTitle("Statistics");
  $("#view").innerHTML = `<div id="streaks" class="center">Loading…</div><div id="model-stats"></div>`;
  paintStreaks($("#streaks"));
  paintStats($("#model-stats"), 30);
}

async function paintStreaks(box) {
  let s;
  try { s = await api.get("/streaks"); } catch (e) { box.innerHTML = `<div class="center">Couldn't load streaks: ${esc(e.message)}</div>`; return; }
  box.innerHTML = `
    <div class="card streak-hero ${s.at_risk ? "at-risk" : ""}">
      <div class="streak-flame ${s.current_streak > 0 ? "lit" : ""}">🔥</div>
      <div class="streak-num mono">${s.current_streak}</div>
      <div class="streak-label">day streak${s.current_streak === 1 ? "" : "s"}</div>
      ${s.at_risk ? `<div class="streak-warn">⚠ No dump yet today — dump something to keep it alive.</div>`
        : s.current_streak === 0 ? `<div class="small muted" style="margin-top:6px">Dump today to start one.</div>` : ""}
    </div>
    <div class="tiles">
      <div class="tile"><div class="tile-v mono">${fmtInt(s.longest_streak)}</div><div class="tile-l">longest streak</div></div>
      <div class="tile"><div class="tile-v mono">${s.average_streak}</div><div class="tile-l">average streak</div></div>
      <div class="tile"><div class="tile-v mono">${fmtInt(s.active_days)}</div><div class="tile-l">days dumped</div></div>
      <div class="tile"><div class="tile-v mono">${fmtInt(s.total_streaks)}</div><div class="tile-l">streaks run</div></div>
    </div>
    <div class="card"><h2>Words dumped</h2>
      <div class="tiles">
        <div class="tile"><div class="tile-v mono">${fmtInt(s.words.week)}</div><div class="tile-l">this week</div></div>
        <div class="tile"><div class="tile-v mono">${fmtInt(s.words.month)}</div><div class="tile-l">this month</div></div>
        <div class="tile"><div class="tile-v mono">${fmtInt(s.words.year)}</div><div class="tile-l">this year</div></div>
        <div class="tile"><div class="tile-v mono">${fmtInt(s.words.alltime)}</div><div class="tile-l">all time</div></div>
      </div>
    </div>`;
}

async function paintStats(box, statsDays) {
  box.innerHTML = `<div class="center"><span class="spin"></span></div>`;
  const draw = async (days) => {
    let st;
    try { st = await api.get("/stats?days=" + days); } catch (e) { box.innerHTML = `<div class="center">Couldn't load stats: ${esc(e.message)}</div>`; return; }
    const range = [7, 30, 90].map((d) => `<button class="chip ${days === d ? "on" : ""}" data-days="${d}">${d} days</button>`).join("");
    const rate = st.success_rate == null ? "—" : Math.round(st.success_rate * 100) + "%";
    const cost = st.providers.reduce((a, p) => a + (p.est_cost_usd || 0), 0);
    box.innerHTML = `
      <div class="sec">Model activity</div>
      <div class="row" style="margin:0 0 14px">${range}<div class="grow"></div><span class="small muted">Estimates use list prices from the catalog; local models cost nothing.</span></div>
      <div class="tiles">
        <div class="tile"><div class="tile-v mono">${fmtInt(st.calls)}</div><div class="tile-l">model calls</div></div>
        <div class="tile"><div class="tile-v mono">${rate}</div><div class="tile-l">success rate</div></div>
        <div class="tile"><div class="tile-v mono">$${cost.toFixed(2)}</div><div class="tile-l">est. cloud cost</div></div>
        <div class="tile"><div class="tile-v mono">${fmtInt(st.total_dumps)}</div><div class="tile-l">dumps · ${fmtBytes(st.db_bytes)} vault</div></div>
      </div>
      <div class="card"><h2>Latency by stage <span class="small muted">(median · p90)</span></h2>
        ${st.stages.length ? bars(st.stages, "median_ms", (r) => r.stage, fmtMs) : `<p class="small muted">No model calls in this window.</p>`}
        ${st.stages.length ? `<table class="stat-table"><tr><th>stage</th><th>calls</th><th>ok</th><th>median</th><th>p90</th></tr>
          ${st.stages.map((r) => `<tr><td>${esc(r.stage)}</td><td class="mono">${r.calls}</td><td class="mono">${Math.round(r.success_rate * 100)}%</td><td class="mono">${fmtMs(r.median_ms)}</td><td class="mono">${fmtMs(r.p90_ms)}</td></tr>`).join("")}</table>` : ""}
      </div>
      <div class="card"><h2>Tokens by provider</h2>
        ${st.providers.length ? bars(st.providers, "prompt_tokens", (r) => `${r.provider}/${r.model}${r.local ? " (on-device)" : ""}`) : `<p class="small muted">Nothing yet.</p>`}
        ${st.providers.length ? `<table class="stat-table"><tr><th>provider / model</th><th>calls</th><th>ok</th><th>in</th><th>out</th><th>median</th><th>est. cost</th></tr>
          ${st.providers.map((r) => `<tr><td>${esc(r.provider)}/${esc(r.model)}</td><td class="mono">${r.calls}</td><td class="mono">${Math.round(r.success_rate * 100)}%</td><td class="mono">${fmtInt(r.prompt_tokens)}</td><td class="mono">${fmtInt(r.completion_tokens)}</td><td class="mono">${fmtMs(r.median_ms)}</td><td class="mono">${r.local ? "free" : r.est_cost_usd == null ? "—" : "$" + r.est_cost_usd.toFixed(3)}</td></tr>`).join("")}</table>` : ""}
      </div>
      <div class="card"><h2>Dumps per day</h2>
        ${st.dumps_per_day.length ? bars(st.dumps_per_day.slice(-30), "dumps", (r) => r.date.slice(5)) : `<p class="small muted">No dumps in this window.</p>`}
      </div>
      <div class="card"><h2>Vault growth</h2>
        ${st.growth.length ? bars(st.growth.slice(-30), "db_bytes", (r) => r.date.slice(5), fmtBytes) : `<p class="small muted">Sampled once a day at launch — check back tomorrow.</p>`}
      </div>`;
    $$("[data-days]", box).forEach((b) => b.onclick = () => draw(+b.dataset.days));
  };
  draw(statsDays);
}
