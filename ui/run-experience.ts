import { checksLabel } from "../src/run-status.js";
export { checksLabel } from "../src/run-status.js";
import type { AgentId, Run, RunSummary } from "./types.js";
import { teamAwaitingAnswer, teamNeedsResume } from "./team-state.js";

/** A combined team result has no writing step of its own; its lead handles follow-ups. */
export function resultAgent(run: Pick<Run, "pattern" | "conversationAgent" | "roles" | "steps" | "team"> | null, worktree?: string): AgentId | undefined {
  if (!run || !worktree) return;
  if (run.pattern === "solo") return run.conversationAgent ?? run.roles.agent?.[0];
  const writer = [...run.steps].reverse().find(step => (step.kind ?? "agent") === "agent" && step.worktree === worktree && step.mode === "write" && !step.sideOf)?.agent;
  return writer ?? (worktree === "integration" ? run.team?.members.find(member => member.role === "coordinator" && member.status !== "retired")?.provider ?? run.roles.coordinator?.[0] : undefined);
}

/** Execution and evidence are independent: finishing a turn never implies passing checks. */
export function executionLabel(run: RunSummary): string {
  if (run.status === "running" && (run.awaiting || teamAwaitingAnswer(run))) return "Waiting for you";
  const turn = run.teamTurns?.at(-1);
  if (run.status === "done" && turn && (turn.executionStatus && turn.executionStatus !== "done" || turn.reconciliation || turn.resolutionCheck?.ok === false || turn.resolutionReview?.approved === false || turn.reviewStale)) return "Needs attention";
  return { running: "Running", done: "Finished", failed: "Failed", stopped: "Paused", interrupted: "Interrupted", cancelled: "Stopped" }[run.status] ?? run.status;
}

export function agentReviewLabel(run: RunSummary, branch?: string): string {
  if (run.status === "running") return "Pending";
  if (run.teamTurns?.at(-1)?.reviewStale) return "Review outdated";
  const combinedReview = run.teamTurns?.at(-1)?.resolutionReview;
  if (combinedReview?.approved !== undefined) return combinedReview.approved ? "Approved" : "Changes requested";
  const selected = branch ?? run.artifacts[0]?.branch;
  const findings = selected ? run.findings?.[selected] : undefined;
  if (findings?.stale) return "Review outdated";
  if (findings) return findings.findings.some(finding => finding.blocking) ? "Changes requested" : findings.verdict === "approve" ? "Approved" : "No blocking findings";
  if (branch && branch !== run.artifacts[0]?.branch) return "Not recorded for this branch";
  if (run.review) return run.review.verdict === "approve" ? "Approved" : "Changes requested";
  if (run.team?.verification?.reviewed) return run.team.verification.approved ? "Approved" : "Changes requested";
  return "Not recorded";
}

export interface NextAction {
  kind: "approval" | "question" | "resume" | "provider" | "check" | "revise" | "review" | "triage";
  title: string;
  detail: string;
  label: string;
  branch?: string;
}

export function nextRunAction(run: RunSummary): NextAction | null {
  // Archived runs are history. Their worktree records do not imply folders remain,
  // and a completed/merged result should not be presented as new work to review.
  if (run.archived) return null;
  const artifact = run.artifacts.find(a => a.stat?.trim() && run.worktrees.some(w => w.branch === a.branch));
  if (run.status === "running") {
    if (run.awaiting) return { kind: "approval", title: "Your plan is ready", detail: "Read the proposed plan and approve it or request changes before work continues.", label: "Review plan" };
    if (teamAwaitingAnswer(run)) return { kind: "question", title: "The team needs your answer", detail: "Answer the open question to unblock the next step.", label: "Answer question" };
    return null;
  }
  if (run.supersededBy) return null;
  if (["failed", "interrupted", "stopped", "cancelled"].includes(run.status)) {
    if (/not (?:logged|signed) in|authentication|unauthori[sz]ed|login required|credentials? (?:expired|missing)|token expired/i.test(run.error ?? "")) return { kind: "provider", title: "The provider needs attention", detail: "Check the provider's login instructions, then resume. Recorded work remains on this run's branches.", label: "Reconnect provider" };
    return { kind: "resume", title: teamNeedsResume(run) ? "The team has unfinished work" : run.status === "stopped" ? "The execution limit was reached" : run.status === "failed" ? "The run could not finish" : "Work is paused", detail: `${run.error || run.stopReason || "Execution stopped before completion."} Recorded results are reused when you resume with a fresh budget.`, label: run.status === "stopped" && !teamNeedsResume(run) ? "Extend budget & resume" : run.status === "failed" ? "Retry unfinished work" : "Resume work" };
  }
  if (run.triage?.state === "pending") return { kind: "triage", title: "Review this automation result", detail: "Inspect the evidence before approving, requesting changes, or rejecting this result.", label: "Review result" };
  const checks = checksLabel(run);
  if (checks === "Blocked" || checks === "Not configured") return { kind: "check", title: checks === "Blocked" ? "Verification needs attention" : "No automated check is configured", detail: `${run.checkCantRun?.reason ?? "Choose a runnable check before relying on this result."} You can configure a continuation from the saved result branch.`, label: "Fix check command", branch: artifact?.branch };
  if (checks === "Failed") return { kind: "revise", title: "Checks need a fix", detail: "The run finished, but its checks failed. Send a follow-up using the existing result and review the new evidence.", label: "Request a fix", branch: artifact?.branch };
  if (artifact) {
    const review = agentReviewLabel(run, artifact.branch);
    const blocked = review === "Changes requested" || review === "Review outdated";
    return { kind: "review", title: blocked ? "Changes need attention" : checks === "Passed" ? "Ready for your review" : "Changes are ready to inspect", detail: blocked ? "Review the findings and ask the agent for a revision in chat." : checks === "Passed" ? "Inspect the changes and evidence before publishing." : "Independent verification is incomplete. Review the evidence before using these changes.", label: "Review changes", branch: artifact.branch };
  }
  return null;
}
