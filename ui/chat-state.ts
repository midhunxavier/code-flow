import { subscribe } from "./stream.js";
import { effect, signal } from "@preact/signals";
import { api, onPhone, ownerOnLocalListener } from "./lib.js";
import { route, composerProject, openComposer, executionPaused, agents, railView } from "./state.js";
import { executionHost } from "./ssh-projects.js";
import type { ChatSummary } from "../src/conversational/chats.js";
export const chats = signal<ChatSummary[]>([]);
export const chatQuery = signal("");
export const chatSearchTarget = signal<{ id: string; sequence: number } | undefined>(undefined);
export const chatHistoryError = signal("");
let cursor = "";
let requestSequence = 0;
/** Chat runs for the owner on this computer. A phone, another device or an SSH host starts work in the run form. */
export const chatAllowed = () => !onPhone && ownerOnLocalListener.value && executionHost.value.kind === "local";
export function openChat(project = composerProject.value) { if (!chatAllowed()) { void openComposer(project); return; } route.value = { view: "chat", id: "new", ...(project ? { project } : {}) }; }
export async function refreshChats() {
  const sequence = ++requestSequence;
  if (!chatAllowed()) { chats.value = []; cursor = ""; return; }
  if (!agents.value.length || executionPaused.value) { cursor = ""; chatHistoryError.value = executionPaused.value ? "Chat history is paused by the filesystem restriction." : ""; return; }
  const params = new URLSearchParams({ q: chatQuery.value, archived: "false", ...(cursor ? { after: cursor } : {}) });
  try {
    const requests = [api<{ items?: ChatSummary[]; cursor: string }>(`/api/chats?${params}`)];
    if (railView.value.archived) { const archived = new URLSearchParams(params); archived.set("archived", "true"); requests.push(api<{ items?: ChatSummary[]; cursor: string }>(`/api/chats?${archived}`)); }
    const results = await Promise.all(requests);
    if (sequence !== requestSequence || executionPaused.value) return;
    if (results.every(result => result.items)) chats.value = results.flatMap(result => result.items!).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
    // Archive and live lists have separate cursors. Fetch both in full when archives are shown.
    cursor = results.length === 1 ? results[0]!.cursor : ""; chatHistoryError.value = "";
  }
  catch (error) { if (sequence === requestSequence) chatHistoryError.value = (error as Error).message; }
}
export function watchChats() {
  let stopped = false, timer: ReturnType<typeof setTimeout>, debounce: ReturnType<typeof setTimeout>, streamCursor: string | undefined;
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (!stopped) void refreshChats(); }, 100); };
  const off = effect(() => {
    const allowed = chatAllowed() && agents.value.length && !executionPaused.value;
    chatQuery.value; railView.value.archived; cursor = ""; schedule();
    if (!allowed) return;
    return subscribe("chats:all", data => { if (data.cursor) streamCursor = data.cursor; if (["changed", "hello"].includes(data.type)) schedule(); }, () => streamCursor);
  });
  const poll = async () => { await refreshChats(); if (!stopped) timer = setTimeout(poll, 15000); };
  void poll(); return () => { stopped = true; clearTimeout(timer); clearTimeout(debounce); off(); };
}
