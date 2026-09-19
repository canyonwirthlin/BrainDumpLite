// Small color helpers shared by the theme editor and the node color picker.
import { colorCss } from "./ui.js";

// Any CSS color the app stores (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()) -> "#rrggbb" for <input type=color>.
export function toHex(c, fallback = "#888888") {
  const s = String(c || "").trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return "#" + [...m[1]].map((x) => x + x).join("").toLowerCase();
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) return "#" + m[1].toLowerCase();
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("");
  return fallback;
}

const lum = (hex) => {
  const n = parseInt(toHex(hex).slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};

// WCAG contrast ratio, 1 (none) to 21 (black on white).
export function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const isHex6 = (s) => /^#[0-9a-f]{6}$/i.test(String(s || "").trim());

// A node/item type's stored color can be a semantic token ("accent", "blue", ...),
// a CSS var, or a literal — resolve it the same way graph.js paints node dots,
// then convert to #hex for <input type=color>.
export function resolveHex(c, fallback = "#888888") {
  const css = colorCss(c);
  if (css.startsWith("var(")) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(css.slice(4, -1)).trim();
    return toHex(v, fallback);
  }
  return toHex(css, fallback);
}
