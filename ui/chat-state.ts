import { subscribe } from "./stream.js";
import { effect, signal } from "@preact/signals";
import { api, onPhone, ownerOnLocalListener } from "./lib.js";
import { route, composerProject, openComposer, executionPaused, agents } from "./state.js";
import { executionHost } from "./ssh-projects.js";
import type { ChatSummary } from "../src/conversational/chats.js";
export const chats = signal<ChatSummary[]>([]);
export const chatQuery = signal("");
export const archivedChats = signal(false);
export const chatSearchTarget = signal<{ id: string; sequence: number } | undefined>(undefined);
export const chatHistoryError = signal("");
let cursor = "";
let requestSequence = 0;
export function openChat(project = composerProject.value) { if (onPhone || !ownerOnLocalListener.value || executionHost.value.kind !== "local") { void openComposer(project); return; } route.value = { view: "chat", id: "new", ...(project ? { project } : {}) }; }
export async function refreshChats() {
  const sequence = ++requestSequence;
  if (onPhone || !ownerOnLocalListener.value || executionHost.value.kind !== "local") { chats.value = []; cursor = ""; return; }
  if (!agents.value.length || executionPaused.value) { cursor = ""; chatHistoryError.value = executionPaused.value ? "Chat history is paused by the filesystem restriction." : ""; return; }
  const params = new URLSearchParams({ q: chatQuery.value, archived: String(archivedChats.value), ...(cursor ? { after: cursor } : {}) });
  try { const result = await api<{ items?: ChatSummary[]; cursor: string }>(`/api/chats?${params}`); if (sequence !== requestSequence || executionPaused.value) return; if (result.items) chats.value = result.items; cursor = result.cursor; chatHistoryError.value = ""; }
  catch (error) { if (sequence === requestSequence) chatHistoryError.value = (error as Error).message; }
}
export function watchChats() {
  let stopped = false, timer: ReturnType<typeof setTimeout>, debounce: ReturnType<typeof setTimeout>, streamCursor: string | undefined;
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (!stopped) void refreshChats(); }, 100); };
  const off = effect(() => {
    const allowed = !onPhone && ownerOnLocalListener.value && agents.value.length && !executionPaused.value && executionHost.value.kind === "local";
    chatQuery.value; archivedChats.value; cursor = ""; schedule();
    if (!allowed) return;
    return subscribe("chats:all", data => { if (data.cursor) streamCursor = data.cursor; if (["changed", "hello"].includes(data.type)) schedule(); }, () => streamCursor);
  });
  const poll = async () => { await refreshChats(); if (!stopped) timer = setTimeout(poll, 15000); };
  void poll(); return () => { stopped = true; clearTimeout(timer); clearTimeout(debounce); off(); };
}
