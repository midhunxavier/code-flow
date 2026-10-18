import { effect, signal } from "@preact/signals";
import { showToast, store } from "./lib.js";

export type Theme = "system" | "light" | "dark";
const saved = store.get("theme");
export const theme = signal<Theme>(saved === "light" || saved === "dark" ? saved : "system");
export const desktopNotifications = signal(store.get("notify") !== "0");
export const notificationPermission = signal<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
export const canNotify = () => desktopNotifications.value && notificationPermission.value === "granted";
export function setTheme(value: Theme) { theme.value = value; store.set("theme", value); }
export function initializeAppearance() {
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = theme.value === "system" ? scheme.matches ? "dark" : "light" : theme.value;
    window.dispatchEvent(new Event("codeflow-theme"));
  };
  effect(apply);
  scheme.addEventListener("change", apply);
  window.addEventListener("focus", () => { notificationPermission.value = "Notification" in window ? Notification.permission : "unsupported"; });
}
export async function setDesktopNotifications(enabled: boolean) {
  if (!("Notification" in window)) return showToast("This browser doesn't support notifications");
  try {
    const permission = enabled && Notification.permission !== "granted" ? await Notification.requestPermission() : Notification.permission;
    notificationPermission.value = permission;
    desktopNotifications.value = enabled && permission === "granted";
    store.set("notify", desktopNotifications.value ? "1" : "0");
    showToast(desktopNotifications.value ? "You'll be notified when a run needs you" : enabled ? "Notifications are blocked in the browser settings" : "Notifications off");
  } catch { showToast("Couldn't enable notifications. Check your browser's site permissions."); }
}
