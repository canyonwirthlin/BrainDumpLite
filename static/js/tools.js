// MCP tool runner (Phase 9): builds a form from a tool's JSON inputSchema and
// runs it. Everything a server sends back is other people's text — it is only
// ever shown, never executed, and never treated as an instruction.
import { $, $$, esc, modal, toast } from "./ui.js";
import { api } from "./api.js";

export const MODE_LABEL = { off: "Hidden from AI", ask: "AI may ask", auto: "AI may run" };

export function fieldsFor(schema) {
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  return Object.entries(props).slice(0, 12).map(([name, def]) => ({
    name,
    type: Array.isArray(def.type) ? def.type[0] : (def.type || "string"),
    description: (def.description || "").slice(0, 120),
    enum: Array.isArray(def.enum) ? def.enum.slice(0, 20) : null,
    required: required.has(name),
    default: def.default,
  }));
}

function inputFor(f, value) {
  const v = value === undefined ? (f.default === undefined ? "" : f.default) : value;
  if (f.enum) return `<select data-arg="${esc(f.name)}">${f.enum.map((o) => `<option ${String(o) === String(v) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  if (f.type === "boolean") return `<label class="sw"><input type="checkbox" data-arg="${esc(f.name)}" data-type="boolean" ${v ? "checked" : ""}><i></i></label>`;
  if (f.type === "number" || f.type === "integer") return `<input type="number" data-arg="${esc(f.name)}" data-type="number" value="${esc(v)}">`;
  if (f.type === "object" || f.type === "array") return `<textarea data-arg="${esc(f.name)}" data-type="json" rows="3" placeholder="JSON">${esc(typeof v === "string" ? v : JSON.stringify(v ?? (f.type === "array" ? [] : {})))}</textarea>`;
  return `<input type="text" data-arg="${esc(f.name)}" value="${esc(v)}" placeholder="${esc(f.description)}">`;
}

export function formHtml(schema, values = {}) {
  const fields = fieldsFor(schema);
  if (!fields.length) return `<p class="small muted">This tool takes no arguments.</p>`;
  return `<div class="argform">${fields.map((f) => `
    <label class="arg">
      <span class="k">${esc(f.name)}${f.required ? ` <i class="req">required</i>` : ""}</span>
      ${inputFor(f, values[f.name])}
      ${f.description ? `<span class="small muted">${esc(f.description)}</span>` : ""}
    </label>`).join("")}</div>`;
}

export function readForm(box) {
  const args = {};
  for (const el of $$("[data-arg]", box)) {
    const k = el.dataset.arg, t = el.dataset.type;
    if (t === "boolean") args[k] = el.checked;
    else if (t === "number") { if (el.value !== "") args[k] = Number(el.value); }
    else if (t === "json") { if (el.value.trim()) { try { args[k] = JSON.parse(el.value); } catch { throw new Error(`${k} is not valid JSON`); } } }
    else if (el.value !== "") args[k] = el.value;
  }
  return args;
}

/** Modal that fills a tool's arguments, runs it, and shows the raw result. */
export function runTool(tool, values = {}) {
  const m = modal(`<h2>${esc(tool.server)} → ${esc(tool.name)}</h2>
    ${tool.description ? `<p class="small muted">${esc(tool.description)}</p>` : ""}
    <div id="tool-form">${formHtml(tool.inputSchema, values)}</div>
    <div id="tool-out"></div>
    <div class="row"><div class="grow"></div>
      <button class="btn ghost" id="tool-cancel">Close</button>
      <button class="btn" id="tool-run">Run</button></div>`);
  $("#tool-cancel", m.el).onclick = m.close;
  $("#tool-run", m.el).onclick = async () => {
    const out = $("#tool-out", m.el), btn = $("#tool-run", m.el);
    let args;
    try { args = readForm(m.el); } catch (e) { toast(e.message, true); return; }
    btn.disabled = true;
    out.innerHTML = `<div class="row"><span class="spin"></span><span class="small muted">Running…</span></div>`;
    try {
      const r = await api.post("/mcp/call", { server: tool.server, tool: tool.name, args });
      out.innerHTML = `<div class="sec">Result${r.is_error ? " (the tool reported an error)" : ""}</div>
        <pre class="toolout ${r.is_error ? "bad" : ""}">${esc(r.text || "(empty)")}</pre>`;
    } catch (e) {
      out.innerHTML = `<div class="sec">Failed</div><pre class="toolout bad">${esc(e.message)}</pre>`;
    }
    btn.disabled = false;
  };
  return m;
}

let cache = null;

export async function allTools(refresh = false) {
  if (!cache || refresh) { try { cache = await api.get("/mcp/tools"); } catch { cache = []; } }
  return cache;
}

/** The tool's own input schema when we know it, else one derived from the values. */
export async function schemaFor(server, name, values = {}) {
  const known = (await allTools()).find((t) => t.server === server && t.name === name);
  if (known && known.inputSchema && known.inputSchema.properties) return known.inputSchema;
  return { properties: Object.fromEntries(Object.entries(values).map(([k, v]) =>
    [k, { type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string" }])) };
}
