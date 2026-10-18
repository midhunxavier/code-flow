import { signal } from "@preact/signals";
import { store } from "./lib.js";

/**
 * Light or dark. Until you pick one with the theme button the app follows the system; your pick is
 * kept (index.html applies it before the first paint) and shared with a popped-out panel's window.
 */
export type Theme = "light" | "dark";

const KEY = "theme";
const system = matchMedia("(prefers-color-scheme: dark)");
const picked = (): Theme | null => {
  const t = store.get(KEY);
  return t === "light" || t === "dark" ? t : null;
};
const effective = (): Theme => picked() ?? (system.matches ? "dark" : "light");

/** The theme in effect, for code that draws its own colours (the terminal). */
export const theme = signal<Theme>(effective());

function apply() {
  const t = picked();
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  theme.value = effective();
}
apply();
system.addEventListener("change", apply);
// Picked in another window of this app (the popped-out side panel, or the main one).
window.addEventListener("storage", (e) => e.key === KEY && apply());

export function toggleTheme() {
  store.set(KEY, theme.value === "dark" ? "light" : "dark");
  apply();
}
