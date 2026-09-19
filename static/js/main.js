// Boot: status → native bridge → routes → views.
import { refreshStatus, loadTypes } from "./state.js";
import { mountShell } from "./shell.js";
import { initPalette } from "./palette.js";
import { register, start } from "./router.js";
import { initNative, maybeShowWhatsNew, checkForUpdates, maybeNudge } from "./native.js";
import { loadThemes, restorePrefs } from "./theme.js";
import { needsOnboarding, runOnboarding } from "./onboarding.js";
import * as capture from "./views/capture.js";
import * as history from "./views/history.js";
import * as tasks from "./views/tasks.js";
import * as graph from "./views/graph.js";
import * as search from "./views/search.js";
import * as reflect from "./views/reflect.js";
import * as settings from "./views/settings.js";
import * as session from "./views/session.js";
import * as today from "./views/today.js";
import * as inbox from "./views/inbox.js";

register("capture", capture.render);
register("history", history.render);
register("tasks", tasks.render);
register("graph", graph.render);
register("search", search.render);
register("reflect", reflect.render);
register("settings", settings.render);
register("session", session.render);
register("today", today.render);
register("inbox", inbox.render);

restorePrefs();
mountShell();
initPalette();
(async () => {
  await refreshStatus();
  await loadThemes();
  await loadTypes();
  initNative();
  if (needsOnboarding()) await runOnboarding();
  start();
  maybeShowWhatsNew();
  checkForUpdates();
  maybeNudge();
})();
