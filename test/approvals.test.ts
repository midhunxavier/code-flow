import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalRegistry } from "../src/approvals.js";

const action = (id = "provider-1") => ({ id, kind: "command" as const, command: "npm test", cwd: "/workspace", reason: "Run the check" });

test("approval responses are single-use, run/step scoped and expose immutable action details", async () => {
  const registry = new ApprovalRegistry();
  const controller = new AbortController();
  const pending = registry.request("run-a", "step-a", action(), controller.signal);
  const [record] = registry.list();
  assert.ok(record);
  assert.notEqual(record.id, record.requestId);
  record.command = "tampered";
  assert.equal(registry.list()[0]!.command, "npm test");
  assert.equal(registry.respond(record.id, "approve", { runId: "run-b" }), false);
  assert.equal(registry.respond(record.id, "approve", { stepId: "step-b" }), false);
  assert.equal(registry.respond(record.id, "approveForSession" as any), false);
  assert.equal(registry.respond(record.id, "approve", { runId: "run-a", stepId: "step-a" }), true);
  assert.equal(await pending, "approve");
  assert.equal(registry.respond(record.id, "approve"), false);
  assert.equal(registry.list("run-a")[0]!.status, "approved");
  assert.deepEqual(registry.list("run-b"), []);
  registry.close();
});

test("expiration and cancellation deny late approval and settle waiting adapters", async () => {
  const registry = new ApprovalRegistry({ defaultTimeoutMs: 20 });
  const expired = registry.request("run", "step", action(), new AbortController().signal);
  const [first] = registry.list();
  assert.equal(await expired, "decline");
  assert.equal(registry.respond(first!.id, "approve"), false);
  assert.equal(registry.list()[0]!.status, "expired");
  const controller = new AbortController();
  const cancelled = registry.request("run", "step", action("provider-2"), controller.signal);
  controller.abort();
  assert.equal(await cancelled, "decline");
  assert.equal(registry.list().find((record) => record.requestId === "provider-2")!.status, "cancelled");
  registry.close();
});

test("run/step cancellation is precise and shutdown cannot replay approvals", async () => {
  const registry = new ApprovalRegistry();
  const signal = new AbortController().signal;
  const one = registry.request("run-a", "step-a", action("one"), signal);
  const two = registry.request("run-a", "step-b", action("two"), signal);
  const three = registry.request("run-b", "step-a", action("three"), signal);
  registry.cancelStep("run-a", "step-a");
  assert.equal(await one, "decline");
  assert.equal(registry.list().filter((record) => record.status === "pending").length, 2);
  registry.cancelRun("run-a");
  assert.equal(await two, "decline");
  registry.close();
  assert.equal(await three, "decline");
  assert.equal(await registry.request("new", "step", action("four"), signal), "decline");
  const restarted = new ApprovalRegistry();
  assert.deepEqual(restarted.list(), []);
  restarted.close();
});

test("pending limits, duplicate requests and retained history stay bounded", async () => {
  const registry = new ApprovalRegistry({ maxPending: 3, maxPerRun: 2, maxPerStep: 1, maxRecords: 3 });
  const signal = new AbortController().signal;
  const one = registry.request("a", "1", action("one"), signal);
  assert.equal(await registry.request("a", "1", action("one"), signal), "decline");
  const two = registry.request("a", "2", action("two"), signal);
  assert.equal(await registry.request("a", "3", action("three"), signal), "decline");
  const three = registry.request("b", "1", action("three"), signal);
  assert.equal(await registry.request("c", "1", action("four"), signal), "decline");
  registry.cancelRun("a"); registry.cancelRun("b");
  await Promise.all([one, two, three]);
  for (let i = 0; i < 5; i++) {
    const pending = registry.request("c", "1", action(`next-${i}`), signal);
    const record = registry.list().find((candidate) => candidate.status === "pending")!;
    registry.respond(record.id, "decline");
    await pending;
  }
  assert.equal(registry.list().length, 3);
  registry.close();
});

test("malformed or incomplete actions never become approvable", async () => {
  const registry = new ApprovalRegistry();
  const signal = new AbortController().signal;
  for (const invalid of [ { ...action(), kind: "network" }, { ...action(), command: "" }, { id: "file", kind: "file-change", paths: [] }, { ...action(), command: "x".repeat(16_001) } ]) {
    assert.equal(await registry.request("run", "step", invalid as any, signal), "decline");
  }
  assert.deepEqual(registry.list(), []);
  registry.close();
});
