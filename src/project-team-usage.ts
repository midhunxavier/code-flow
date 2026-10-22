import type { Run } from "./engine.js";
import { digest, type ProjectTeamLaunch, type ProjectTeamUsageReceipt } from "./project-team-model.js";
import { recoverRun } from "./run-recovery.js";
import { flushWrites } from "./store.js";

function terminalEvidence(run: Run) {
  if (!["done", "failed", "cancelled", "stopped"].includes(run.status) || !Number.isSafeInteger(run.endedAt) || !Number.isSafeInteger(run.createdAt) || run.endedAt! < run.createdAt) return;
  if (!Number.isSafeInteger(run.usage.agentSteps) || run.usage.agentSteps < 0) return;
  const turns = run.steps.filter(step => step.kind === "agent");
  if (turns.some(step => !step.endedAt || ["running", "interrupted"].includes(step.status))) return;
  const launches = turns.reduce((sum, step) => sum + (step.invocations ?? 1), 0);
  const calls = Math.max(run.usage.agentSteps, run.team?.metrics.invocations ?? 0, launches);
  if (!Number.isSafeInteger(calls) || calls < 0) return;
  return { id: run.id, repo: run.repo, project: run.project, base: run.baseRef, contract: run.projectTeam, status: run.status, createdAt: run.createdAt, endedAt: run.endedAt!, calls, turns: turns.map(step => ({ id: step.id, status: step.status, invocations: step.invocations, endedAt: step.endedAt })) };
}

/** Refund only the unused allocation proved by the exact, fsynced terminal run. */
export async function persistProjectTeamUsage(run: Run, launch: ProjectTeamLaunch): Promise<ProjectTeamUsageReceipt | undefined> {
  const evidence = terminalEvidence(run);
  if (!evidence || evidence.createdAt < launch.at || evidence.calls > launch.calls) return;
  await flushWrites(run.id);
  const saved = (await recoverRun(run.id)).run;
  if (!saved || digest(terminalEvidence(saved) ?? null) !== digest(evidence)) return;
  return { version: 1, calls: evidence.calls, durationMs: Math.min(launch.minutes * 60_000, evidence.endedAt - evidence.createdAt), endedAt: evidence.endedAt, recordedAt: Date.now(), digest: digest(evidence) };
}
