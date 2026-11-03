import { test } from "node:test";
import assert from "node:assert/strict";
import { taskView, type TaskViewInput } from "../src/conversational/view.js";
const input = (scope = "plan"): TaskViewInput => ({ task: { preparation: {} }, proposal: { definition: { scope, participants: [{ id: "haiku", provider: "claude", model: "haiku", effort: "high" }, { id: "luna", provider: "codex", model: "luna", effort: "high" }] } } });
function execution(value: TaskViewInput): NonNullable<TaskViewInput["execution"]> { value.proposal!.runId = "run-1"; return value.execution = { id: "run-1", status: "running", paused: false, pausePending: false, waitingForSlot: false, recoveryRequired: false, questions: [], participation: [{ id: "haiku", provider: "claude", model: "haiku", effort: "high", assignments: [{ id: "draft", status: "running", invocations: 1, sessionId: "native-haiku" }] }, { id: "luna", provider: "codex", model: "luna", effort: "high", assignments: [{ id: "review", status: "pending", invocations: 0 }] }] }; }
test("authorization describes the exact scope and never claims native participation", () => {
  for (const [scope, label] of [["plan", "Start planning"], ["review", "Start review"], ["write", "Start implementation"]]) {
    const view = taskView(input(scope)); assert.equal(view.startLabel, label); assert.equal(view.label, "Approach ready"); assert.ok(view.canStart); assert.ok(view.participants.every(p => p.participation === "Not invoked yet"));
  }
});
test("progress reports actual worker assignments and receipts", () => {
  const value = input(); execution(value); const view = taskView(value);
  assert.equal(view.stage, "haiku is working on draft"); assert.equal(view.participants[0]!.participation, "Native session recorded"); assert.equal(view.participants[1]!.participation, "Not invoked yet"); assert.ok(!view.canStart);
});
test("review completion does not claim fixes or passing checks", () => {
  const value = input("review"), run = execution(value); run.status = "done"; run.outcome = "review_complete";
  const view = taskView(value); assert.equal(view.label, "Review completed"); assert.match(view.notice!, /may still need fixes/); assert.equal(view.resultLabel, "View review");
});
test("unknown writes require inspection even if another error suggests retrying", () => {
  const value = input("write"), run = execution(value); run.status = "interrupted"; run.recoveryRequired = true; run.failureKind = "auth";
  const view = taskView(value); assert.equal(view.recovery, "inspect"); assert.equal(view.label, "Inspect preserved work"); assert.ok(!view.canStart && !view.canResume);
});
test("auth, limits, pauses and decisions have distinct recoveries", () => {
  const value = input(), run = execution(value); run.status = "failed"; run.failureKind = "auth"; assert.equal(taskView(value).recovery, "reconnect");
  run.failureKind = undefined; run.outcome = "stopped_limit"; assert.equal(taskView(value).recovery, "allowance");
  run.status = "running"; run.outcome = undefined; run.paused = true; assert.ok(taskView(value).canResume);
  run.questions = [{}]; assert.equal(taskView(value).label, "Waiting for your decision");
});

test("private chat stream topics are local-only for initial and incremental subscriptions", async () => {
  const { assertChatSubscriptions } = await import("../src/conversational/stream-access.js");
  for (const topic of ["chat:owned-id", "chats:all"]) {
    assert.doesNotThrow(() => assertChatSubscriptions([{ id: 1, topic }], "local"));
    for (const via of ["lan", "phone", "tailscale"]) assert.throws(() => assertChatSubscriptions([{ id: 1, topic }], via), /local owner/);
  }
  assert.doesNotThrow(() => assertChatSubscriptions([{ id: 1, topic: "runs" }], "phone"));
});
