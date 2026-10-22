import type { RunSummary } from "./engine.js";

/** Provider conversations share one task; ordinary continuations remain independent tasks. */
export const chatTaskId = (run: Pick<RunSummary, "id" | "pattern" | "chatLink" | "taskExecution">): string =>
  run.taskExecution?.taskId ?? (run.pattern === "solo" ? run.chatLink?.workspaceId ?? run.id : run.id);

export const chatUpdatedAt = (run: RunSummary): number => Math.max(run.createdAt, run.endedAt ?? 0, run.followUps?.at(-1)?.at ?? 0);

export interface ChatTask {
  id: string;
  root: RunSummary;
  chats: RunSummary[];
  updatedAt: number;
}

export function groupChatTasks(runs: readonly RunSummary[]): ChatTask[] {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const id = chatTaskId(run);
    const chats = groups.get(id) ?? [];
    chats.push(run); groups.set(id, chats);
  }
  return [...groups].map(([id, chats]) => {
    chats.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { id, root: chats.find(chat => chat.id === id) ?? chats.find(chat => !chat.taskExecution) ?? chats[0]!, chats: chats.filter(chat => !chat.taskExecution),
      updatedAt: Math.max(...chats.map(chatUpdatedAt)) };
  }).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}
