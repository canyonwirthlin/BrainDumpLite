// Left rail + top bar. Views call ctx.setTitle(title, slotHtml) to own the
// top bar's middle slot; the right cluster (AI pill, update pill) is global.
import { $, $$, ICONS, PROVIDER_NAMES, esc } from "./ui.js";
import { state, on } from "./state.js";
import { setTitleHandler, go } from "./router.js";

export const NAV = [
  { id: "capture", label: "Capture" }, { id: "history", label: "History" }, { id: "tasks", label: "Tasks" },
  { id: "graph", label: "Graph" }, { id: "search", label: "Search" }, { id: "reflect", label: "Reflect" },
];

export function mountShell() {
  $("#rail").innerHTML = `
    <a class="brain" href="#capture" title="BrainDump Lite">${ICONS.brain}</a>
    ${NAV.map((n) => `<a class="nav" data-v="${n.id}" href="#${n.id}" title="${n.label}">${ICONS[n.id]}<span>${n.label}</span></a>`).join("")}
    <div class="grow"></div>
    <span class="ai-dot" id="ai-dot" title="AI off"></span>
    <a class="nav" data-v="settings" href="#settings" title="Settings">${ICONS.settings}<span>Settings</span><i class="badge" id="rail-badge" hidden></i></a>`;
  on("route", ({ name }) => $$("#rail .nav").forEach((a) => a.classList.toggle("active", a.dataset.v === name)));
  on("status", paintStatus);
  setTitleHandler(setTitle);
  paintStatus(state.status);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault(); go("capture"); setTimeout(() => $("#dump-text")?.focus(), 50);
    }
  });
}

export function setTitle(title, slotHtml = "") {
  $("#title").textContent = title;
  $("#topbar-slot").innerHTML = slotHtml;
  document.title = title === "Capture" ? "BrainDump Lite" : `${title} · BrainDump Lite`;
}

function paintStatus(status) {
  const pill = $("#ai-pill"), dot = $("#ai-dot");
  if (!pill || !dot) return;
  if (status.ai) {
    pill.className = "pill on"; pill.textContent = `● ${PROVIDER_NAMES[status.provider] || status.provider}`; pill.title = status.model || "";
    dot.classList.add("on"); dot.title = pill.textContent;
  } else {
    pill.className = "pill off"; pill.textContent = "○ AI off"; pill.title = "";
    dot.classList.remove("on"); dot.title = "AI off";
  }
}

export function setUpdate(version) {
  const pill = $("#update-pill"), badge = $("#rail-badge");
  if (version) { pill.textContent = `⬆ v${esc(version)}`; pill.style.display = ""; badge.hidden = false; }
  else { pill.style.display = "none"; badge.hidden = true; }
}
