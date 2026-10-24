import type { RunSummary } from "./engine.js";

type Evidence = { status: string; verdict?: string; checkCantRun?: unknown } & Partial<Pick<RunSummary, "verification" | "loop" | "lastCheck" | "worktrees">>;

/** Shared presentation rules. Execution completion alone is never evidence of success. */
export function checksLabel(run: Evidence, checking = false, branch?: string): string {
  if (checking) return "Running";
  if (run.status === "running") return "Pending";
  const checkedBranch = run.verification?.branch ?? run.worktrees?.find(tree => tree.name === run.lastCheck?.worktree)?.branch;
  if (branch && checkedBranch !== branch) return "Not verified for this branch";
  if (run.checkCantRun) return "Blocked";
  if (run.verdict === "failing") return "Failed";
  if (run.verification) return { verified: "Passed", "needs-changes": "Failed", blocked: "Blocked", unchecked: "Unverified" }[run.verification.state];
  if (run.verdict === "passed") return "Passed";
  return run.loop?.check ? "Not verified" : "Not configured";
}

export const runPassed = (run: Evidence) => run.status === "done" && checksLabel(run) === "Passed";
export function runState(run: Evidence): string {
  if (run.status !== "done") return run.status;
  const check = checksLabel(run);
  return check === "Failed" ? "failing" : check === "Blocked" ? "unchecked" : check === "Passed" ? "done" : "unverified";
}

export function needsYou(run: RunSummary): boolean {
  if (run.archived) return false;
  const question = run.status === "running" && !!run.team?.awaitingRequestId;
  if (run.awaiting || question) return true;
  if (run.projectTeam || run.taskExecution) return false;
  const latestTeam = run.teamTurns?.at(-1);
  if (latestTeam?.executionStatus && latestTeam.executionStatus !== "done" && run.status !== "running" || latestTeam?.reconciliation || latestTeam?.resolutionCheck?.ok === false || latestTeam?.reviewStale || latestTeam?.resolutionReview?.approved === false) return true;
  return run.team?.status === "blocked" || run.triage?.state === "pending" || Object.values(run.watches ?? {}).some(watch => watch.state === "needs-you") ||
    run.status !== "running" && (run.status === "interrupted" || !run.seen);
}

export const isFlagged = (run: RunSummary) => Object.keys(run.integrity ?? {}).length > 0 || !!run.followUps?.some(turn => turn.integrity?.length);
export const HISTORY_STATUSES = ["all", "attention", "running", "passed", "failing", "flagged"] as const;
export type HistoryStatus = typeof HISTORY_STATUSES[number];
export type ProjectSection = "waiting" | "running" | "results";
export interface HistoryFilter { status?: HistoryStatus; pattern?: string; agent?: string; repo?: string; section?: ProjectSection }
export function matchesHistoryFilter(run: RunSummary, filter: HistoryFilter): boolean {
  if (filter.repo && run.repo !== filter.repo || filter.pattern && run.pattern !== filter.pattern) return false;
  if (filter.agent && !Object.values(run.roles).some(ids => ids.some(id => id === filter.agent))) return false;
  if (filter.section && (run.archived || (filter.section === "waiting" ? !needsYou(run) : needsYou(run) || (filter.section === "running" ? run.status !== "running" : run.status === "running")))) return false;
  switch (filter.status) {
    case "attention": return needsYou(run);
    case "running": return run.status === "running";
    case "passed": return runPassed(run);
    case "failing": return checksLabel(run) === "Failed" || ["failed", "stopped", "interrupted"].includes(run.status);
    case "flagged": return isFlagged(run);
    default: return true;
  }
}
