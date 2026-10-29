import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinatorInvocationLimit, budgetDuration, MAX_EXECUTION_BUDGET } from "../src/execution-budget.js";

test("coordination leaves room for workers and review while allowing planning retries and reports", () => {
  assert.equal(coordinatorInvocationLimit(8), 4, "small missions can plan, retry, coordinate and report");
  assert.equal(coordinatorInvocationLimit(40), 20);
  assert.equal(coordinatorInvocationLimit(200), 100);
  for (let calls = 4; calls <= MAX_EXECUTION_BUDGET.maxSteps; calls++) {
    assert.ok(coordinatorInvocationLimit(calls) <= calls - 2, "reserve at least one worker and review call");
  }
});


test("budget summaries use readable hours and keep partial hours", () => {
  assert.equal(budgetDuration(1), "1 minute");
  assert.equal(budgetDuration(45), "45 minutes");
  assert.equal(budgetDuration(60), "1 hour");
  assert.equal(budgetDuration(90), "1 hour 30 min");
  assert.equal(budgetDuration(720), "12 hours");
  assert.equal(budgetDuration(1440), "24 hours");
});
