// The tutorial's mock screens (all but the Brain map and Templates, which have their own files). Every scene is a small,
// self-contained simulation built from the app's own CSS classes and hard-coded demo data: nothing here calls the API, so
// the tour never creates dumps, tasks or history. A scene is { mount(view, t) } where t = { later(fn, ms), clear() } is a
// timer bag the driver clears between cards; mount may return a cleanup function (for document listeners).
// The words on each card (title, blurb, tip) and the list of real-app things it mirrors are in tour-steps.js.
import { $, $$, esc, MODES, modeOf, STAGES, kindBadge } from "./ui.js";

// ── Demo data ────────────────────────────────────────────────────────────────
export const DUMPS = [
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
  { id: "t4", text: "Renew the gym membership", due: "someday", label: "" },
  { id: "t5", text: "Book flights for the reunion", due: "done", label: "" },
];

const kindsIn = (list) => list.map(([k, c, due]) => ({ k, c, due }));
const itemRow = ({ k, c, due }) => `<div class="item"><span class="t-kind">${kindBadge(k)}</span>
  <div class="body"><div class="content">${esc(c)}${due ? ` <span class="chip due">⏰ ${esc(due)}</span>` : ""}</div></div>
  <button class="iconbtn edit" data-t="edit" title="Edit">✎</button>
  <button class="iconbtn ok" data-t="ok" title="Keep">✓</button><button class="iconbtn no" data-t="no" title="Reject">✕</button></div>`;
export const demoNote = (t) => `<p class="t-demo">${t}</p>`;

// ── Scenes ───────────────────────────────────────────────────────────────────
export const SCENES = {
  capture: {
    mount(view, t) {
      let mode = "freeform";
      view.innerHTML = `<div class="capture" id="t-cap"><div class="modes">${MODES.map((m) => `<button class="mode-chip" data-mode="${m.id}" style="--mode:${m.color}">${m.icon} ${m.label}</button>`).join("")}</div>
        <div class="mode-info" id="t-mi"></div><div id="t-body"></div></div>`;
      const SAMPLE = { freeform: "ok so the internship thing is stressing me out, I keep putting off the applications and also need to call the dentist and the report is due monday…",
        execution: "call the dentist Friday\nfinish the report by Monday\nsend internship application" };
      const REPLY = { brainstorm: "Ooh, what if the streak was a garden? A plant grows each day you dump. What would a missed day do to it?",
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
            <div class="cb-composer"><div class="row" style="margin:0"><span class="small muted">"${esc(USER[mode])}"</span><div class="grow"></div><button class="btn" id="t-go">Start talking →</button></div></div></div>${demoNote("Demo only. The real chat is answered live by your AI.")}`;
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
            <div class="row"><div class="grow"></div><button class="btn" id="t-go">Dump it →</button></div><div id="t-out"></div>${demoNote("Demo only. Nothing is saved.")}`;
          $("#t-go", view).onclick = () => runDemoDump(view, t, mode);
        }
      };
      $$(".mode-chip", view).forEach((b) => b.onclick = () => { mode = b.dataset.mode; paint(); });
      paint();
    },
  },

  "capture-extras": {
    mount(view) {
      view.innerHTML = `<div class="capture"><textarea class="editor" rows="3" id="t-text" placeholder="Type, paste, or hit the mic and just talk…"></textarea>
        <div class="row"><button class="mic" id="t-mic" title="Record voice">🎙️</button><span class="muted small" id="t-rec"></span><div class="grow"></div>
          <label class="muted small"><input type="checkbox" id="t-priv"> 🔒 Private</label><button class="btn" disabled>Dump it →</button></div>
        <div class="card t-explain" id="t-ex"></div>
        <div class="card t-explain"><b>Short is fine.</b> <span class="small muted">A few words, like “cancel gym”, are kept exactly as you typed them. The AI won't pad a tiny dump into an essay, and a very short one skips the tidy-up step.</span></div>
        ${demoNote("Demo only. The mic and the Private switch here do nothing real.")}</div>`;
      const ex = (h, b) => { $("#t-ex", view).innerHTML = `<b>${h}</b> <span class="small muted">${b}</span>`; };
      ex("Talk instead of typing.", "Press the mic, speak, press it again and your words land in the box. It uses a small voice model on this PC, so audio never leaves your machine. Pick the model in Settings → Voice. No mic button? Voice typing isn't available on this PC.");
      let rec = false, tick = null;
      $("#t-mic", view).onclick = () => {
        rec = !rec; $("#t-mic", view).classList.toggle("rec", rec); clearInterval(tick);
        if (rec) { let s = 0; $("#t-rec", view).textContent = "Recording 0:00. Click to stop"; tick = setInterval(() => { s++; const el = $("#t-rec", view); if (el) el.textContent = `Recording 0:${String(s).padStart(2, "0")}. Click to stop`; }, 1000); }
        else $("#t-rec", view).textContent = "Transcribing…";
        if (!rec) setTimeout(() => { const ta = $("#t-text", view); if (ta) { ta.value = "remind me to call the dentist on friday"; $("#t-rec", view).textContent = ""; } }, 700);
      };
      $("#t-priv", view).onchange = (e) => ex(e.target.checked ? "Private dump." : "Private is off.", e.target.checked
        ? "It stays out of Search, Ask, exports and the Obsidian mirror. You need your PIN to turn Private on or off." : "A normal dump shows up everywhere. Tick Private on the dumps you want to keep to yourself.");
      return () => clearInterval(tick);
    },
  },

  "capture-shortcuts": {
    mount(view) {
      const K = [[["Ctrl", "Enter"], "Dump what's in the box", "Capture"], [["Ctrl", "N"], "Start a new dump from anywhere in the app", "Anywhere in the app"],
        [["Ctrl", "K"], "Open the command palette: jump to any screen or setting, switch theme, find a recent dump", "Anywhere in the app"],
        [["Ctrl", "Shift", "Space"], "A tiny capture box pops up over whatever you're doing. Type, press Ctrl+Enter, done. It works even when this window is hidden in the tray.", "From any program · desktop app"]];
      view.innerHTML = `<div class="t-keys">${K.map(([keys, what, where], i) => `<div class="card t-key ${i === 3 ? "hot" : ""}"><div class="t-keycaps">${keys.map((k) => `<kbd>${k}</kbd>`).join("+")}</div>
        <div><div>${esc(what)}</div><div class="small muted">${where}</div></div></div>`).join("")}</div>
        <p class="small muted" style="margin-top:12px">You can switch the from-anywhere key off in Settings → Data.</p>`;
    },
  },

  search: {
    mount(view) {
      let saved = false;
      view.innerHTML = `<div class="row" style="margin:0 0 12px"><input type="text" id="t-q" class="topbar-input grow" placeholder="a name, a topic, a half-remembered phrase…" value="internship" autocomplete="off"><button class="btn small" id="t-go">Search</button></div><div id="t-res"></div>`;
      const paint = () => {
        const q = $("#t-q", view).value.trim().toLowerCase();
        const hits = q ? DUMPS.filter((d) => (d.title + " " + d.clean + " " + d.items.map((i) => i[1]).join(" ")).toLowerCase().includes(q)) : [];
        if (!q) { $("#t-res", view).innerHTML = `<div class="center small"><div class="big">🔍</div>Search above, or pick a type to browse it.</div>`; return; }
        const ents = [...new Set(hits.flatMap((d) => [...d.concepts.filter((c) => c.toLowerCase().includes(q)).map((c) => "💡 " + c), ...d.people.filter((p) => p.toLowerCase().includes(q)).map((p) => "🧑 " + p)]))];
        $("#t-res", view).innerHTML = `<h1 class="page">Results for “${esc($("#t-q", view).value.trim())}” <button class="btn ghost small" id="t-save">${saved ? "★ Saved" : "☆ Save search"}</button></h1>
          ${ents.length ? `<div class="ent-strip">${ents.map((e) => `<span class="chip ent">${esc(e)}</span>`).join("")}</div>` : ""}
          ${hits.length ? hits.map((d) => {
            const i = d.clean.toLowerCase().indexOf(q), snip = i < 0 ? d.clean.slice(0, 90) : d.clean.slice(Math.max(0, i - 40), i + 70);
            const hl = esc(snip).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (m) => `<mark>${m}</mark>`);
            return `<div class="card"><b>${esc(d.title)}</b> <span class="small muted">${d.when}</span><p class="small" style="margin-top:4px">…${hl}…</p></div>`; }).join("")
            : `<div class="center small">No dumps match.</div>`}
          ${saved ? `<div class="card"><div class="small muted" style="margin-bottom:6px">★ Saved searches</div><span class="chip">${esc($("#t-q", view).value.trim())}</span> <span class="small muted">now one click away on the Search page</span></div>` : ""}`;
        $("#t-save", view).onclick = () => { saved = !saved; paint(); };
      };
      $("#t-q", view).oninput = () => { saved = false; paint(); };
      $("#t-q", view).onkeydown = (e) => { if (e.key === "Enter") paint(); };
      $("#t-go", view).onclick = paint;
      paint();
    },
  },

  "search-browse": {
    mount(view) {
      const TYPES = [["person", "People", "var(--accent-2)", [["Sam", 3], ["Priya", 2], ["Mom", 1]]], ["concept", "Concepts", "var(--amber)", [["internships", 4], ["home lab", 3], ["report", 2], ["hiking", 2], ["streaks", 1]], 1],
        ["task", "✅ Task", "var(--accent)"], ["goal", "🎯 Goal", "var(--green)"], ["idea", "💡 Idea", "var(--amber)"]];
      const COUNT = { task: 14, goal: 4, idea: 9 };
      let cur = "person";
      view.innerHTML = `<div class="t-split"><div class="master"><div class="glist"><div class="glist-sep" style="margin-top:0">Browse</div><div id="t-bt"></div></div>
        <div class="small muted" style="padding:12px 16px">Pick a type to see everything of that kind, and how often each appears across your dumps.</div></div><div class="detail" id="t-bd"></div></div>`;
      const paint = () => {
        $("#t-bt", view).innerHTML = TYPES.map(([id, label, color, list, dup]) => `<a href="#" class="grow-row ${id === cur ? "on" : ""}" data-t="${id}"><span><i class="legend-dot" style="background:${color}"></i> ${label}</span>
          <span class="count">${dup ? `<span class="chip due" title="Likely duplicates">⚠ ${dup}</span> ` : ""}${list ? list.reduce((a, x) => a + x[1], 0) : COUNT[id]}</span></a>`).join("");
        const T = TYPES.find((x) => x[0] === cur);
        $("#t-bd", view).innerHTML = `<h1 class="page">${T[1]}</h1>` + (T[3]
          ? `<p class="sub">${cur === "person" ? "Everyone you've mentioned." : "Topics that keep coming up. A warning badge means two names look like the same thing."}</p><div class="card">${T[3].map(([n, c]) => `<div class="row" style="margin:0;padding:6px 0"><span class="grow">${cur === "person" ? "🧑" : "💡"} ${esc(n)}</span><span class="small muted">${c}×</span></div>`).join("")}</div>
            ${T[4] ? `<p class="small muted" style="margin-top:8px">⚠ “internships” and “internship” look alike. Scan for duplicates to merge them.</p>` : ""}`
          : `<p class="sub">Every ${T[1].replace(/^\S+ /, "").toLowerCase()} from your dumps, in one list.</p>`);
        $$("[data-t]", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); cur = a.dataset.t; paint(); });
      };
      paint();
    },
  },

  ask: {
    mount(view, t) {
      view.innerHTML = `<h1 class="page">Ask your brain</h1><p class="sub">Questions answered only from your own dumps, with the sources cited.</p>
        <div id="t-log" style="display:grid;gap:10px;margin:14px 0"></div>
        <div style="display:flex;gap:8px"><input type="text" id="t-aq" class="topbar-input" style="flex:1" value="What did I decide about the dentist?" autocomplete="off"><button class="btn" id="t-ask">Ask</button></div>
        ${demoNote("Demo only. The real answer is written by your AI, from your actual dumps.")}`;
      const ask = () => {
        const q = $("#t-aq", view).value.trim(); if (!q) return;
        $("#t-ask", view).disabled = true;
        $("#t-log", view).innerHTML = `<div class="card" style="margin-left:auto;max-width:80%">${esc(q)}</div><div class="center small muted">Thinking…</div>`;
        t.later(() => {
          $("#t-log", view).innerHTML = `<div class="card" style="margin-left:auto;max-width:80%">${esc(q)}</div>
            <div class="card"><div>You planned to call the dentist to book a cleaning <a class="chip cite" href="#">1</a>, and you wanted to do it before the report is due on Monday <a class="chip cite" href="#">2</a>.</div>
              <div class="small muted" style="margin:10px 0 4px">Sources</div>
              <div class="card click" style="margin:4px 0"><b>[1] Weekend reset plan</b> <span class="small muted">Yesterday</span><div class="small muted">Need to do laundry, call the dentist to book a cleaning…</div></div>
              <div class="card click" style="margin:4px 0"><b>[2] Weekend reset plan</b> <span class="small muted">Yesterday</span><div class="small muted">…finish the report before Monday.</div></div></div>`;
          $$(".cite", view).forEach((a) => a.onclick = (e) => e.preventDefault());
          $("#t-ask", view).disabled = false;
        }, 800);
      };
      $("#t-ask", view).onclick = ask;
      $("#t-aq", view).onkeydown = (e) => { if (e.key === "Enter") ask(); };
    },
  },

  history: {
    mount(view) {
      let cur = 0;
      let q = "";
      view.innerHTML = `<div class="t-split"><div class="master"><div style="padding:12px 14px 0"><input type="text" id="t-filter" class="topbar-input" style="width:100%" placeholder="Filter dumps…" autocomplete="off"></div>
        <div class="chips">${["All", "Freeform", "Brainstorm", "Therapy", "Execution"].map((l, i) => `<span class="chip ${i === 0 ? "on" : ""}">${l}</span>`).join("")}<span class="chip">🗑 Trash</span></div>
        <div id="t-list"></div></div><div class="detail" id="t-detail"></div></div>`;
      const list = () => { $("#t-list", view).innerHTML = DUMPS.map((d, i) => [d, i]).filter(([d]) => !q || d.title.toLowerCase().includes(q)).map(([d, i]) => `<a class="drow ${i === cur ? "sel" : ""}" data-i="${i}" href="#"><b>${esc(d.title)}</b><div class="m"><span>${d.when}</span><span class="tag">${modeOf(d.mode).label}</span><span>${d.items.length} items</span></div></a>`).join("") || `<div class="center small">No dumps match.</div>`;
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
      $("#t-filter", view).oninput = (e) => { q = e.target.value.trim().toLowerCase(); list(); };
      list(); detail();
    },
  },

  "history-manage": {
    mount(view) {
      const D = DUMPS[1], on = { pin: false, priv: false };
      let words = D.clean.split(" "), at = null, trashed = false;
      view.innerHTML = `<div class="t-detail-only"><h1 class="page">${esc(D.title)}</h1>
        <div class="row" style="margin:0 0 10px"><button class="btn ghost small" id="t-pin" aria-pressed="false">📍 Pin</button><button class="btn ghost small" id="t-priv" aria-pressed="false">🔓 Make private</button>
          <button class="btn ghost small" id="t-split">✂ Split…</button><button class="btn ghost small" id="t-merge">⛙ Merge with…</button><button class="btn ghost small danger" id="t-del">Delete</button></div>
        <div class="card" id="t-box"></div></div>`;
      const box = $("#t-box", view);
      const note = (h, b) => { box.innerHTML = `<b>${h}</b><p class="small muted" style="margin:4px 0 0">${b}</p>`; };
      const sync = () => { const p = $("#t-pin", view), q = $("#t-priv", view); p.textContent = on.pin ? "📌 Pinned" : "📍 Pin"; p.setAttribute("aria-pressed", on.pin); q.textContent = on.priv ? "🔒 Private" : "🔓 Make private"; q.setAttribute("aria-pressed", on.priv); };
      note("Pick a button.", "Each one changes how this dump behaves. Nothing here is saved.");
      $("#t-pin", view).onclick = () => { on.pin = !on.pin; sync(); note(on.pin ? "Pinned." : "Unpinned.", "A pinned dump keeps a 📌 and stays near the top of History."); };
      $("#t-priv", view).onclick = () => { on.priv = !on.priv; sync(); note(on.priv ? "Private." : "Not private.", on.priv ? "It disappears from Search, Ask, exports and the Obsidian mirror. You need your PIN to change this." : "It shows up everywhere again."); };
      const splitView = () => {
        box.innerHTML = `<b>Split this dump</b><p class="small muted" style="margin:4px 0 8px">Click a word where the second dump should start.</p>
          <p class="transcript-text" id="t-words">${words.map((w, i) => `<span class="t-w ${at != null && i >= at ? "second" : ""}" data-i="${i}">${esc(w)}</span>`).join(" ")}</p>
          ${at != null ? `<div class="row" style="margin-top:8px"><span class="small muted grow">Two dumps: the items follow whichever half they came from.</span></div>` : ""}`;
        $$(".t-w", box).forEach((s) => s.onclick = () => { at = +s.dataset.i || null; splitView(); });
      };
      $("#t-split", view).onclick = () => { at = null; splitView(); };
      $("#t-merge", view).onclick = () => { note("Merge with…", "Pick one or more other dumps to fold into this one. You can undo right after.");
        box.insertAdjacentHTML("beforeend", `<div class="row" style="margin-top:8px"><span class="chip">Career pivot anxiety</span><span class="chip">App idea: streak garden</span></div>`); };
      $("#t-del", view).onclick = () => { trashed = !trashed; note(trashed ? "Moved to Trash." : "Delete moves it to Trash.", "Nothing is gone yet. Open the 🗑 Trash chip above the History list for 30 days to Restore it or delete it for good."); };
    },
  },

  tasks: {
    mount(view) {
      const G = [["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["someday", "Someday"], ["snoozed", "Snoozed"], ["done", "Done"]];
      const NOT = [["goals", "Goals", 4], ["ideas", "Ideas", 9], ["habits", "Habits", 2]];
      const st = TASKS.map((x) => ({ ...x }));
      let g = "all";
      view.innerHTML = `<div class="t-split"><div class="master" id="t-groups"></div><div class="detail" id="t-tasks"></div></div>`;
      const inG = (x, k) => k === "done" ? x.due === "done" : k === "all" ? x.due !== "done" : k === "snoozed" ? false : x.due === k;
      const paint = () => {
        const row = ([k, l, n]) => `<a href="#" class="grow-row ${k === g ? "on" : ""}" data-g="${k}"><span>${l}</span><span class="count">${n ?? st.filter((x) => inG(x, k)).length}</span></a>`;
        $("#t-groups", view).innerHTML = `<div class="glist">${G.map(row).join("")}<div class="glist-sep">Not tasks</div>${NOT.map(row).join("")}</div>
          <div class="small muted" style="padding:12px 16px">Tasks are things you can finish. Ongoing aims and loose ideas are kept apart from them.</div>`;
        const label = [...G, ...NOT].find(([k]) => k === g)[1], isNot = NOT.some(([k]) => k === g);
        const rows = st.filter((x) => inG(x, g));
        $("#t-tasks", view).innerHTML = `<h1 class="page">${label}</h1>` + (isNot ? `<div class="center"><div class="big">${g === "goals" ? "🎯" : g === "ideas" ? "💡" : "🔁"}</div><span class="small muted">${g === "goals" ? "Ongoing aims you work toward." : g === "ideas" ? "Loose thoughts, not promises." : "Things you want to do again and again."}</span></div>`
          : `<form class="add-task" onsubmit="return false"><input type="text" placeholder="Add a task… (Enter)" aria-label="Add a task"><button class="btn small" type="button">Add</button></form>`
          + (rows.length ? `<div class="card">${rows.map((x) => `<div class="task-row ${x.due === "done" ? "done" : ""}"><input type="checkbox" data-id="${x.id}" ${x.due === "done" ? "checked" : ""}>
            <div class="body grow"><span class="content">${esc(x.text)}</span> ${x.label ? `<span class="chip ${x.due === "overdue" ? "overdue" : "due"}">⏰ ${x.label}</span>` : ""}</div></div>`).join("")}</div>` : `<div class="center"><div class="big">🧺</div>Nothing here.</div>`));
        $$("[data-g]", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); g = a.dataset.g; paint(); });
        $$("input[data-id]", view).forEach((c) => c.onchange = () => { const x = st.find((y) => y.id === c.dataset.id); x.due = c.checked ? "done" : "today"; x.label = ""; paint(); });
      };
      paint();
    },
  },

  "tasks-more": {
    mount(view) {
      const rows = [{ id: "a", text: "Send the two internship applications", chip: "Yesterday", over: true, est: "~30m" }, { id: "b", text: "Call the dentist to book a cleaning", chip: "Today", est: "~10m" }, { id: "c", text: "Finish the report", chip: "Mon", est: "~2h" }];
      let menu = null;
      view.innerHTML = `<div class="t-detail-only"><h1 class="page">All <button class="btn ghost small" id="t-jot">🎯 Just one thing</button> <button class="btn ghost small" id="t-fit">⏱ I have 10 minutes</button></h1><div id="t-body"></div></div>`;
      const paint = () => {
        menu = null;
        const rowHtml = (r) => `<div class="task-row"><input type="checkbox" disabled aria-label="Done"><div class="body grow"><span class="content">${esc(r.text)}</span>
          <span class="chip ${r.over ? "overdue" : "due"}">⏰ ${r.chip}</span><span class="chip est">${r.est}</span>${r.snz ? `<span class="chip snoozed">💤 until ${r.snz}</span>` : ""}</div>
          ${r.snz ? `<button class="btn ghost small t-un" data-id="${r.id}">Unsnooze</button>` : r.over ? `<button class="btn ghost small t-snz" data-id="${r.id}">Reschedule ▾</button>` : `<button class="iconbtn t-snz" data-id="${r.id}" title="Not today: hide until later">💤</button>`}</div>`;
        const live = rows.filter((r) => !r.snz), later = rows.filter((r) => r.snz);
        $("#t-body", view).innerHTML = `<div class="card">${live.length ? live.map(rowHtml).join("") : `<div class="center small">Nothing left on this list.</div>`}</div>
          ${later.length ? `<div class="small muted" style="margin:12px 0 6px">Moved out of the way. They wait in the <b>Snoozed</b> tab until their day:</div><div class="card">${later.map(rowHtml).join("")}</div>` : ""}`;
        $$(".t-snz", view).forEach((b) => b.onclick = () => {
          if (menu) { menu.remove(); menu = null; return; }
          menu = document.createElement("div"); menu.className = "snooze-menu t-menu";
          menu.innerHTML = `<div class="small muted sm-title">${rows.find((r) => r.id === b.dataset.id).over ? "Reschedule to…" : "Not today: hide until…"}</div>${[["Tomorrow", "Wed"], ["In 3 days", "Fri"], ["Next week", "Mon"]].map(([l, d]) => `<button type="button" data-d="${d}"><span>${l}</span><span class="small muted">${d}</span></button>`).join("")}`;
          b.parentElement.appendChild(menu); b.parentElement.style.position = "relative";
          $$("button", menu).forEach((o) => o.onclick = () => { const r = rows.find((x) => x.id === b.dataset.id); r.snz = o.dataset.d; r.over = false; paint(); });
        });
        $$(".t-un", view).forEach((b) => b.onclick = () => { delete rows.find((x) => x.id === b.dataset.id).snz; paint(); });
      };
      const modal = (html) => { $(".t-pop", view)?.remove(); const m = document.createElement("div"); m.className = "t-pop card"; m.innerHTML = html; $("#t-body", view).prepend(m); return m; };
      $("#t-jot", view).onclick = () => {
        let i = 0, done = 0;
        const open = rows.filter((r) => !r.snz);
        const show = () => {
          const m = modal(open[i] ? `<div class="small muted" style="margin-bottom:10px">Just one thing${done ? ` · ${done} done so far` : ""}</div><div class="jot-card"><div class="jot-task">${esc(open[i].text)}</div><div class="jot-meta"><span class="chip ${open[i].over ? "overdue" : "due"}">${open[i].over ? "overdue" : open[i].chip}</span><span class="chip est">${open[i].est}</span></div></div>
            <div class="row jot-actions"><button class="btn" data-a="done">✓ Done</button><button class="btn ghost" data-a="snooze" title="Hide it until tomorrow">Not today</button><button class="btn ghost" data-a="skip">Skip</button><div class="grow"></div><button class="btn ghost small" data-a="close">Close</button></div>`
            : `<div class="center"><div class="big">🎉</div><b>${done ? `${done} done. That's a win.` : "Nothing left to do right now."}</b><div class="row" style="justify-content:center"><button class="btn small" data-a="close">Close</button></div></div>`);
          $$("[data-a]", m).forEach((b) => b.onclick = () => { const a = b.dataset.a; if (a === "close") { m.remove(); return; } if (a === "done") done++; i++; show(); });
        };
        show();
      };
      $("#t-fit", view).onclick = () => {
        let mins = 10;
        const show = () => {
          const fits = rows.filter((r) => !r.snz && (parseFloat(r.est.replace("~", "")) * (r.est.endsWith("h") ? 60 : 1)) <= mins);
          const m = modal(`<h3 style="margin-top:0">I have… <span class="muted small">(what fits?)</span></h3><div class="row" style="gap:6px;margin-bottom:8px">${[10, 20, 30].map((n) => `<button class="btn small ${mins === n ? "" : "ghost"}" data-m="${n}">${n} min</button>`).join("")}</div>
            ${fits.length ? `<div class="card">${fits.map((r) => `<div class="task-row"><div class="body grow"><span class="content">${esc(r.text)}</span><span class="chip est">${r.est}</span></div><button class="btn ghost small" type="button">▶ Start</button></div>`).join("")}</div>` : `<div class="small muted">Nothing with an estimate fits ${mins} minutes.</div>`}
            <div class="row"><div class="grow"></div><button class="btn ghost small" data-a="close">Close</button></div>`);
          $$("[data-m]", m).forEach((b) => b.onclick = () => { mins = +b.dataset.m; show(); });
          $("[data-a=close]", m).onclick = () => m.remove();
        };
        show();
      };
      paint();
    },
  },

  reflect: {
    mount(view, t) {
      view.innerHTML = `<h1 class="page" style="margin-top:0">Reflect <span class="wip-chip">⚠ Work in progress</span></h1>
        <div class="card"><div class="digest-head row" style="margin:0 0 6px"><h2 class="grow">📊 This week at a glance</h2><span class="small muted">Mon – Sun</span></div>
          <div class="dg-stats"><div class="dg-stat"><b>5</b><span>dumps</span></div><div class="dg-stat"><b>1,840</b><span>words</span></div><div class="dg-stat"><b>4/7</b><span>days you dumped</span></div><div class="dg-stat"><b>😬</b><span>anxious, calm</span></div></div>
          <div class="row" style="margin:8px 0 6px"><h3 class="grow" style="margin:0">✨ Week in words</h3><button class="btn ghost small" id="t-gen">Write it</button></div>
          <div id="t-ref" class="muted small">Press Write it for a themes, wins and next-week summary.</div></div>${demoNote("Demo only. The real one is written by your AI from your actual dumps.")}`;
      $("#t-gen", view).onclick = () => { $("#t-ref", view).innerHTML = `<p class="small muted">Thinking…</p>`; t.later(() => {
        $("#t-gen", view).textContent = "↻ Regenerate"; $("#t-ref", view).className = ""; $("#t-ref", view).innerHTML = `<div class="md"><p>You kept returning to the <b>internship applications</b>: three dumps this week, mostly anxious in tone. The pattern: you draft, then hold back.</p><ul><li>Your calmest dump was the weekend plan.</li><li>The home lab gives you energy <i>and</i> costs you evenings.</li></ul></div>`; }, 900); };
    },
  },

  stats: {
    mount(view) {
      let days = 30;
      const V = { 7: ["12", "100%", "$0.00", "41"], 30: ["64", "98%", "$0.12", "139"], 90: ["210", "97%", "$0.40", "139"] };
      view.innerHTML = `<div class="card streak-hero"><div class="streak-flame lit">🔥</div><div class="streak-num mono">4</div><div class="streak-label">day streaks</div></div>
        <div class="tiles"><div class="tile"><div class="tile-v mono">9</div><div class="tile-l">longest streak</div></div><div class="tile"><div class="tile-v mono">2.4</div><div class="tile-l">average streak</div></div>
          <div class="tile"><div class="tile-v mono">31</div><div class="tile-l">days dumped</div></div><div class="tile"><div class="tile-v mono">12</div><div class="tile-l">streaks run</div></div></div>
        <div class="card"><h2>Words dumped</h2><div class="tiles" style="margin:0"><div class="tile"><div class="tile-v mono">1,840</div><div class="tile-l">this week</div></div><div class="tile"><div class="tile-v mono">6,120</div><div class="tile-l">this month</div></div><div class="tile"><div class="tile-v mono">24,500</div><div class="tile-l">this year</div></div></div></div>
        <div class="sec">Model activity</div><div class="row" style="margin:0 0 10px" id="t-range"></div><div class="tiles" id="t-tiles"></div>`;
      const paint = () => {
        $("#t-range", view).innerHTML = [7, 30, 90].map((d) => `<button class="chip ${d === days ? "on" : ""}" data-d="${d}">${d} days</button>`).join("");
        const [calls, rate, cost, total] = V[days];
        $("#t-tiles", view).innerHTML = [[calls, "model calls"], [rate, "success rate"], [cost, "est. cloud cost"], [total, "dumps"]].map(([v, l]) => `<div class="tile"><div class="tile-v mono">${v}</div><div class="tile-l">${l}</div></div>`).join("");
        $$("[data-d]", view).forEach((b) => b.onclick = () => { days = +b.dataset.d; paint(); });
      };
      paint();
    },
  },

  settings: {
    mount(view) {
      const S = [["Appearance", "Six themes, or design your own colour by colour. Density, motion, and the daily question on the Capture screen."],
        ["Templates", "The same template manager from the Capture screen: pin, edit, delete, add and reorder."],
        ["AI", "Pick the AI that does the sorting: Gemini (free tier), the built-in local model, your own server, Claude or OpenAI. Add your own item types too."],
        ["Voice", "Choose the speech model behind the mic button. It runs on this PC."],
        ["Data", "Your vault, backups, markdown export and import, Obsidian and Git mirrors, app lock, and the from-anywhere capture key."],
        ["Integrations", "Connect Google Calendar and Todoist so a task can be sent there."],
        ["Plugins & MCP", "Extend the app with plugins and MCP tool servers."],
        ["About", "Version, What's new, and Replay tutorial to see this tour again."]];
      view.innerHTML = `<div class="t-split"><div class="master"><div class="glist">${S.map(([k], i) => `<a href="#" class="grow-row ${i === 0 ? "on" : ""}" data-k="${k}"><span>${k}</span></a>`).join("")}</div></div>
        <div class="detail"><h1 class="page" id="t-sh">${S[0][0]}</h1><div class="card"><p id="t-sp2">${esc(S[0][1])}</p><div id="t-extra"></div></div></div></div>`;
      $$("[data-k]", view).forEach((a) => a.onclick = (e) => { e.preventDefault(); $$("[data-k]", view).forEach((x) => x.classList.toggle("on", x === a));
        const s = S.find(([k]) => k === a.dataset.k);
        $("#t-sh", view).textContent = s[0]; $("#t-sp2", view).textContent = s[1];
        $("#t-extra", view).innerHTML = s[0] === "About" ? `<div class="row"><button class="btn ghost" type="button" disabled>What's new</button><button class="btn ghost" type="button" disabled>Replay tutorial</button></div><p class="small muted">You are in the tutorial right now. Come back here any time to start it over.</p>` : ""; });
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
