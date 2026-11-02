import { signal } from "@preact/signals";
import { api, onPhone } from "./lib.js";
import { route, composerProject, openComposer } from "./state.js";
import { executionHost } from "./ssh-projects.js";
import type { ChatSummary } from "../src/conversational/chats.js";
export const chats = signal<ChatSummary[]>([]);
export const chatHistoryError = signal("");
let cursor = "";
let requestSequence = 0;
export function openChat(project = composerProject.value) { if (onPhone || executionHost.value.kind !== "local") { void openComposer(project); return; } route.value = { view: "chat", id: "new", ...(project ? { project } : {}) }; }
export async function refreshChats() {
  const sequence = ++requestSequence;
  if (onPhone || executionHost.value.kind !== "local") { chats.value = []; cursor = ""; return; }
  try { const result = await api<{ items?: ChatSummary[]; cursor: string }>(`/api/chats${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`); if (sequence !== requestSequence) return; if (result.items) chats.value = result.items; cursor = result.cursor; chatHistoryError.value = ""; }
  catch (error) { if (sequence === requestSequence) chatHistoryError.value = (error as Error).message; }
}
export function watchChats() {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const poll = async () => { await refreshChats(); if (!stopped) timer = setTimeout(poll, 3000); };
  void poll(); return () => { stopped = true; clearTimeout(timer); };
}
