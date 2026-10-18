import { signal } from "@preact/signals";

/**
 * Light or dark. Until you pick one with the theme button the app follows the system; your pick is
 * kept (index.html applies it before the first paint) and shared with a popped-out panel's window.
 */
export type Theme = "light" | "dark";

// One pick per browser, not per workspace (lib.ts's store namespaces SSH workspaces): index.html reads this same key.
const KEY = "theme";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode or blocked storage: the pick just won't persist
    }
  },
};
// Absent where the UI is bundled for tests without a browser: there the app is simply light.
const system = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
const root = typeof document === "undefined" ? undefined : document.documentElement;
const picked = (): Theme | null => {
  const t = store.get(KEY);
  return t === "light" || t === "dark" ? t : null;
};
const effective = (): Theme => picked() ?? (system?.matches ? "dark" : "light");

/** The theme in effect, for code that draws its own colours (the terminal). */
export const theme = signal<Theme>(effective());

function apply() {
  const t = picked();
  if (root) {
    if (t) root.dataset.theme = t;
    else delete root.dataset.theme;
  }
  theme.value = effective();
}
apply();
system?.addEventListener("change", apply);
// Picked in another window of this app (the popped-out side panel, or the main one).
window.addEventListener("storage", (e) => e.key === KEY && apply());

export function toggleTheme() {
  store.set(KEY, theme.value === "dark" ? "light" : "dark");
  apply();
}
