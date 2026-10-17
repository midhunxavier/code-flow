import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-rollout-engine-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
const { RunManager } = await import("../src/engine.js");
const { adapters } = await import("../src/adapters/index.js");
const { flushWrites } = await import("../src/store.js");
const repo = mkdtempSync(join(tmpdir(), "codeflow-rollout-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
const pattern: Pattern = { id: "auto-team", name: "Fixture", summary: "", description: "", roles: [], options: [], async run(ctx) { await ctx.worktree("integration"); return "done"; } };
async function ended(run: Run) {
  const deadline = Date.now() + 15_000;
  while (run.status === "running") {
    if (Date.now() > deadline) throw new Error("Run did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
after(async () => { await flushWrites(); rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });

test("disabling Auto only gates new runs; saved recovery and manual patterns keep working", async () => {
  const manager = new RunManager(() => pattern);
  const previous = process.env.CODEFLOW_AUTO_TEAM_ENABLED;
  try {
    delete process.env.CODEFLOW_AUTO_TEAM_ENABLED;
    const run = await manager.start({ pattern, repo, task: "Fixture", roles: {}, options: {}, approvals: { plan: false } });
    await ended(run);
    assert.equal(run.options.eventDriven, true);
    process.env.CODEFLOW_AUTO_TEAM_ENABLED = "false";
    await assert.rejects(manager.start({ pattern, repo, task: "Fixture", roles: {}, options: {} }), /disabled/);
    await manager.resume(run.id); await ended(run);
    assert.equal(run.status, "done");
    assert.ok(run.recovery?.records);
    const manual = await manager.start({ pattern: { ...pattern, id: "manual-fixture" }, repo, task: "Fixture", roles: {}, options: {} });
    await ended(manual);
    assert.equal(manual.status, "done");
    assert.equal(manual.options.eventDriven, undefined);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_AUTO_TEAM_ENABLED; else process.env.CODEFLOW_AUTO_TEAM_ENABLED = previous;
    await manager.shutdown();
  }
});

test("explicit follow-up budgets cap actual retries and retain the chosen result workspace", async () => {
  const manager = new RunManager(() => pattern);
  const oldAdapter = adapters.claude.run;
  let calls = 0;
  adapters.claude.run = async () => { calls++; return { ok: false, finalText: "", errorKind: "transient", error: "Temporary error" }; };
  try {
    const run = await manager.start({ pattern, repo, task: "Fixture", roles: {}, options: {}, approvals: { plan: false } });
    await ended(run);
    await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree: "integration", agent: "claude", message: "Retry safely", budget: { maxInvocations: 0 } }), /budget/);
    await manager.followUp(run.id, { kind: "reply", worktree: "integration", agent: "claude", message: "Retry safely", budget: { maxSteps: 2, maxInvocations: 1, maxMinutes: 1 } });
    await ended(run);
    assert.equal(calls, 1);
    assert.equal(run.loop.maxInvocations, 1);
    assert.deepEqual(run.followUps[0]?.budget, { maxSteps: 2, maxInvocations: 1, maxMinutes: 1 });
    assert.equal(run.followUps[0]?.worktree, "integration");
  } finally { adapters.claude.run = oldAdapter; await manager.shutdown(); }
});

test("goal revisions stop the prior team before a new approval and retain source trust, artifacts and attachments", async () => {
  const approvalPattern: Pattern = { ...pattern, async run(ctx) { await ctx.worktree("integration"); await ctx.approve("plan", "Review goal", ctx.task); return "done"; } };
  const manager = new RunManager(() => approvalPattern);
  try {
    const original = await manager.start({ pattern: approvalPattern, repo, task: "Original goal", roles: {}, options: {}, approvals: { plan: true }, context: { attachments: [{ name: "requirements.txt", data: Buffer.from("Preserve this supplied context").toString("base64") }] } });
    const waitApproval = async (run: Run) => { const until = Date.now() + 10_000; while (!run.awaiting) { if (run.status !== "running" || Date.now() > until) throw new Error(run.error ?? "Approval not reached"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
    await waitApproval(original);
    // Simulate a restored run whose original input was a locked-down external issue.
    original.source = { kind: "issue", number: 7, title: "External task", body: "Untrusted text", url: "https://example.invalid/7", trusted: false, author: "external" } as Run["source"];
    original.lockdown = "Untrusted issue";
    original.lockdownOnHost = true;
    original.conventions = "Trusted original-base conventions";
    const input = { message: "Add validation for empty input", budget: { maxSteps: 8, maxInvocations: 8, maxMinutes: 2 } };
    const [revised, repeated] = await Promise.all([manager.reviseGoal(original.id, input), manager.reviseGoal(original.id, input)]);
    assert.equal(revised.id, repeated.id, "duplicate in-flight request creates only one child");
    await waitApproval(revised);
    assert.equal(original.status, "cancelled");
    assert.equal(original.supersededBy, revised.id);
    assert.equal(revised.parentRunId, original.id);
    assert.match(revised.task, /User-authorized goal revision/);
    assert.equal(revised.loop.maxInvocations, 8);
    assert.equal(revised.trust, "safe");
    assert.match(revised.lockdown!, /Continued from locked-down/);
    assert.equal(revised.inheritedSourceTrust, "untrusted");
    assert.equal(revised.source?.trusted, false);
    assert.equal(revised.conventions, "Trusted original-base conventions");
    assert.equal(revised.context.attachments[0]?.name, "requirements.txt");
    assert.ok(revised.steps.every((step) => step.mode !== "write"));
    manager.cancel(revised.id); await ended(revised);
    const ordinaryChild = await manager.start({ pattern, repo, task: "Continue", parentRunId: original.id, roles: {}, options: {}, approvals: { plan: false } });
    await ended(ordinaryChild);
    assert.equal(ordinaryChild.context.attachments[0]?.name, "requirements.txt");
    assert.equal(ordinaryChild.inheritedSourceTrust, "untrusted");
  } finally { await manager.shutdown(); }
});
