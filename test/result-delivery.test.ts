import { test } from "node:test";
import assert from "node:assert/strict";
import { localDeliveryProblem, prDelivery, validateTestRun } from "../src/result-delivery.js";
import type { RunSummary } from "../src/engine.js";
import type { PrMergeInfo } from "../src/github.js";

const pr = (patch: Partial<PrMergeInfo> = {}): PrMergeInfo => ({ number: 248, url: "https://github.com/o/r/pull/248", state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", ci: "pass", methods: ["squash"], ...patch });

test("a green PR behind main needs an update, not a merge", () => {
  assert.equal(prDelivery(pr({ mergeStateStatus: "BEHIND" })).action, "update");
  assert.equal(prDelivery(pr()).action, "merge");
  assert.equal(prDelivery(pr({ state: "MERGED" })).action, "archive");
});

test("GitHub blockers and missing evidence never offer merge", () => {
  for (const patch of [
    { isDraft: true }, { state: "CLOSED" }, { mergeable: "CONFLICTING" },
    { mergeStateStatus: "BLOCKED" }, { mergeStateStatus: "UNKNOWN" }, { mergeable: "UNKNOWN" },
    { ci: "pending" }, { ci: "fail" }, { ci: "none" },
    { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" },
  ] as Partial<PrMergeInfo>[]) assert.notEqual(prDelivery(pr(patch)).action, "merge", JSON.stringify(patch));
  assert.equal(prDelivery(pr(), "Unpublished changes").action, "review");
  assert.equal(prDelivery(pr({ mergeStateStatus: "BEHIND" }), "Unpublished changes").action, "review");
});

test("test-run intent is explicit validated metadata", () => {
  assert.equal(validateTestRun(undefined), undefined);
  assert.equal(validateTestRun(null), undefined);
  assert.deepEqual(validateTestRun({ reason: " Regression replay of a closed issue " }), { reason: "Regression replay of a closed issue" });
  for (const value of [true, "test", {}, { reason: " " }, { reason: "a".repeat(1001) }]) assert.throws(() => validateTestRun(value));
});

test("passing GitHub checks do not erase unresolved local findings or failed checks", () => {
  const run = { status: "done", artifacts: [{ branch: "result" }], worktrees: [{ name: "build", branch: "result" }], lastCheck: { worktree: "build" }, verdict: "passed" } as RunSummary;
  assert.equal(localDeliveryProblem(run, "result"), undefined);
  assert.match(localDeliveryProblem({ ...run, verdict: "failing" }, "result")!, /checks need attention/);
  assert.match(localDeliveryProblem({ ...run, review: { verdict: "changes_requested" } } as RunSummary, "result")!, /review needs attention/);
  assert.match(localDeliveryProblem({ ...run, findings: { result: { stale: true, findings: [] } } } as unknown as RunSummary, "result")!, /review needs attention/);
});
