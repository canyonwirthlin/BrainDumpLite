// The #graph-info box (top-right of the map): what you see after selecting a node, or the Path summary.
//
// Content is a stack of sections. Each section is { id, order, render(node, api) -> html string | Element | null };
// sections are sorted by `order` (ties keep registration order) and a section returning null/"" is skipped.
//   import { infoSections } from "./infobox.js";
//   infoSections.push({ id: "my-section", order: 50, render: (node, api) => `<div class="small muted">${node.label}</div>` });
// The built-in node summary is order 0; the overlay runtime adds an "overlays" section at order 100.
import { $, esc } from "../ui.js";

export const infoSections = [];

infoSections.push({
  id: "node", order: 0,
  render(n, api) {
    const hood = api.neighborsOf(n.id);
    const dumpsHere = api.nodes.filter((x) => x.type === "dump" && hood.has(x.id) && x.id !== n.id);
    const browsable = n.type === "concept" || n.type === "person";
    // dumps and items open their dump from here (a click on the map may only select them): make that link a button
    const openBtn = (id) => `<a class="ov-btn primary" href="#history/${id}">Open dump →</a>`;
    return `<b>${n.type === "concept" ? "💡" : n.type === "person" ? "🧑" : "•"} ${esc(n.label)}</b>
      <div class="small muted" style="margin:6px 0">${n.type === "dump" ? openBtn(n.id) : n.dump ? openBtn(n.dump) : `${dumpsHere.length} dump${dumpsHere.length === 1 ? "" : "s"}`}${browsable ? ` · <a href="#graph/${n.type}/${encodeURIComponent(n.label)}">Open ${n.type} →</a>` : ""}</div>
      ${dumpsHere.slice(0, 8).map((d) => `<div style="margin-top:3px"><a href="#history/${d.id}">${esc(d.label)}</a></div>`).join("")}`;
  },
});

const box = () => $("#graph-info");

/** Show arbitrary HTML in the box (Path uses this). */
export function showHtml(html) {
  const b = box();
  if (!b) return;
  b.style.display = "block";
  b.innerHTML = html;
}

export function hide() {
  const b = box();
  if (b) b.style.display = "none";
}

/** Render every section for a node into the box. */
export function showNode(node, api) {
  const b = box();
  if (!b) return;
  b.style.display = "block";
  b.innerHTML = "";
  [...infoSections].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).forEach((s) => {
    let out;
    try { out = s.render(node, api); } catch (e) { console.warn("graph info section", s.id, e); return; }
    if (!out) return;
    if (typeof out === "string") b.insertAdjacentHTML("beforeend", out);
    else b.appendChild(out);
  });
}

/** Wire the box to the engine: selecting a node fills it, selecting nothing hides it. Called once per api. */
export function installInfobox(api) {
  api.on("select", ({ node }) => { if (node) showNode(node, api); else hide(); });
}
