// Hand a finished file to the user. Native app: the OS Save dialog, then the backend writes the bytes (the shell has
// no fs plugin - same approach as the Markdown export). Plain browser: an ordinary download via a temporary link.
import { api as http } from "../api.js";
import { native } from "../native.js";
import { toast } from "../ui.js";

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** Save `blob` as `name`. Shows a toast on success/failure. Resolves true when a file was saved or downloaded. */
export async function saveBlob(blob, { name, ext, label }) {
  try {
    if (native && native.dialog && native.dialog.save) {
      const path = await native.dialog.save({ title: `Save ${label}`, defaultPath: name, filters: [{ name: label, extensions: [ext] }] });
      if (!path) return false;   // cancelled: say nothing
      const res = await http.post("/graph/export/save", { path, data: await toBase64(blob) });
      toast(`Saved to ${res.path}`);
      return true;
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Downloaded ${name}`);
    return true;
  } catch (e) {
    toast(`Couldn't save ${label}: ${e.message || e}`, true);
    return false;
  }
}
