import { planRejected, dispatchLabel } from "../src/run-outcome.js";
import { classifyError } from "../src/adapters/errors.js";
import { checksLabel, integrityFor, runState } from "../src/run-status.js";
export { checksLabel, integrityFor } from "../src/run-status.js";
import type { AgentId, Run, RunSummary, Step } from "./types.js";
import { teamAwaitingAnswer, teamNeedsResume } from "./team-state.js";

/**
 * An Agent chat's provider, which every turn of its own thread goes to (replies, review comments, fixes);
 * the server refuses another. A run summary has it, so it's known before the run's steps load.
 */
export function chatProvider(run: Pick<RunSummary, "pattern" | "conversationAgent" | "roles"> | null | undefined): AgentId | undefined {
  return run?.pattern === "solo" ? run.conversationAgent ?? run.roles.agent?.[0] : undefined;
}

/** A combined team result has no writing step of its own; its lead handles follow-ups. */
export function resultAgent(run: Pick<Run, "pattern" | "conversationAgent" | "roles" | "steps" | "team"> | null, worktree?: string): AgentId | undefined {
  if (!run || !worktree) return;
  if (run.pattern === "solo") return chatProvider(run);
  const writer = [...run.steps].reverse().find(step => (step.kind ?? "agent") === "agent" && step.worktree === worktree && step.mode === "write" && !step.sideOf)?.agent;
  return writer ?? (worktree === "integration" ? run.team?.members.find(member => member.role === "coordinator" && member.status !== "retired")?.provider ?? run.roles.coordinator?.[0] : undefined);
}

export interface ReplyTarget { agent: AgentId; worktree: string; /** Its branch is (one of) the run's result. */ delivered: boolean }
/**
 * Who a reply after the run can go to directly: each agent that wrote code, in its worktree, unless
 * its branch was deleted. A team's result worktree has no writing step of its own (its merges and
 * checks are code-flow's), so its lead takes a reply there. It comes first: a reply on a worker's
 * branch never reaches what the team delivered.
 */
export function replyTargets(run: Pick<RunSummary, "pattern" | "conversationAgent" | "roles" | "team" | "artifacts" | "worktrees" | "deletedWorktrees" | "chatLink">, steps: Step[]): ReplyTarget[] {
  const delivered = (worktree: string) => run.artifacts.some(artifact => artifact.branch === run.worktrees.find(tree => tree.name === worktree)?.branch);
  const deleted = new Set((run.deletedWorktrees ?? []).filter(gone => !run.worktrees.some(tree => tree.name === gone.name)).map(gone => gone.name));
  const writers = [...new Map(steps.filter(step => (step.kind ?? "agent") === "agent" && (step.mode === "write" || run.chatLink?.kind === "side") && step.agent && step.worktree && !deleted.has(step.worktree))
    .map(step => [`${step.agent}@${step.worktree}`, { agent: step.agent!, worktree: step.worktree!, delivered: delivered(step.worktree!) }])).values()];
  if (!run.team) return writers;
  const results = run.worktrees.filter(tree => delivered(tree.name)).flatMap(tree => {
    const agent = resultAgent({ ...run, steps }, tree.name);
    return agent ? [{ agent, worktree: tree.name, delivered: true }] : [];
  });
  return [...results, ...writers.filter(writer => !results.some(result => result.agent === writer.agent && result.worktree === writer.worktree))];
}

/**
 * A status line saying code-flow refused an agent's request on its own, without asking you (the
 * Codex and Claude adapters word them so). A finished turn keeps these in view, outside "Show work".
 */
export function declinedUnasked(text: string): boolean {
  return /^(code-flow declined |Blocked by this run's permission rules)/.test(text);
}

/**
 * Execution and evidence are independent: finishing a turn never implies passing checks.
 * `approvalPending`: a tool approval or question of this run waits in the inbox.
 */
export function executionLabel(run: RunSummary, approvalPending = false): string {
  if (run.status === "running" && (run.awaiting || teamAwaitingAnswer(run) || approvalPending)) return "Waiting for you";
  if (planRejected(run) || dispatchLabel(run, "steps" in run ? (run as Run).steps : undefined) === "Dispatch paused") return "Stopped";
  const turn = run.teamTurns?.at(-1);
  if (run.status === "done" && (run.triage?.state === "pending" || turn && (turn.executionStatus && turn.executionStatus !== "done" || turn.reconciliation || turn.resolutionCheck?.ok === false || turn.teamEvidence?.check?.ok === false || turn.resolutionReview?.approved === false || turn.reviewStale))) return "Waiting for you";
  return { running: "Working", done: "Finished", failed: "Stopped", stopped: "Stopped", interrupted: "Stopped", cancelled: "Stopped" }[run.status] ?? run.status;
}

/** A status dot must communicate its evidence state in text as well as color. */
export function sidebarStatusLabel(run: RunSummary): string {
  const label = executionLabel(run);
  const evidence = ({ failing: "Check failing", unchecked: "Check can't run", unverified: "not verified" } as Record<string, string>)[runState(run)];
  return label === "Finished" && evidence ? `${label} · ${evidence}` : label;
}

/** Describe only recorded evidence; a completed answer is not proof that checks passed. */
export function resultSummary(run: RunSummary) {
  const changes = run.artifacts.filter(artifact => artifact.stat?.trim());
  const unknown = run.artifacts.some(artifact => artifact.stat === undefined);
  return {
    changes: changes.length ? changes.map(artifact => artifact.stat!.trim()).join("\n") : unknown ? "The file changes could not be inspected." : "No file changes were recorded. Review the answer for the result.",
    check: ({ Passed: "Recorded checks passed.", Failed: "Checks failed. Review the failures before using the changes.", Blocked: "Checks could not run.", "Not verified": "Checks have not been verified.", "Not configured": "No automated checks were configured." } as Record<string, string>)[checksLabel(run)] ?? checksLabel(run),
    branch: run.artifacts.find(artifact => artifact.stat === undefined || artifact.stat.trim())?.branch,
  };
}

/** What the header says besides execution: that the run is archived history, and where its result was merged. */
export function runStateBadges(run: Pick<RunSummary, "archived" | "merges">): string[] {
  const into = [...new Set((run.merges ?? []).map((merge) => merge.into))];
  return [...(run.archived ? ["Archived"] : []), ...(into.length ? [`Merged into ${into.join(", ")}`] : [])];
}

/** Every result branch of a finished run was deleted (see Run.deletedWorktrees): its changes are gone. */
export const branchesGone = (run: Pick<RunSummary, "worktrees" | "deletedWorktrees">): boolean => !run.worktrees.length && !!run.deletedWorktrees?.length;

export const TESTS_CHANGED = "Passed · tests changed";
/**
 * The checks as the result summarises them: a pass that relies on deleted, skipped or weakened
 * tests is not shown as a clean pass. (Stats and filters keep using `checksLabel`.)
 */
export function checksSummary(run: RunSummary, checking = false, branch?: string): string {
  const checks = checksLabel(run, checking, branch), result = branch ?? run.artifacts[0]?.branch;
  return checks === "Passed" && result && integrityFor(run, result).length ? TESTS_CHANGED : checks;
}

export function agentReviewLabel(run: RunSummary, branch?: string): string {
  if (run.status === "running") return "Pending";
  const turn = run.teamTurns?.at(-1);
  if (turn?.reviewStale) return "Outdated";
  const combinedReview = turn?.resolutionReview;
  if (combinedReview?.approved !== undefined) return combinedReview.approved ? "Approved" : "Changes requested";
  // The team's own independent review of exactly the files now in the conversation workspace.
  if (turn?.teamEvidence?.review) return turn.teamEvidence.review.approved ? "Approved" : "Changes requested";
  const selected = branch ?? run.artifacts[0]?.branch;
  const findings = selected ? run.findings?.[selected] : undefined;
  if (findings?.stale) return "Outdated";
  if (findings) return findings.findings.some(finding => finding.blocking) ? "Changes requested" : findings.verdict === "approve" ? "Approved" : "No blocking findings";
  if (branch && branch !== run.artifacts[0]?.branch) return "Not recorded for this branch";
  if (run.review) return run.review.verdict === "approve" ? "Approved" : "Changes requested";
  if (run.team?.verification?.reviewed) return run.team.verification.approved ? "Approved" : "Changes requested";
  return "Not recorded";
}

export interface NextAction {
  kind: "approval" | "question" | "resume" | "provider" | "check" | "revise" | "review" | "triage" | "mission" | "rerun" | "publish-review" | "provider-limit";
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
  // A mission run is never resumed: its mission starts a new bounded cycle or revision instead.
  if (run.projectTeam && ["failed", "interrupted", "stopped", "cancelled"].includes(run.status)) return { kind: "mission", title: "Continue from the project mission", detail: `${run.status === "interrupted" ? "Code Flow stopped while this run was in progress." : run.error || run.stopReason || "Execution stopped before completion."} Mission runs can't be resumed; start a new cycle or request a revision from the mission.`, label: "Open the mission" };
  if (["failed", "interrupted", "stopped", "cancelled"].includes(run.status)) {
    if (planRejected(run)) return { kind: "rerun", title: "You rejected the plan", detail: "This run ended at the rejected checkpoint. Edit the task and start a new run for a fresh plan.", label: "Edit & run again" };
    if (run.providerLimit || /^usage limit of /.test(run.stopReason ?? "")) return { kind: "provider-limit", title: `${run.providerLimit?.name ?? run.stopReason?.replace(/^usage limit of /, "") ?? "The provider"} reached its usage limit`, detail: `${run.providerLimit?.resetsAt ? `Reset reported for ${new Date(run.providerLimit.resetsAt).toLocaleString()}. ` : ""}Resume after the reset or switch the provider for this role. Recorded work is kept; a larger run budget does not change this limit.`, label: "Check provider usage" };
    if (run.failure?.kind === "auth" || !run.failure && classifyError(run.error) === "auth") return { kind: "provider", title: "The provider needs attention", detail: "Check the provider's login instructions, then resume. Recorded work remains on this run's branches.", label: "Reconnect provider" };
    // A recorded reason doesn't always end a sentence; the next one starts after it.
    const reason = (run.error || run.stopReason || "Execution stopped before completion.").trim();
    return { kind: "resume", title: teamNeedsResume(run) ? "The team has unfinished work" : run.status === "stopped" ? "The execution limit was reached" : run.status === "failed" ? "The run could not finish" : run.status === "cancelled" ? "Stopped by you" : "Work is paused", detail: `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Recorded results are reused when you resume with a fresh budget.`, label: run.status === "stopped" && !teamNeedsResume(run) ? "Extend budget & resume" : run.status === "failed" ? "Retry unfinished work" : "Resume work" };
  }
  if (run.triage?.state === "pending") return { kind: "triage", title: "Review this automation result", detail: "Inspect the evidence before approving, requesting changes, or rejecting this result.", label: "Review result" };
  // Nothing is left to check, review or continue from.
  if (branchesGone(run)) return null;
  if (run.review && !artifact) return { kind: "publish-review", title: run.review.verdict === "approve" ? "The council approves" : "The council requested changes", detail: "Read the findings, then post the review to the pull request or copy it.", label: "Read and publish review" };
  const checks = checksLabel(run);
  if (checks === "Blocked" || checks === "Not configured" && artifact) return { kind: "check", title: checks === "Blocked" ? "Verification needs attention" : "No automated check is configured", detail: `${sentence(run.checkCantRun?.reason ?? "Choose a runnable check before relying on this result.")} You can configure a continuation from ${artifact ? "the saved result branch" : "the original base"}.`, label: "Fix check command", branch: artifact?.branch };
  if (checks === "Failed") return { kind: "revise", title: "Checks need a fix", detail: "The run finished, but its checks failed. Send a follow-up using the existing result and review the new evidence.", label: "Request a fix", branch: artifact?.branch };
  if (artifact) {
    const review = agentReviewLabel(run, artifact.branch);
    const blocked = review === "Changes requested" || review === "Outdated";
    return { kind: "review", title: blocked ? "Changes need attention" : checks === "Passed" ? "Ready for your review" : "Changes are ready to inspect", detail: blocked ? "Review the findings and ask the agent for a revision in chat." : checks === "Passed" ? "Inspect the changes and evidence before publishing." : "Independent verification is incomplete. Review the evidence before using these changes.", label: "Review changes", branch: artifact.branch };
  }
  return null;
}

const sentence = (text: string) => /[.!?]$/.test(text.trim()) ? text.trim() : text.trim() + ".";
