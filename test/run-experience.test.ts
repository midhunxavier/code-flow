import { test } from "node:test";
import assert from "node:assert/strict";
import { checksLabel, executionLabel, nextRunAction, agentReviewLabel } from "../ui/run-experience.js";
import type { RunSummary } from "../ui/types.js";

const run = (patch: Partial<RunSummary> = {}) => ({ status: "done", loop: { check: "npm test" }, artifacts: [{ branch: "result", stat: "1 file changed" }], worktrees: [{ branch: "result" }], ...patch }) as RunSummary;

test("finished execution never implies successful checks or human review", () => {
  const finished = run();
  assert.equal(executionLabel(finished), "Finished");
  assert.equal(checksLabel(finished), "Not verified");
  assert.equal(agentReviewLabel(finished), "Not recorded");
  assert.equal(nextRunAction(finished)?.title, "Changes are ready to inspect");
  assert.equal(nextRunAction(run({ verdict: "passed" }))?.title, "Ready for your review");
  assert.equal(checksLabel(run({ verdict: "passed", status: "running" })), "Pending");
  assert.equal(checksLabel(run({ verdict: "passed", checkCantRun: { command: "npm test", reason: "missing dependency" } })), "Blocked");
  assert.equal(checksLabel(run({ verdict: "failing", verification: { state: "verified" } as RunSummary["verification"] })), "Failed");
});

test("pending decisions take precedence and stopped questions require resuming first", () => {
  assert.equal(nextRunAction(run({ status: "running", awaiting: { kind: "plan", title: "Plan", content: "", at: 0 } }))?.kind, "approval");
  assert.equal(nextRunAction(run({ status: "running", team: { awaitingRequestId: "q" } as RunSummary["team"] }))?.kind, "question");
  assert.equal(nextRunAction(run({ status: "interrupted", team: { awaitingRequestId: "q" } as RunSummary["team"] }))?.kind, "resume");
  assert.equal(nextRunAction(run({ status: "running" })), null);
});
test("reviewing another branch cannot borrow the winning branch's verification", () => {
  const checked = run({ verdict: "passed", lastCheck: { ok: true, command: "test", worktree: "build", at: 1 }, worktrees: [{ name: "build", branch: "result", path: "/result" }], findings: { result: { reviewer: "claude", round: 1, verdict: "approve", findings: [], at: 1 } } });
  assert.equal(checksLabel(checked, false, "result"), "Passed");
  assert.equal(checksLabel(checked, false, "other"), "Not verified for this branch");
  assert.equal(agentReviewLabel(checked, "result"), "Approved");
  assert.equal(agentReviewLabel(checked, "other"), "Not recorded for this branch");
});

test("recovery actions preserve the distinction between configuration, code failures and providers", () => {
  assert.equal(nextRunAction(run({ verdict: "failing" }))?.kind, "revise");
  assert.equal(nextRunAction(run({ checkCantRun: { command: "npm test", reason: "missing executable" } }))?.kind, "check");
  assert.equal(nextRunAction(run({ status: "failed", error: "Authentication failed" }))?.kind, "provider");
  assert.equal(nextRunAction(run({ status: "failed", error: "Command exited 1" }))?.label, "Retry unfinished work");
  assert.equal(nextRunAction(run({ status: "stopped", stopReason: "time limit" }))?.label, "Extend budget & resume");
  assert.equal(nextRunAction(run({ artifacts: [], worktrees: [] })), null);
  assert.equal(nextRunAction(run({ supersededBy: "new-run" })), null);
});
