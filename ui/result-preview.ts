import { ApiError, api, enc, post, store } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { resultAgent } from "./run-experience.js";
import type { DevServer, Run, RunSummary } from "./types.js";

type Tree = RunSummary["worktrees"][number];
const key = (run: RunSummary, tree: Tree) => `preview-setup:${run.id}:${tree.name}`;
const continuations = new Map<string, Promise<DevServer | undefined>>();
export const PREVIEW_REQUEST = "Set up a working web preview of this result and show it in the Browser panel. Find the right app and launch command from this repository. Prepare any required local setup within the current permissions. Save the launch command in .codeflow/config.json as run: {command: ...}, preserving all existing settings. The command runs from this worktree with PORT allocated by Code Flow; use that port instead of a fixed one. Code Flow will start and keep the server running after your reply, so do not start a second server yourself. Preserve the completed work, do not publish or merge. If this repository has no runnable web UI, explain that clearly rather than creating an unrelated demo.";

export async function startResultPreview(run: RunSummary, tree: Tree, command?: string): Promise<DevServer | undefined> {
  const base = `/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`;
  const existing = await api<DevServer | null>(base);
  if (existing?.status === "running" && (!command || command === existing.command) && (await api<{ ready: boolean }>(base + "/ready")).ready) return existing;
  let server: DevServer;
  try { server = await post<DevServer>(base, { command }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.confirm !== "allowUntrusted") throw error;
    if (!await confirmAction(`${error.message}\n\nStart the preview on this computer?`, { title: "Run repository code locally?", confirmLabel: "Start preview", danger: true })) return;
    server = await post<DevServer>(base, { command, allowUntrusted: true });
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await api<{ ready: boolean; status: string }>(base + "/ready");
    if (state.ready) return server;
    if (state.status !== "running") throw new Error("The preview stopped before it was ready. Ask the agent to fix the startup error in chat.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("The preview is still starting. Try Open preview again, or ask the agent to check its startup logs.");
}

/** This button is the user's explicit request to configure and then run a local preview. */
export async function requestPreviewSetup(run: RunSummary, tree: Tree) {
  const current = await api<Run>(`/api/runs/${run.id}`);
  const agent = resultAgent(current, tree.name);
  if (!agent) throw new Error("Choose an agent in chat and ask it to set up the preview.");
  store.set(key(run, tree), JSON.stringify({ since: Date.now(), message: PREVIEW_REQUEST }));
  try { await post(`/api/runs/${run.id}/followups`, { kind: "reply", worktree: tree.name, agent, message: PREVIEW_REQUEST }); }
  catch (error) { store.set(key(run, tree), ""); throw error; }
}

/** Resume after the chat turn (including a page reload), without starting a duplicate server. */
export function continuePreviewSetup(run: RunSummary, tree: Tree): Promise<DevServer | undefined> {
  const id = key(run, tree);
  if (continuations.has(id)) return continuations.get(id)!;
  const pending = store.json<{ since: number; message: string } | null>(id, null);
  if (!pending || run.status === "running") return Promise.resolve(undefined);
  const work = (async () => {
    const current = await api<Run>(`/api/runs/${run.id}`);
    if (current.status === "running") return;
    const turn = current.followUps.find(turn => turn.at >= pending.since && turn.worktree === tree.name && turn.message === pending.message);
    if (turn?.status === "pending") return;
    store.set(id, "");
    if (!turn || turn.status !== "done") throw new Error("Preview setup did not finish. Continue with the agent in chat.");
    const teams = current.teamTurns?.filter(team => team.key.includes(`|follow-up ${turn.id}#`)) ?? [];
    if (teams.some(team => team.state !== "applied" || team.reconciliation || team.executionStatus !== "done")) throw new Error("The team's preview setup needs attention. Finish or resolve its changes in chat, then open Preview again.");
    return startResultPreview(current, tree);
  })().finally(() => continuations.delete(id));
  continuations.set(id, work);
  return work;
}
