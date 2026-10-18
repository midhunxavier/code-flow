import { signal } from "@preact/signals";

/**
 * Light or dark. Until you pick one (the theme button, or Settings → General) the app follows the
 * system; your pick is kept (index.html applies it before the first paint) and shared with a
 * popped-out panel's window.
 */
export type Theme = "light" | "dark";
/** What you picked: a theme, or "system" to follow the operating system. */
export type ThemeChoice = Theme | "system";

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
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
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
/** Your pick, for the Appearance setting. */
export const themeChoice = signal<ThemeChoice>(picked() ?? "system");

function apply() {
  theme.value = effective();
  themeChoice.value = picked() ?? "system";
  if (root) root.dataset.theme = theme.value;
}
apply();
system?.addEventListener("change", apply);
// Picked in another window of this app (the popped-out side panel, or the main one).
if (typeof window !== "undefined") window.addEventListener("storage", (e) => e.key === KEY && apply());

export function setTheme(choice: ThemeChoice) {
  store.set(KEY, choice === "system" ? null : choice);
  apply();
}

export function toggleTheme() {
  setTheme(theme.value === "dark" ? "light" : "dark");
}
