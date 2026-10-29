import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinatorInvocationLimit } from "../src/execution-budget.js";

test("coordination leaves room for workers and review while allowing planning retries and reports", () => {
  assert.equal(coordinatorInvocationLimit(8), 4, "small missions can plan, retry, coordinate and report");
  assert.equal(coordinatorInvocationLimit(40), 20);
  assert.equal(coordinatorInvocationLimit(200), 100);
  for (let calls = 4; calls <= 200; calls++) {
    assert.ok(coordinatorInvocationLimit(calls) <= calls - 2, "reserve at least one worker and review call");
  }
});
