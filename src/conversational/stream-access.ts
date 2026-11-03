import { HttpError } from "../http.js";
/** Both initial subscriptions and updates must preserve the local-only chat boundary. */
export function assertChatSubscriptions(subs: unknown, via: string) {
  if (via !== "local" && Array.isArray(subs) && subs.some(s => typeof s?.topic === "string" && /^(chats|chat):/.test(s.topic))) throw new HttpError(403, "Chat updates require the local owner connection");
}
