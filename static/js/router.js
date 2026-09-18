// Hash router with sub-paths: #history/abc, #tasks/today, #settings/ai.
import { clearPoll, emit } from "./state.js";

const routes = {};
let setTitle = () => {};  // the shell replaces this via setTitleHandler()

export function register(name, render) { routes[name] = render; }
export function setTitleHandler(fn) { setTitle = fn; }

export function parse() {
  const h = location.hash.slice(1) || "capture";
  const [name, ...rest] = h.split("/");
  return { name, params: rest.map((p) => { try { return decodeURIComponent(p); } catch { return p; } }) };
}

export function go(hash) {
  if (location.hash === "#" + hash) route();
  else location.hash = hash;
}

export function route() {
  clearPoll();
  const { name, params } = parse();
  if (name === "dump" && params[0]) { location.replace("#history/" + params[0]); return; }  // legacy links
  const render = routes[name] || routes.capture;
  emit("route", { name, params });
  const v = document.querySelector("#view");
  v.classList.remove("fade"); void v.offsetWidth; v.classList.add("fade");
  render({ name, params, setTitle: (t, s) => setTitle(t, s) });
}

export function start() {
  window.addEventListener("hashchange", route);
  // A link whose hash equals the CURRENT hash fires no hashchange — re-route manually.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute("href") === (location.hash || "#capture")) { e.preventDefault(); route(); }
  });
  route();
}
