import { planRejected } from "./run-outcome.js";
import type { RunSummary } from "./engine.js";
import type { IntegrityIssue } from "./integrity.js";
import type { TeamState } from "./teams.js";

const TEAM_STATUS: Record<TeamState["status"], string> = {
  planning: "Building the team", awaiting_approval: "Plan ready for approval", running: "Working", blocked: "Unresolved work", verifying: "Verifying the result", completed: "Finished",
};

/**
 * A team's state in words, read with its run's: a team stopped mid-step (a stop, a revised goal)
 * still records the step it was on, so a run that ended says how it ended.
 */
export function teamStatusLabel(run: { status: string; rejected?: true; error?: string; supersededBy?: string; patternDone?: boolean; team?: Pick<TeamState, "status" | "awaitingRequestId"> }): string {
  const status = run.team?.status ?? "planning";
  if (planRejected(run as RunSummary)) return "Plan rejected";
  if (run.status === "running") return run.team?.awaitingRequestId ? "Waiting for your answer" : TEAM_STATUS[status];
  if (run.status === "done") return TEAM_STATUS[status];
  if (run.supersededBy) return "Stopped · goal revised";
  if (run.status === "stopped" && status === "blocked" && run.patternDone !== true) return TEAM_STATUS.blocked;
  return ({ stopped: "Paused", cancelled: "Stopped", interrupted: "Interrupted", failed: "Failed" } as Record<string, string>)[run.status] ?? TEAM_STATUS[status];
}

type Evidence = { status: string; verdict?: string; checkCantRun?: unknown } & Partial<Pick<RunSummary, "verification" | "loop" | "lastCheck" | "branchChecks" | "worktrees" | "artifacts">>;

/**
 * Shared presentation rules. Execution completion alone is never evidence of success.
 * The run's verdict belongs to its primary result (a race's winner, published first); another
 * result branch is judged by its own latest check, never by that verdict or another branch's check.
 */
export function checksLabel(run: Evidence, checking = false, branch?: string): string {
  if (checking) return "Running";
  if (run.status === "running") return "Pending";
  // A verification report of another branch says nothing about this one.
  const report = branch && run.verification?.branch && run.verification.branch !== branch ? undefined : run.verification;
  const reported = report && { verified: "Passed", "needs-changes": "Failed", blocked: "Blocked", unchecked: "Unverified" }[report.state];
  if (branch) {
    const own = run.branchChecks?.[branch];
    if (!own && !run.lastCheck && !run.verification) return run.loop?.check ? "Not verified" : "Not configured";
    if (!own && (run.verification?.branch ?? run.worktrees?.find(tree => tree.name === run.lastCheck?.worktree)?.branch) !== branch) return "Not verified for this branch";
    if (own && branch !== run.artifacts?.[0]?.branch) return run.checkCantRun ? "Blocked" : reported ?? (own.ok ? "Passed" : "Failed");
  }
  if (run.checkCantRun) return "Blocked";
  if (run.verdict === "failing") return "Failed";
  if (reported) return reported;
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
  const question = run.status === "running" && (!!run.team?.awaitingRequestId || run.approvalPending === true);
  if (run.awaiting || question) return true;
  if (run.projectTeam || run.taskExecution) return false;
  const latestTeam = run.teamTurns?.at(-1);
  if (latestTeam?.executionStatus && latestTeam.executionStatus !== "done" && run.status !== "running" || latestTeam?.reconciliation || latestTeam?.resolutionCheck?.ok === false || latestTeam?.teamEvidence?.check?.ok === false || latestTeam?.reviewStale || latestTeam?.resolutionReview?.approved === false) return true;
  return run.team?.status === "blocked" || run.triage?.state === "pending" || Object.values(run.watches ?? {}).some(watch => watch.state === "needs-you") ||
    run.status !== "running" && (run.status === "interrupted" || !run.seen);
}

/**
 * Test changes found in a result branch that could make its check pass without a fix: the whole
 * branch's (refreshed whenever it is published) and any a later follow-up made on it.
 */
export function integrityFor(run: Pick<RunSummary, "integrity" | "followUps" | "worktrees">, branch: string): IntegrityIssue[] {
  const tree = run.worktrees?.find(tree => tree.branch === branch)?.name;
  const issues = [...run.integrity?.[branch] ?? [], ...(run.followUps ?? []).filter(turn => turn.worktree === tree).flatMap(turn => turn.integrity ?? [])];
  return issues.filter((issue, index) => issues.findIndex(other => other.kind === issue.kind && other.file === issue.file) === index);
}
export const isFlagged = (run: RunSummary) => Object.keys(run.integrity ?? {}).length > 0 || !!run.followUps?.some(turn => turn.integrity?.length);
export const HISTORY_STATUSES = ["all", "attention", "running", "passed", "failing", "flagged"] as const;
export type HistoryStatus = typeof HISTORY_STATUSES[number];
export type ProjectSection = "waiting" | "running" | "results";
export interface HistoryFilter { status?: HistoryStatus; pattern?: string; agent?: string; repo?: string; section?: ProjectSection; archived?: "include" | "exclude" | "only" }
export function matchesHistoryFilter(run: RunSummary, filter: HistoryFilter): boolean {
  if (filter.archived === "exclude" && run.archived || filter.archived === "only" && !run.archived) return false;
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
