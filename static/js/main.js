// Boot: status → native bridge → routes → views.
import { refreshStatus, state, on } from "./state.js";
import { $, PROVIDER_NAMES } from "./ui.js";
import { register, start } from "./router.js";
import { initNative, maybeShowWhatsNew, checkForUpdates } from "./native.js";
import { loadThemes, restorePrefs } from "./theme.js";
import * as capture from "./views/capture.js";
import * as history from "./views/history.js";
import * as tasks from "./views/tasks.js";
import * as graph from "./views/graph.js";
import * as search from "./views/search.js";
import * as reflect from "./views/reflect.js";
import * as settings from "./views/settings.js";

register("capture", capture.render);
register("history", history.render);
register("tasks", tasks.render);
register("graph", graph.render);
register("search", search.render);
register("reflect", reflect.render);
register("settings", settings.render);

// Header pill + nav highlight (the shell in Task 4 takes this over).
on("status", (status) => {
  const pill = $("#ai-pill");
  if (!pill) return;
  if (status.ai) { pill.className = "pill on"; pill.textContent = `● ${PROVIDER_NAMES[status.provider] || status.provider}`; pill.title = status.model; }
  else { pill.className = "pill off"; pill.textContent = "○ AI off"; }
});
on("route", ({ name }) => document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.v === name)));

restorePrefs();
(async () => {
  await refreshStatus();
  await loadThemes();
  initNative();
  start();
  maybeShowWhatsNew();
  checkForUpdates();
})();
