import { test } from "node:test";
import assert from "node:assert/strict";
import { stoppedResult } from "../ui/task-result-format.js";

test("stopped results separate reviewer findings from preserved snapshot metadata", () => {
  const value = stoppedResult("Stopped: completion requirements were not met.\nReviewer: luna; target: artifact-1; verdict: changes_requested\nCould not inspect the code.\nBlocking findings:\n1. Inspection is unavailable.\n\nLatest preserved deliverable (artifact-1):\nCode snapshot abcdef1234567890\nBranch: codeflow/test/team\nWorktree: /repo with spaces/tree\nReview diff: git diff abcdef1..abcdef2");
  assert.equal(value?.reviews[0]?.reviewer, "luna");
  assert.match(value!.reviews[0]!.body, /Inspection is unavailable/);
  assert.doesNotMatch(value!.reviews[0]!.body, /Worktree/);
  assert.equal(value?.snapshot?.worktree, "/repo with spaces/tree");
  assert.equal(value?.snapshot?.commit, "abcdef1234567890");
});

test("unknown output remains intact, and plans and multiple review decisions retain their content", () => {
  assert.equal(stoppedResult("A plan containing Reviewer: luna"), undefined);
  const value = stoppedResult("Stopped: completion requirements were not met.\nGate failed.\nReviewer: claude; target: p; verdict: approve\nLooks good.\n\nReviewer: codex; target: p; verdict: changes_requested\nAdd tests.\n\nLatest preserved deliverable (p):\n# Plan\nKeep this plan in full.");
  assert.equal(value?.reason, "Gate failed.");
  assert.equal(value?.reviews.length, 2);
  assert.equal(value?.reviews[0]?.body, "Looks good.");
  assert.equal(value?.deliverable, "# Plan\nKeep this plan in full.");
  assert.equal(value?.snapshot, undefined);
});
