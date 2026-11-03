import type { RunManager } from "../engine.js";
import { assertWorktree, git } from "../git.js";
import { fail } from "../cli-teams/model.js";
import { captureSource } from "../cli-teams/snapshots.js";

/** An Agent → Team handoff snapshots owned work without committing or changing its index. */
export async function captureAgentSource(manager: RunManager, scope: { repo: string; project?: string; chatId?: string }, runId: string) {
  const run = manager.get(runId);
  if (!scope.chatId || !run || run.repo !== scope.repo || run.project !== scope.project || run.conversationId !== scope.chatId || run.pattern !== "solo") fail("scope_denied", "This Agent workspace belongs to another conversation");
  await manager.assertExecutionAllowed(scope.repo, run, "Agent workspace handoff");
  if (run.status === "running" && (!run.pauseRequested || run.steps.some(step => step.status === "running"))) fail("conflict", "Wait for the Agent writer to settle before preparing its handoff");
  const tree = run.worktrees.find(tree => tree.name === "solo");
  if (!tree) fail("recovery_required", "Inspect the preserved Agent workspace before continuing");
  const checkout = await assertWorktree(scope.repo, tree), listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], checkout);
  const untracked = listed.stdout.split("\0").filter(Boolean);
  if (untracked.length > 100) fail("context_limit", "The Agent workspace has more than 100 new files. Inspect and reduce the handoff before preparing a task.");
  const source = await captureSource(checkout, "working_changes", untracked);
  return { ...source, base: run.baseRef };
}
