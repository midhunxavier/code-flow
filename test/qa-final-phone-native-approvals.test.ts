import test from "node:test";
import assert from "node:assert/strict";
import { RunManager, type Run } from "../src/engine.js";
import { approvals } from "../src/approvals.js";
import { renderRemote } from "../src/remote.js";

for (const provider of ["claude", "codex"] as const) test(`read-only phone lists and details a live ${provider} approval without granting control`, async () => {
  const manager = new RunManager(), controller = new AbortController();
  const run = {
    id: `phone-native-${provider}`, task: `Approve ${provider} tool`, repo: "/qa-phone", pattern: "solo",
    status: "running", seen: true, createdAt: Date.now(), roles: { agent: [provider] },
    steps: [], worktrees: [], artifacts: [], merges: [], prs: {}, watches: {},
  } as unknown as Run;
  (manager as any).runs.set(run.id, run);
  (manager as any).runIndex.set(run);
  const decision = approvals.request(run.id, "step", { id: `${provider}-tool`, kind: "command", command: "printf fixture" }, controller.signal);
  try {
    assert.equal(manager.list()[0]!.approvalPending, true);
    const list = renderRemote(manager, [], "/r/fixture", "/")!;
    assert.match(list, /<h2>Needs you \(1\)<\/h2>/);
    assert.match(list, /Waiting for you/);
    assert.doesNotMatch(list, /<h2>Running/);
    const detail = renderRemote(manager, [], "/r/fixture", `/run/${run.id}`)!;
    assert.match(detail, /Waiting for you/);
    assert.match(detail, /tool approval.*full-control app/i);
    assert.doesNotMatch(detail, /<form|<button|\/api\/approvals/);
    assert.equal(Object.hasOwn(run, "approvalPending"), false, "phone rendering must not persist live approval state");

    const request = approvals.list(run.id).find(record => record.status === "pending")!;
    assert.ok(approvals.respond(request.id, "approve", { runId: run.id }));
    assert.equal(await decision, "approve");
    const resolved = renderRemote(manager, [], "/r/fixture", "/")!;
    assert.doesNotMatch(resolved, /Needs you|Waiting for you/);
    assert.match(resolved, /<h2>Running \(1\)<\/h2>/);
    assert.doesNotMatch(renderRemote(manager, [], "/r/fixture", `/run/${run.id}`)!, /Waiting for you|tool approval/i);

    const obsolete = approvals.request(run.id, "step", { id: `${provider}-old-tool`, kind: "command", command: "true" }, controller.signal);
    run.status = "stopped"; (manager as any).runIndex.set(run);
    assert.doesNotMatch(renderRemote(manager, [], "/r/fixture", "/")!, /Needs you|Waiting for you/);
    assert.doesNotMatch(renderRemote(manager, [], "/r/fixture", `/run/${run.id}`)!, /Waiting for you|tool approval/i);
    run.archived = true; (manager as any).runIndex.set(run);
    assert.doesNotMatch(renderRemote(manager, [], "/r/fixture", "/")!, new RegExp(run.id));
    controller.abort(); await obsolete;
  } finally { controller.abort(); await decision; await manager.shutdown(); }
});
