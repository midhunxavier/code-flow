import type { PrMergeInfo } from "./github.js";
import type { RunSummary } from "./engine.js";
import { checksLabel } from "./run-status.js";

export function localDeliveryProblem(run: RunSummary, branch: string): string | undefined {
  const checks = checksLabel(run, false, branch);
  if (["Failed", "Blocked"].includes(checks)) return "The run's checks need attention. Ask the agent to fix them before publishing.";
  const findings = run.findings?.[branch], turn = run.teamTurns?.at(-1);
  if (findings?.stale || findings?.findings.some(f => f.blocking) || turn?.reviewStale || turn?.resolutionReview?.approved === false ||
      !findings && (run.review?.verdict === "changes_requested" || run.team?.verification?.reviewed && !run.team.verification.approved)) return "The run's review needs attention. Review the findings and ask for a revision before publishing.";
}

export interface TestRun { reason: string }
export function validateTestRun(value: unknown): TestRun | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || typeof (value as TestRun).reason !== "string" || !(value as TestRun).reason.trim() || (value as TestRun).reason.length > 1000) throw new Error("Describe why this is a test run (up to 1,000 characters)");
  return { reason: (value as TestRun).reason.trim() };
}

export type DeliveryAction = "review" | "archive" | "update" | "merge" | "wait" | "github";
export interface ResultDelivery {
  kind: "test" | "result" | "pr";
  title: string;
  detail: string;
  action: DeliveryAction;
  label: string;
  pr?: PrMergeInfo;
  localHead?: string;
  changedSinceRun?: boolean;
}

/** One next step, based on current GitHub evidence, never on the run's old green badge. */
export function prDelivery(pr: PrMergeInfo, localProblem?: string): ResultDelivery {
  const result = (title: string, detail: string, action: DeliveryAction, label: string): ResultDelivery => ({ kind: "pr", title, detail, action, label, pr });
  if (pr.state === "MERGED") return result(`PR #${pr.number} merged`, `The changes are in ${pr.baseRefName}. You can archive this conversation.`, "archive", "Archive run");
  if (pr.state === "CLOSED") return result(`PR #${pr.number} is closed`, "This pull request was closed without merging. Review it on GitHub before deciding what to do next.", "github", "Open pull request");
  if (localProblem) return result("Review your changes first", localProblem, "review", "Review changes");
  if (pr.isDraft) return result("PR is still a draft", "Mark it ready for review on GitHub when you are happy with the changes.", "github", "Open pull request");
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return result("Resolve merge conflicts", `This PR conflicts with ${pr.baseRefName}. Ask the agent to resolve the conflicts, then run the checks again.`, "github", "Open pull request");
  if (pr.mergeStateStatus === "BEHIND") return result("Update PR before merging", `Bring in the latest ${pr.baseRefName}, then wait for GitHub checks on the updated branch.`, "update", "Update branch");
  if (pr.ci === "fail") return result("GitHub checks need attention", "Ask the agent to fix the failing checks. Merge will be available when the PR passes.", "github", "View failing checks");
  if (pr.ci === "pending") return result("Waiting for GitHub checks", "Checks are running on the current PR commit. This card updates automatically.", "wait", "Checks running…");
  if (pr.reviewDecision === "CHANGES_REQUESTED") return result("Review changes requested", "Address the GitHub review feedback before merging.", "github", "View review feedback");
  if (pr.reviewDecision === "REVIEW_REQUIRED") return result("Waiting for required review", "GitHub requires an approval before this pull request can merge.", "github", "Open pull request");
  if (pr.ci === "none") return result("GitHub checks not available yet", "No checks are reported for this PR commit. Review its checks and repository requirements on GitHub.", "github", "Open pull request");
  if (pr.mergeable !== "MERGEABLE" || !["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus ?? "")) return result("GitHub has not cleared this PR", "GitHub is checking mergeability or repository requirements still block merging. This card updates automatically.", "github", "Open pull request");
  return result(`PR #${pr.number} is ready to merge`, `GitHub checks pass on the current commit. Review the pull request, then merge into ${pr.baseRefName}.`, "merge", "Merge pull request");
}
