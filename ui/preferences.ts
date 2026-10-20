import { signal } from "@preact/signals";
import { showToast, store } from "./lib.js";

export const desktopNotifications = signal(store.get("notify") !== "0");
export const notificationPermission = signal<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
export const canNotify = () => desktopNotifications.value && notificationPermission.value === "granted";
export function watchNotificationPermission() {
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

/** An optional workspace surface, not an authorization or execution switch. */
export const peopleEnabled = signal(store.get("peopleEnabled") === "1");
export function setPeopleEnabled(enabled: boolean) { peopleEnabled.value = enabled; store.set("peopleEnabled", enabled ? "1" : "0"); }
