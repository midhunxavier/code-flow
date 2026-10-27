import { ApiError, api, enc, post, store } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { resultAgent } from "./run-experience.js";
import type { DevServer, Run, RunSummary } from "./types.js";

type Tree = RunSummary["worktrees"][number];
const key = (run: RunSummary, tree: Tree) => `preview-setup:${run.id}:${tree.name}`;
export const previewSetupFailed = (run: RunSummary, tree: Tree) => store.json<{ outcome?: string } | null>(key(run, tree), null)?.outcome === "no-command";
export const NO_PREVIEW_COMMAND = "The agent replied but did not save a launch command. Read its reply in chat. Enter an app command in Preview settings, or explicitly ask the agent to try again.";
const continuations = new Map<string, Promise<DevServer | undefined>>();
export const PREVIEW_REQUEST = "Set up a working web preview of this result and show it in the Browser panel. Find the right app and launch command from this repository. Prepare any required local setup within the current permissions. Save the launch command in .codeflow/config.json as run: {command: ...}, preserving all existing settings. The command runs from this worktree with PORT allocated by Code Flow; use that port instead of a fixed one. Code Flow will start and keep the server running after your reply, so do not start a second server yourself. Preserve the completed work, do not publish or merge. If this repository has no runnable web UI, explain that clearly rather than creating an unrelated demo.";

export async function startResultPreview(run: RunSummary, tree: Tree, command?: string): Promise<DevServer | undefined> {
  const base = `/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`;
  const existing = await api<DevServer | null>(base);
  let server: DevServer;
  if (existing?.status === "running" && (!command || command === existing.command)) server = existing;
  else try { server = await post<DevServer>(base, { command }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.confirm !== "allowUntrusted") throw error;
    if (!await confirmAction(`${error.message}\n\nStart the preview on this computer?`, { title: "Run repository code locally?", confirmLabel: "Start preview", danger: true })) return;
    server = await post<DevServer>(base, { command, allowUntrusted: true });
  }
  const ready = await waitForResultPreview(base, server);
  store.set(key(run, tree), "");
  return ready;
}

export const previewStoppedMessage = (server: DevServer | null) => `The preview stopped${server?.exitCode == null ? "" : ` (exit ${server.exitCode})`}. Check its app command and logs.${server?.logs.length ? ` Last output: ${server.logs.slice(-4).join("\n")}` : ""}`;
export async function stopResultPreview(base: string, server: Pick<DevServer, "startedAt">) { await api(`${base}?startedAt=${server.startedAt}`, { method: "DELETE" }); }
/** A bound port is only the first startup signal: require sustained readiness, then check identity again. */
export async function waitForResultPreview(base: string, server: DevServer, timing = { attempts: 120, interval: 250, stable: 1500 }): Promise<DevServer> {
  let readySince: number | undefined;
  for (let attempt = 0; attempt < timing.attempts; attempt++) {
    const state = await api<{ ready: boolean; status: string }>(base + "/ready");
    if (state.status !== "running") throw new Error(previewStoppedMessage(await api<DevServer | null>(base)));
    if (state.ready) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= timing.stable) {
        const current = await api<DevServer | null>(base);
        if (current?.startedAt !== server.startedAt) throw new Error("The preview changed while starting. Open the current preview again.");
        if (current.status !== "running") throw new Error(previewStoppedMessage(current));
        return current;
      }
    } else readySince = undefined;
    await new Promise(resolve => setTimeout(resolve, timing.interval));
  }
  const current = await api<DevServer | null>(base);
  if (current?.startedAt !== server.startedAt) throw new Error("The preview changed while starting. Open the current preview again.");
  await stopResultPreview(base, server);
  throw new Error(`The app did not become ready on port ${server.port}; its process was stopped. Code Flow supplies this port in $PORT. Make sure the command uses $PORT instead of a fixed port.${current.logs.length ? ` Last output: ${current.logs.slice(-4).join("\n")}` : ""}`);

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
  const pending = store.json<{ since: number; message: string; outcome?: string } | null>(id, null);
  if (pending?.outcome === "no-command") return Promise.reject(new Error(NO_PREVIEW_COMMAND));
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
    const configured = await api<{ command: string } | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve/config`);
    if (!configured?.command) { store.set(id, JSON.stringify({ ...pending, outcome: "no-command" })); throw new Error(NO_PREVIEW_COMMAND); }
    return startResultPreview(current, tree, configured.command);
  })().finally(() => continuations.delete(id));
  continuations.set(id, work);
  return work;
}
