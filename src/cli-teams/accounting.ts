import type { Run } from "../engine.js";

/** Restore known elapsed time; charge an unobserved turn's bounded reservation
 * conservatively, rather than treating a crash as a fresh execution allowance. */
export function recoverCliAccounting(run: Run, journal: Map<string, unknown>) {
  const cli = run.cliTeam;
  if (!cli) return;
  const launches = [...journal].filter(([key]) => key.startsWith("cli-launch:")).map(([, value]) => value as { stepId: string; mode?: string; assignment?: string; usedMs?: number; reservedMs?: number });
  cli.managedInvocations = launches.length;
  cli.nodeInvocations = {};
  for (const launch of launches) if (launch.assignment?.startsWith("workflow/")) cli.nodeInvocations[launch.assignment] = (cli.nodeInvocations[launch.assignment] ?? 0) + 1;
  const saved = journal.get("cli-clock");
  let used = Math.max(run.clockUsedMs ?? 0, typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : 0);
  const observed = used;
  for (const launch of launches) {
    if (journal.has(`cli-settled:${launch.stepId}`)) continue;
    // Surface the write fence immediately, even when the lost settlement consumes
    // the remaining allowance and resume never reaches the execution guard.
    if ((launch.mode ?? run.steps.find(step => step.id === launch.stepId)?.mode) === "write") cli.recoveryRequired = true;
    if (typeof launch.usedMs === "number" && typeof launch.reservedMs === "number" && Number.isFinite(launch.usedMs) && Number.isFinite(launch.reservedMs) && launch.usedMs >= 0 && launch.reservedMs >= 0) used = Math.max(used, launch.usedMs + launch.reservedMs);
  }
  if (used > observed) {
    cli.recoveryTimeChargeMs = used - observed;
    cli.detail = "An interrupted invocation has no durable settlement. Its bounded time reservation is charged conservatively; completed work remains available.";
  }
  run.clockUsedMs = used;
  cli.accountedExecutionMs = used;
}
