// Boot: status → native bridge → routes → views.
import { refreshStatus } from "./state.js";
import { mountShell } from "./shell.js";
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

restorePrefs();
mountShell();
(async () => {
  await refreshStatus();
  await loadThemes();
  initNative();
  start();
  maybeShowWhatsNew();
  checkForUpdates();
})();
