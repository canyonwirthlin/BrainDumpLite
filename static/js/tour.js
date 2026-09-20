// The first-run tour: a replica of the app you can poke at. Every scene is a small,
// self-contained simulation built from the app's own CSS classes and hard-coded demo
// data — nothing here calls the API, so the tour never creates dumps, tasks or history.
import { $, $$, esc, ICONS, MODES, modeOf, STAGES, kindBadge } from "./ui.js";
import { NAV } from "./shell.js";

// ── Demo data ────────────────────────────────────────────────────────────────
const DUMPS = [
  { id: "d1", title: "Career pivot anxiety", when: "Today · 9:12 AM", mode: "therapy", tone: "😬 anxious",
    clean: "I keep going back and forth on the internship applications. I've drafted two cover letters but haven't sent either, and I told Sam they'd be out by Friday. Meanwhile the home lab is fun, but it's eating my evenings.",
    points: ["Nervous about sending the internship applications", "Promised Sam they'd go out by Friday", "Home lab is fun but taking too many evenings"],
    items: [["task", "Send the two internship applications", "Fri"], ["concern", "The home lab is eating my evenings"], ["idea", "Timebox the home lab to weekends"]],
    concepts: ["internships", "home lab"], people: ["Sam"] },
  { id: "d2", title: "Weekend reset plan", when: "Yesterday · 6:40 PM", mode: "execution", tone: "🌿 calm",
    clean: "Need to do laundry, call the dentist to book a cleaning, and finish the report before Monday. Would be nice to get a hike in on Sunday.",
    points: ["Chores and the dentist call are the priority", "Report is due Monday", "A Sunday hike would be a good reward"],
    items: [["task", "Call the dentist to book a cleaning"], ["task", "Finish the report", "Mon"], ["event", "Sunday hike"]],
    concepts: ["report", "hiking"], people: [] },
  { id: "d3", title: "App idea: streak garden", when: "Sep 14 · 11:05 PM", mode: "brainstorm", tone: "⚡ excited",
    clean: "What if streaks grew a little garden instead of a flame? Each day you dump, a plant grows; miss a day and it wilts but doesn't die. Could pair with the internship search as a daily habit.",
    points: ["Streaks as a growing garden instead of a flame", "Missed days wilt a plant rather than reset it", "Could double as a habit for the internship search"],
    items: [["idea", "Streak garden: a plant grows for each day you dump"], ["idea", "Wilt instead of reset on a missed day"]],
    concepts: ["streaks", "internships"], people: [] },
];

const TASKS = [
  { id: "t1", text: "Send the two internship applications", due: "overdue", label: "Yesterday" },
  { id: "t2", text: "Call the dentist to book a cleaning", due: "today", label: "Today" },
  { id: "t3", text: "Finish the report", due: "upcoming", label: "Mon" },
  { id: "t4", text: "Timebox the home lab to weekends", due: "someday", label: "" },
  { id: "t5", text: "Renew the gym membership", due: "someday", label: "" },
  { id: "t6", text: "Book flights for the reunion", due: "done", label: "" },
];

const kindsIn = (list) => list.map(([k, c, due]) => ({ k, c, due }));

// ── Small builders shared by scenes ──────────────────────────────────────────
const itemRow = ({ k, c, due }) => `<div class="item"><span class="t-kind">${kindBadge(k)}</span>
  <div class="body"><div class="content">${esc(c)}${due ? ` <span class="chip due">⏰ ${esc(due)}</span>` : ""}</div></div>
  <button class="iconbtn edit" data-t="edit" title="Edit">✎</button>
  <button class="iconbtn ok" data-t="ok" title="Keep">✓</button><button class="iconbtn no" data-t="no" title="Reject">✕</button></div>`;
const demoNote = (t) => `<p class="t-demo">${t}</p>`;

// ── Scenes (same order as the rail) ──────────────────────────────────────────
const SCENES = {
  capture: {
    title: "Capture — get it all out",
    blurb: "Pick a mode, then just talk or type. Each mode is a different kind of place: a free page, a checklist, or a live chat.",
    tip: "Click the modes to see how each one changes, then run the demo.",
    mount(view, t) {
      let mode = "freeform";
      view.innerHTML = `<div class="capture" id="t-cap"><div class="modes">${MODES.map((m) => `<button class="mode-chip" data-mode="${m.id}" style="--mode:${m.color}">${m.icon} ${m.label}</button>`).join("")}</div>
        <div class="mode-info" id="t-mi"></div><div id="t-body"></div></div>`;
      const SAMPLE = { freeform: "ok so the internship thing is stressing me out, I keep putting off the applications and also need to call the dentist and the report is due monday…",
        execution: "call the dentist Friday\nfinish the report by Monday\nsend internship application" };
      const REPLY = { brainstorm: "Ooh — what if the streak was a garden? A plant grows each day you dump. What would a missed day do to it?",
        therapy: "That sounds like a lot to carry. It seems part of you wants to send them and part of you is afraid of the answer. What do you think you're most afraid of?" };
      const USER = { brainstorm: "I want streaks to feel less stressful somehow", therapy: "I'm stressed about my internship applications" };
      const paint = () => {
        t.clear();
        const m = modeOf(mode), cap = $("#t-cap", view);
        cap.style.setProperty("--mode", m.color);
        $$(".mode-chip", view).forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
        $("#t-mi", view).innerHTML = `<div class="mi-art">${m.art}</div><div><b>${m.icon} ${esc(m.label)}</b><p>${esc(m.about)}</p><span class="mi-how">${esc(m.how)}</span></div>`;
        if (m.chat) {
          $("#t-body", view).innerHTML = `<div class="chatbox"><div class="cb-thread" id="t-thread"><div class="bubble assistant">${esc(m.opener)}</div></div>
            <div class="cb-composer"><div class="row" style="margin:0"><span class="small muted">"${esc(USER[mode])}"</span><div class="grow"></div><button class="btn" id="t-go">Try it →</button></div></div></div>${demoNote("Demo only — the real chat is answered live by your AI.")}`;
          $("#t-go", view).onclick = () => {
            const th = $("#t-thread", view);
            $("#t-go", view).disabled = true;
            th.insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(USER[mode])}</div><div class="bubble assistant streaming" id="t-live"></div>`);
            let i = 0;
            const type = () => { const live = $("#t-live", view); if (!live) return; live.textContent = REPLY[mode].slice(0, i += 3); if (i < REPLY[mode].length) t.later(type, 22); else live.classList.remove("streaming"); };
            t.later(type, 400);
          };
        } else {
          $("#t-body", view).innerHTML = `<textarea class="editor ${mode === "execution" ? "tasklist" : ""}" id="t-text" rows="4">${esc(SAMPLE[mode])}</textarea>
            <div class="row"><div class="grow"></div><button class="btn" id="t-go">Dump it →</button></div><div id="t-out"></div>${demoNote("Demo only — nothing is saved.")}`;
          $("#t-go", view).onclick = () => runDemoDump(view, t, mode);
        }
      };
      $$(".mode-chip", view).forEach((b) => b.onclick = () => { mode = b.dataset.mode; paint(); });
      paint();
    },
  },

  graph: {
    title: "Graph — see how your thoughts connect",
    blurb: "Every dump, concept and person becomes a node. Dumps that share a topic — or a person — pull together.",
    tip: "Hover a node to light up its neighbours, click it for details, and drag the Spacing slider.",
    mount(view) {
      const N = [["d1", "Career pivot", "dump", 250, 60], ["d2", "Weekend plan", "dump", 120, 190], ["d3", "Streak garden", "dump", 400, 190],
        ["c1", "internships", "concept", 330, 120], ["c2", "home lab", "concept", 170, 100], ["c3", "hiking", "concept", 60, 250],
        ["p1", "Sam", "person", 250, 200]];
      const E = [["d1", "c1"], ["d3", "c1"], ["d1", "c2"], ["d1", "p1"], ["d2", "c3"], ["d2", "p1"], ["d1", "d3", "sim"]];
      view.innerHTML = `<div class="t-graph-bar"><span class="small muted">Nodes: <b style="color:var(--accent)">●</b> dumps <b style="color:var(--amber)">●</b> concepts <b style="color:#60a5fa">●</b> people</span>
        <label class="graph-spacing"><span>Spacing</span><input type="range" id="t-sp" min="0.6" max="1.8" step="0.05" value="1"><output id="t-spv">1.0×</output></label></div>
        <svg viewBox="0 0 500 300" class="t-graph" id="t-svg"></svg><div class="card t-info" id="t-info"><span class="small muted">Click a node.</span></div>`;
      const col = { dump: "var(--accent)", concept: "var(--amber)", person: "#60a5fa" };
      let sp = 1, sel = null, hov = null;
      const pos = (n) => [250 + (n[3] - 250) * sp, 150 + (n[4] - 150) * sp];
      const draw = () => {
        const at = hov || sel, near = new Set(at ? [at, ...E.filter((e) => e.includes(at)).flat()] : []);
        $("#t-svg", view).innerHTML = E.map(([a, b, k]) => { const A = pos(N.find((n) => n[0] === a)), B = pos(N.find((n) => n[0] === b));
            return `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" stroke="var(--dim)" stroke-dasharray="${k ? "4 3" : ""}" opacity="${at && !(near.has(a) && near.has(b)) ? .08 : .4}"/>`; }).join("")
          + N.map((n) => { const [x, y] = pos(n); const dim = at && !near.has(n[0]);
            return `<g data-n="${n[0]}" class="t-node" opacity="${dim ? .25 : 1}"><circle cx="${x}" cy="${y}" r="${n[2] === "dump" ? 9 : 7}" fill="${col[n[2]]}" ${n[0] === sel ? 'stroke="var(--text)" stroke-width="2"' : ""}/>
              <text x="${x + 13}" y="${y + 4}" fill="var(--text)" font-size="11">${esc(n[1])}</text></g>`; }).join("");
        $$(".t-node", view).forEach((g) => {
          g.onmouseenter = () => { hov = g.dataset.n; draw(); };
          g.onmouseleave = () => { hov = null; draw(); };
          g.onclick = () => { sel = g.dataset.n; const n = N.find((x) => x[0] === sel), links = E.filter((e) => e.includes(sel)).map((e) => N.find((x) => x[0] === e.find((i) => i !== sel))[1]);
            $("#t-info", view).innerHTML = `<b>${esc(n[1])}</b> <span class="small muted">${n[2]} · connected to ${links.length} node${links.length === 1 ? "" : "s"}: ${esc(links.join(", "))}</span>`; draw(); };
        });
      };
      $("#t-sp", view).oninput = (e) => { sp = parseFloat(e.target.value); $("#t-spv", view).textContent = sp.toFixed(1) + "×"; draw(); };
      draw();
    },
  },

  search: {
    title: "Search — find it by words or meaning",
    blurb: "Search looks through every dump and item. It also matches by meaning when the AI's embeddings are on, so you don't need the exact words.",
    tip: "Type a word — try “internship”, “dentist” or “garden”.",
    mount(view) {
      view.innerHTML = `<input type="text" id="t-q" class="t-search" placeholder="Search your dumps…" value="internship" autocomplete="off"><div id="t-res"></div>`;
      const paint = () => {
        const q = $("#t-q", view).value.trim().toLowerCase();
        const hits = q ? DUMPS.filter((d) => (d.title + " " + d.clean + " " + d.items.map((i) => i[1]).join(" ")).toLowerCase().includes(q)) : [];
        $("#t-res", view).innerHTML = hits.length ? hits.map((d) => {
          const i = d.clean.toLowerCase().indexOf(q), snip = i < 0 ? d.clean.slice(0, 90) : d.clean.slice(Math.max(0, i - 40), i + 70);
          const hl = esc(snip).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (m) => `<mark>${m}</mark>`);
          return `<div class="card"><b>${esc(d.title)}</b> <span class="small muted">${d.when}</span><p class="small" style="margin-top:4px">…${hl}…</p></div>`; }).join("")
          : `<div class="center small">${q ? "No dumps match." : "Type to search."}</div>`;
      };
      $("#t-q", view).oninput = paint;
      paint();
    },
  },

  history: {
    title: "History — everything you've dumped",
    blurb: "Every dump, newest first. Open one to see the cleaned-up transcript with its key points beneath it, the items the AI pulled out, and its concepts, people and linked dumps. All of it is editable.",
    tip: "Click a dump, then try ✎ on the title or an item, ✓ / ✕ on items, or × on a concept.",
    mount(view) {
      let cur = 0;
      view.innerHTML = `<div class="t-split"><div class="master" id="t-list"></div><div class="detail" id="t-detail"></div></div>`;
      const list = () => { $("#t-list", view).innerHTML = DUMPS.map((d, i) => `<a class="drow ${i === cur ? "sel" : ""}" data-i="${i}" href="#"><b>${esc(d.title)}</b><div class="m"><span>${d.when}</span><span class="tag">${modeOf(d.mode).label}</span><span>${d.items.length} items</span></div></a>`).join("");
        $$(".drow", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); cur = +a.dataset.i; list(); detail(); }); };
      const detail = () => {
        const d = DUMPS[cur];
        $("#t-detail", view).innerHTML = `<h1 class="page title-row"><span id="t-title">${esc(d.title)}</span><button class="iconbtn edit" id="t-edit-title" style="opacity:1">✎</button></h1>
          <div class="meta"><span>${d.when}</span><span>${modeOf(d.mode).icon} ${modeOf(d.mode).label}</span><span>${d.tone}</span></div>
          <div class="card transcript"><h2>Cleaned transcript</h2><p class="transcript-text">${esc(d.clean)}</p>
            <h3 class="keypoints-h">Key points</h3><div class="md"><ul>${d.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div></div>
          <div class="card"><h2>Extracted items <span class="muted small">(✓ keep · ✕ reject · ✎ edit)</span></h2>${kindsIn(d.items).map(itemRow).join("")}</div>
          <div class="card"><h2>Concepts &amp; people</h2><div class="wl" id="t-tags">${d.concepts.map((c) => tag(c)).join("")}${d.people.map((p) => tag(p, "p")).join("")}</div></div>`;
        bindItems($("#t-detail", view));
        $("#t-tags", view).addEventListener("click", (e) => { if (e.target.dataset.x) e.target.closest(".wl-chip").remove(); });
        $("#t-edit-title", view).onclick = () => editInline($("#t-title", view));
      };
      const tag = (c, cls = "") => `<span class="wl-chip tag ${cls}">${cls === "p" ? "@" : ""}${esc(c)}<button class="tag-btn" data-x="1" style="opacity:1" title="Remove">×</button></span>`;
      list(); detail();
    },
  },

  today: {
    title: "Today — the day at a glance",
    blurb: "Today lines up what you dumped so far, with a quick-capture box on top for a fast thought between other things.",
    tip: "Tick an item off. Quick thoughts here are saved like any other dump — but not in this demo.",
    mount(view, t) {
      view.innerHTML = `<div class="card quick"><textarea class="editor" rows="2" placeholder="Quick thought… (Ctrl+Enter to save)"></textarea>
        <div class="row" style="margin-top:8px"><span class="small muted">Saved as a normal dump and processed like any other.</span><div class="grow"></div><button class="btn small" id="t-save">Save</button></div></div>
        <div class="card today-card"><div class="row" style="margin:0 0 6px"><span class="small muted mono">9:12 AM</span><b>Career pivot anxiety</b><span class="tag">🫂 Therapy</span></div>
          <div class="today-items">${DUMPS[0].items.map(([k, c]) => `<label class="mi">${kindBadge(k)} <input type="checkbox" class="t-chk"> <span>${esc(c)}</span></label>`).join("")}</div></div>${demoNote("Demo only — nothing is saved.")}`;
      $$(".t-chk", view).forEach((c) => c.onchange = () => c.closest(".mi").classList.toggle("done", c.checked));
      $("#t-save", view).onclick = () => { const b = $("#t-save", view); b.textContent = "Saved (demo)"; t.later(() => { b.textContent = "Save"; }, 1400); };
    },
  },

  tasks: {
    title: "Tasks — everything you've committed to",
    blurb: "Tasks collects every task from every dump. All shows what's still open; the other tabs slice it by due date, and Done keeps what you've finished.",
    tip: "Switch tabs, then tick a task to finish it.",
    mount(view) {
      const G = [["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["someday", "Someday"], ["done", "Done"]];
      const st = TASKS.map((x) => ({ ...x }));
      let g = "all";
      view.innerHTML = `<div class="t-split"><div class="master" id="t-groups"></div><div class="detail" id="t-tasks"></div></div>`;
      const paint = () => {
        const inG = (x, k) => k === "done" ? x.due === "done" : k === "all" ? x.due !== "done" : x.due === k;
        $("#t-groups", view).innerHTML = `<div class="glist">${G.map(([k, l]) => `<a href="#" class="grow-row ${k === g ? "on" : ""}" data-g="${k}"><span>${l}</span><span class="count">${st.filter((x) => inG(x, k)).length}</span></a>`).join("")}</div>`;
        const rows = st.filter((x) => inG(x, g));
        $("#t-tasks", view).innerHTML = `<h1 class="page">${G.find(([k]) => k === g)[1]}</h1>` + (rows.length ? `<div class="card">${rows.map((x) => `<div class="task-row ${x.due === "done" ? "done" : ""}"><input type="checkbox" data-id="${x.id}" ${x.due === "done" ? "checked" : ""}>
          <div class="body grow"><span class="content">${esc(x.text)}</span> ${x.label ? `<span class="chip ${x.due === "overdue" ? "overdue" : "due"}">⏰ ${x.label}</span>` : ""}</div></div>`).join("")}</div>` : `<div class="center"><div class="big">🧺</div>Nothing here.</div>`);
        $$("[data-g]", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); g = a.dataset.g; paint(); });
        $$("input[data-id]", view).forEach((c) => c.onchange = () => { const x = st.find((y) => y.id === c.dataset.id); x.due = c.checked ? "done" : "today"; x.label = ""; paint(); });
      };
      paint();
    },
  },

  inbox: {
    title: "Inbox — the AI proposes, you decide",
    blurb: "When a dump mentions something that belongs in your calendar or Todoist, it waits here as a suggestion. Nothing is pushed anywhere until you accept it.",
    tip: "Accept one and dismiss the other.",
    mount(view) {
      const S = [["📅", "Add to Google Calendar", "Dentist cleaning — Fri 3:00 PM"], ["✅", "Add to Todoist", "Send the two internship applications — due Fri"]];
      view.innerHTML = S.map(([ic, kind, title], i) => `<div class="card" data-s="${i}"><div class="row" style="margin:0"><span style="font-size:20px">${ic}</span><div class="grow"><b>${esc(title)}</b><div class="small muted">${kind} · from “${DUMPS[i].title}”</div></div>
        <button class="btn ghost small" data-a="no">Dismiss</button><button class="btn small" data-a="ok">Accept</button></div></div>`).join("") + demoNote("Demo only — the real Inbox needs Google Calendar or Todoist connected in Settings.");
      $$("[data-a]", view).forEach((b) => b.onclick = () => { const c = b.closest(".card"); c.innerHTML = `<span class="small muted">${b.dataset.a === "ok" ? "✓ Accepted — it would be sent now." : "Dismissed."}</span>`; });
    },
  },

  reflect: {
    title: "Reflect — a look back",
    blurb: "Reflect reads your recent dumps and writes a short daily or weekly summary: what you kept coming back to, and how you were feeling.",
    tip: "Generate the sample weekly reflection.",
    mount(view, t) {
      view.innerHTML = `<div class="card"><h2>This week</h2><div id="t-ref"><p class="small muted">Nothing generated yet.</p></div><div class="row"><button class="btn small" id="t-gen">Generate weekly reflection</button></div></div>${demoNote("Demo only — the real one is written by your AI from your actual dumps.")}`;
      $("#t-gen", view).onclick = () => { $("#t-ref", view).innerHTML = `<p class="small muted">Thinking…</p>`; t.later(() => {
        $("#t-ref", view).innerHTML = `<div class="md"><p>You kept returning to the <b>internship applications</b> — three dumps this week, mostly anxious in tone. The pattern: you draft, then hold back.</p><ul><li>Your calmest dump was the weekend plan.</li><li>The home lab is giving you energy <i>and</i> costing you evenings.</li></ul></div>`; }, 900); };
    },
  },

  stats: {
    title: "Statistics — your streak and habits",
    blurb: "Dump once a day to keep the streak alive; miss a full day and it resets. Below it: longest and average streak, words dumped, and where your AI calls go.",
    tip: "Click a day to see what the streak looked like.",
    mount(view) {
      const days = ["M", "T", "W", "T", "F", "S", "S"];
      view.innerHTML = `<div class="card streak-hero"><div class="streak-flame lit">🔥</div><div class="streak-num" id="t-n">4</div><div class="streak-label">day streak</div></div>
        <div class="card"><div class="row" style="margin:0;gap:10px;justify-content:center">${days.map((d, i) => `<button class="chip ${i < 4 ? "on" : ""}" data-i="${i}" style="width:38px;height:38px;border-radius:50%">${d}</button>`).join("")}</div>
          <p class="small muted" id="t-sd" style="text-align:center;margin:10px 0 0">Click a day.</p></div>
        <div class="card"><div class="row" style="margin:0;justify-content:space-around;text-align:center"><div><b>9</b><div class="small muted">longest</div></div><div><b>1,840</b><div class="small muted">words this week</div></div><div><b>31</b><div class="small muted">days dumped</div></div></div></div>`;
      $$("[data-i]", view).forEach((b) => b.onclick = () => { const i = +b.dataset.i; $("#t-n", view).textContent = i < 4 ? i + 1 : 0;
        $("#t-sd", view).textContent = i < 4 ? `You had dumped ${i + 1} day${i ? "s" : ""} in a row by then.` : "A day with no dump — the streak would have reset here."; });
    },
  },

  settings: {
    title: "Settings — make it yours",
    blurb: "Switch AI providers, customise what gets extracted, pick a theme, connect integrations, and manage your data. This tutorial lives in Settings → About if you ever want it again.",
    tip: "Click a section to see what's in it.",
    mount(view) {
      const S = { AI: "Pick Gemini, the built-in local model, your own server, Claude or OpenAI — and add your own item types.", Voice: "Turn on the mic button and choose the speech model.",
        Data: "Vault location, backups, markdown export/import, Git mirror, app lock — plus opening at startup and streak reminders.",
        Integrations: "Connect Google Calendar and Todoist so the Inbox can send things there.", Appearance: "Themes, density and motion — or design your own theme colour by colour.",
        About: "Version, what's new, and “Replay tutorial” to see this tour again." };
      view.innerHTML = `<div class="t-split"><div class="master"><div class="glist">${Object.keys(S).map((k, i) => `<a href="#" class="grow-row ${i === 0 ? "on" : ""}" data-k="${k}"><span>${k}</span></a>`).join("")}</div></div>
        <div class="detail"><h1 class="page" id="t-sh">AI</h1><div class="card"><p id="t-sp2">${esc(S.AI)}</p></div></div></div>`;
      $$("[data-k]", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); $$("[data-k]", view).forEach((x) => x.classList.toggle("on", x === a));
        $("#t-sh", view).textContent = a.dataset.k; $("#t-sp2", view).textContent = S[a.dataset.k]; });
    },
  },
};

// ── Scene helpers ────────────────────────────────────────────────────────────
function runDemoDump(view, t, mode) {
  const out = $("#t-out", view), btn = $("#t-go", view);
  btn.disabled = true;
  const draw = (i) => {
    out.innerHTML = `<div class="card"><div class="stages">${STAGES.map(([, label], n) => `<div class="stage ${n < i ? "done" : ""} ${n === i ? "now" : ""}"><div class="dot">${n < i ? "✓" : n === i ? '<span class="spin"></span>' : ""}</div>${label}</div>`).join("")}</div></div>`;
  };
  let i = 0;
  const step = () => {
    if (i < STAGES.length) { draw(i++); t.later(step, 650); return; }
    const d = mode === "execution" ? DUMPS[1] : DUMPS[0];
    out.innerHTML = `<div class="card transcript"><h2>${esc(d.title)}</h2><h3 class="keypoints-h" style="border:0;padding:0;margin:0 0 6px">Cleaned transcript</h3><p class="transcript-text">${esc(d.clean)}</p>
      <h3 class="keypoints-h">Key points</h3><div class="md"><ul>${d.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div></div>
      <div class="card"><h2>Extracted items</h2>${kindsIn(d.items).map(itemRow).join("")}</div>`;
    bindItems(out);
    btn.disabled = false; btn.textContent = "Run it again";
  };
  step();
}

// ✓ / ✕ / ✎ on demo item rows: purely local, the same look as the real rows.
function bindItems(box) {
  $$(".item", box).forEach((el) => {
    const ok = $(".ok", el), no = $(".no", el);
    ok.onclick = () => { ok.classList.toggle("active"); no.classList.remove("active"); el.classList.remove("rejected"); };
    no.onclick = () => { no.classList.toggle("active"); ok.classList.remove("active"); el.classList.toggle("rejected", no.classList.contains("active")); };
    $(".edit", el).onclick = () => { const c = $(".content", el); editInline(c.firstChild.nodeType === 3 ? wrapText(c) : c); };
  });
}
const wrapText = (c) => { const s = document.createElement("span"); s.textContent = c.firstChild.textContent; c.replaceChild(s, c.firstChild); return s; };

function editInline(span) {
  const input = Object.assign(document.createElement("input"), { type: "text", value: span.textContent.trim(), className: "t-inline" });
  span.replaceWith(input); input.focus(); input.select();
  const done = () => { span.textContent = input.value.trim() || span.textContent; input.replaceWith(span); };
  input.onblur = done; input.onkeydown = (e) => { if (e.key === "Enter" || e.key === "Escape") input.blur(); };
}

// ── Driver ───────────────────────────────────────────────────────────────────
// runTour(el, finish): draws the tour into el; finish() is called on Skip / Get started.
export function runTour(el, finish, start = "capture") {
  const rail = [...NAV, { id: "settings", label: "Settings" }];
  const ids = rail.map((n) => n.id);
  let i = Math.max(0, ids.indexOf(start)), timers = [];
  const t = { later: (fn, ms) => timers.push(setTimeout(fn, ms)), clear: () => { timers.forEach(clearTimeout); timers = []; } };
  const draw = () => {
    t.clear();
    const id = ids[i], sc = SCENES[id], last = i === ids.length - 1;
    el.innerHTML = `<div class="tour">
      <button class="btn ghost small ob-skip" id="ob-skip">Skip tutorial</button>
      <div class="tour-head"><h1>${esc(sc.title)}</h1><p class="sub">${esc(sc.blurb)}</p></div>
      <div class="tour-app"><nav class="tour-rail">${rail.map((n) => `<a href="#" data-id="${n.id}" class="${n.id === id ? "active" : ""}" title="${n.label}">${ICONS[n.id]}<span>${n.label}</span></a>`).join("")}</nav>
        <div class="tour-view" id="tour-view"></div></div>
      <p class="tour-tip">👆 ${esc(sc.tip)}</p>
      <div class="ob-dots">${ids.map((_, n) => `<i class="${n === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="ob-foot"><button class="btn ghost" id="ob-back" ${i === 0 ? "disabled" : ""}>Back</button><div class="grow"></div>
        <button class="btn" id="ob-next">${last ? "Get started" : "Next"}</button></div></div>`;
    sc.mount($("#tour-view", el), t);
    $("#ob-skip", el).onclick = () => { t.clear(); finish(); };
    $("#ob-back", el).onclick = () => { i = Math.max(0, i - 1); draw(); };
    $("#ob-next", el).onclick = () => { if (last) { t.clear(); finish(); } else { i++; draw(); } };
    $$(".tour-rail a", el).forEach((a) => a.onclick = (e) => { e.preventDefault(); i = ids.indexOf(a.dataset.id); draw(); });
  };
  draw();
}
