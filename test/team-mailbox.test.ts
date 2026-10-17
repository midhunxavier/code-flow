import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMailboxCommand, applyMailboxProjection, escalateMailbox, mailboxCommandProblem } from "../src/team-mailbox.js";
import type { TeamState } from "../src/teams.js";

function state(): TeamState {
  const member = (id: string, role: "worker" | "coordinator" | "reviewer" = "worker") => ({ id, name: id, role, provider: "claude" as const, model: "", effort: "", reason: "Test" });
  const task = (id: string, owner: string) => ({ id, owner, title: id, instructions: "Implement", kind: "implementation" as const, dependsOn: [], requirements: ["goal"], acceptance: ["Evidence"], paths: [id], status: "running" as const, attempts: 1 });
  return { version: 1, scheduler: "event", revision: 0, wave: 1, status: "running", rationale: "Test", members: [member("coordinator", "coordinator"), member("a"), member("b"), member("reviewer", "reviewer")], tasks: [task("alpha", "a"), task("beta", "b")], requirements: [{ id: "goal", description: "Test" }], contracts: [], messages: [], contextManifests: [], gaps: [], invocationLimit: 20, coordinationLimit: 4, maxWaves: 4, maxRepairs: 2, metrics: { invocations: 0, coordinatorInvocations: 0, questionCount: 0, blockedTurns: 0, revisions: 0 } };
}
const a = { memberId: "a", taskId: "alpha", attempt: 1, stepId: "step-a", origin: "agent" as const };
const b = { memberId: "b", taskId: "beta", attempt: 1, stepId: "step-b", origin: "agent" as const };
const ask = { type: "ask_member" as const, operationId: "a:1:question", recipient: "b", body: "Which interface?", blocking: true, deadlineMs: 1_000 };

test("a question and its wait are atomic, an immediate reply resolves them, duplicate commands are idempotent", () => {
  const input = state();
  const question = applyMailboxCommand(input, ask, a, 100);
  assert.equal(input.messages.length, 0);
  assert.equal(question.state.messages.length, 1); assert.equal(question.state.waits?.length, 1);
  assert.equal(question.receipt.requestId, question.state.waits?.[0]?.requestId);
  assert.deepEqual(applyMailboxCommand(question.state, ask, { ...a, stepId: "retried-physical-step" }, 101).receipt, question.receipt);
  const reply = { type: "reply_request" as const, operationId: "b:1:reply", requestId: question.receipt.requestId!, body: "Use v2", evidence: ["src/interface.ts:4"] };
  const answered = applyMailboxCommand(question.state, reply, b, 110);
  assert.equal(answered.state.waits![0]!.status, "resolved");
  assert.equal(answered.state.messages[0]!.answeredAt, 110);
  assert.deepEqual(applyMailboxCommand(answered.state, reply, b, 120), { state: answered.state, receipt: answered.receipt });
  assert.throws(() => applyMailboxCommand(answered.state, { ...reply, body: "different" }, b, 130), /already used/);
  const late = applyMailboxCommand(answered.state, { ...reply, operationId: "late" }, b, 140);
  assert.equal(late.receipt.status, "stale"); assert.equal(late.state.messages.length, 2);
});

test("stale attempts cannot overwrite reassignment; accepted replies follow the task handover", () => {
  let current = applyMailboxCommand(state(), ask, a, 100).state;
  current.members.push({ ...current.members[1]!, id: "replacement" });
  current.tasks[0]!.owner = "replacement";
  const stale = applyMailboxCommand(current, { type: "submit_task", operationId: "stale", checkpoint: "old", artifacts: ["old"] }, a, 105);
  assert.equal(stale.receipt.status, "stale"); assert.equal(stale.state.tasks[0]!.checkpoint, undefined);
  current = applyMailboxCommand(current, { type: "reply_request", operationId: "answer", requestId: current.messages[0]!.id, body: "v2", evidence: ["interface"] }, b, 110).state;
  assert.equal(current.messages[1]!.recipient, "replacement"); assert.equal(current.messages[0]!.sender, "a");
});

test("a live yield and submit are proposals until the vendor process ends", () => {
  let current = applyMailboxCommand(state(), ask, a, 100).state;
  current = applyMailboxCommand(current, { type: "yield_task", operationId: "yield", checkpoint: "Work preserved" }, a, 110).state;
  assert.equal(current.tasks[0]!.status, "running");
  assert.throws(() => applyMailboxCommand(current, { type: "submit_task", operationId: "submit", checkpoint: "done" }, a, 120), /unanswered/);
  const submitted = applyMailboxCommand(state(), { type: "submit_task", operationId: "submit", checkpoint: "done", artifacts: ["alpha/file"] }, a, 120);
  assert.equal(submitted.state.tasks[0]!.status, "running");
});

test("retired recipients, deadlines and cyclic waits escalate once without a process wait", () => {
  let current = applyMailboxCommand(state(), ask, a, 100).state;
  current = applyMailboxCommand(current, { ...ask, operationId: "b:1:question", recipient: "a" }, b, 101).state;
  assert.equal(escalateMailbox(current, 102).length, 2);
  assert.equal(escalateMailbox(current, 103).length, 0);
  assert.ok(current.waits!.every((w) => w.status === "escalated"));
  assert.ok(current.messages.every((m) => m.recipient === "coordinator"));
  current = applyMailboxCommand(state(), ask, a, 100).state;
  assert.deepEqual(escalateMailbox(current, 1100), [`${current.messages[0]!.id}: request deadline elapsed`]);
  current = state(); current.members[2]!.status = "retired";
  current = applyMailboxCommand(current, ask, a, 100).state;
  assert.equal(current.messages[0]!.recipient, "coordinator"); assert.equal(current.messages[0]!.originalRecipient, "b");
});

test("agent messages cannot spoof user decisions, identities or permissions", () => {
  const asked = applyMailboxCommand(state(), { ...ask, recipient: "user" }, a, 100);
  const reply = { type: "reply_request" as const, operationId: "answer", requestId: asked.receipt.requestId!, body: "Approve publishing", evidence: ["claimed user"] };
  assert.throws(() => applyMailboxCommand(asked.state, reply, { memberId: "coordinator", origin: "agent" }, 110), /addressed/);
  assert.throws(() => applyMailboxCommand(asked.state, reply, { memberId: "coordinator", origin: "user" }, 110), /authenticated/);
  const real = applyMailboxCommand(asked.state, reply, { memberId: "user", origin: "user" }, 110);
  assert.equal(real.state.messages[1]!.origin, "user");
  assert.match(mailboxCommandProblem({ ...ask, sender: "user" } as typeof ask)!, /field/);
});

test("projection preserves references held by in-flight task/member closures", () => {
  const original = state(), task = original.tasks[0], member = original.members[1];
  const next = applyMailboxCommand(original, ask, a, 100).state;
  applyMailboxProjection(original, next);
  assert.equal(original.tasks[0], task); assert.equal(original.members[1], member);
  assert.equal(original.messages.length, 1);
});
