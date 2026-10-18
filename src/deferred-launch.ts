import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DeferredRunRejectedError, DeferredRuns, deferredProviderReadiness, type DeferredRunRequest } from "./deferred-runs.js";
import { RUNS_DIR, flushWrites } from "./store.js";
import type { AgentId } from "./adapters/types.js";
import type { Run, RunSummary, StartRunInput } from "./engine.js";
import type { Quota } from "./routing.js";

export interface DeferredLaunchHost {
  get(id: string): Run | undefined;
  list(): RunSummary[];
  quota: Quota;
  start(input: StartRunInput): Promise<Run>;
  cancel(id: string): unknown;
}

/** A queue receipt must survive restart even if the engine's normal best-effort writes fail. */
export async function persistDeferredReceipt(run: Pick<Run, "id" | "repo" | "deferred">, directory = RUNS_DIR): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(run.id) || !run.deferred) throw new Error("Invalid deferred launch receipt");
  await flushWrites();
  const handle = await open(join(directory, `${run.id}.jsonl`), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size) throw new Error("The deferred run's initial record was not saved");
    // The first record is the initial run snapshot. Never scan growing agent transcripts.
    const buffer = Buffer.alloc(Math.min(info.size, 4 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error("The deferred run's initial record is incomplete or too large");
    const event = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    const stored = event.type === "run" ? event.run : undefined;
    if (stored?.id !== run.id || stored.repo !== run.repo || stored.deferred?.jobId !== run.deferred.jobId || stored.deferred?.claimId !== run.deferred.claimId || stored.deferred?.attempt !== run.deferred.attempt) throw new Error("The deferred run's saved launch identity does not match");
    await handle.sync();
  } finally { await handle.close(); }
  if (process.platform !== "win32") {
    const folder = await open(directory, "r");
    try { await folder.sync(); } finally { await folder.close(); }
  }
}

export function createDeferredRuns(host: DeferredLaunchHost, options: {
  file?: string;
  resolveProviders: (request: DeferredRunRequest) => Promise<{ roles: Record<string, AgentId[]>; installed: Set<AgentId> }>;
  build: (request: DeferredRunRequest) => Promise<StartRunInput>;
  persist?: typeof persistDeferredReceipt;
}) {
  return new DeferredRuns({
    file: options.file,
    ready: async (request, providers, signal) => {
      signal.throwIfAborted();
      const resolved = await options.resolveProviders(request);
      signal.throwIfAborted();
      const needed = [...new Set([...providers, ...Object.values(resolved.roles).flat()])];
      return deferredProviderReadiness(needed, host.quota, resolved.installed);
    },
    launch: async (request, claim, signal) => {
      let input: StartRunInput;
      try {
        signal.throwIfAborted();
        if (request.parentRunId && !host.get(request.parentRunId)) throw new Error("The parent run no longer exists; review and create another deferred request");
        input = await options.build(request);
        signal.throwIfAborted();
      } catch (error) { throw new DeferredRunRejectedError((error as Error).message); }
      // Once start is called an error may have followed side effects. Never label it safe to retry.
      const run = await host.start({ ...input, deferred: claim, context: { ...input.context, attachments: [] }, trust: "safe", allowUntrusted: false, approvals: {}, loop: { ...input.loop, copy: [] }, trigger: { id: claim.jobId, name: "Deferred run", via: "deferred" } });
      try {
        await (options.persist ?? persistDeferredReceipt)(run);
        if (signal.aborted) await host.cancel(run.id);
      } catch (error) { if (signal.aborted) await host.cancel(run.id); throw error; }
      return { runId: run.id };
    },
    cancelRun: async (id) => { await host.cancel(id); },
  });
}

/** Match persisted identities, not a similar task or the most recent run. */
export async function recoverDeferredRuns(queue: DeferredRuns, host: Pick<DeferredLaunchHost, "list">, persist = persistDeferredReceipt) {
  for (const job of await queue.list()) {
    if (job.status !== "unknown" || !job.claimId) continue;
    const matches = host.list().filter((run) => run.deferred?.jobId === job.id && run.deferred.claimId === job.claimId && run.deferred.attempt === job.attempts && run.repo === job.run.repo && (!job.run.project || run.project === job.run.project));
    if (matches.length !== 1) continue;
    const run = matches[0]!;
    await persist(run);
    await queue.attach(job.id, job.revision, run.id);
  }
}
