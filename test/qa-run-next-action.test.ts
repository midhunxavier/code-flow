import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, RunSummary, Step } from "../src/engine.js";
import { nextRunAction, executionLabel, checksLabel } from "../ui/run-experience.js";
import { dispatchLabel, failedWork, planRejected } from "../src/run-outcome.js";

const fixture = mkdtempSync(join(tmpdir(), "codeflow-next-action-"));
process.env.CODEFLOW_HOME = join(fixture, "home");
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager, RejectedError } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { getAdapter } = await import("../src/adapters/index.js");
const { flushWrites } = await import("../src/store.js");
const { strip } = await import("../src/run-projection.js");
const manager = new RunManager(findPattern);
after(async () => { await manager.shutdown(); await flushWrites(); rmSync(fixture, { recursive: true, force: true }); });
let sequence = 0;
function repository() {
  const repo = join(fixture, `repo-${++sequence}`); mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "base"], { cwd: repo }); return repo;
}
async function until(predicate: () => boolean) { const end = Date.now() + 20_000; while (!predicate()) { assert.ok(Date.now() < end, "run did not settle"); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function settled(run: Run) { await until(() => run.status !== "running" && !!run.endedAt); return run; }
const summary = (extra: Partial<RunSummary> = {}) => ({ status: "done", pattern: "solo", loop: { check: "" }, worktrees: [], artifacts: [], ...extra }) as RunSummary;
const pattern = (run: Pattern["run"]): Pattern => ({ id: "qa-outcome", name: "Outcome", description: "", summary: "", roles: [], options: [], run });

test("legacy provider prose, structured failures and usage resets lead to distinct recovery actions", () => {
  for (const error of ["Claude Code isn't signed in. (Invalid API key · Please run /login)", "Codex isn't signed in on the selected worker", "Your token has expired; please log in again"]) assert.equal(nextRunAction(summary({ status: "failed", error }))?.kind, "provider");
  assert.equal(nextRunAction(summary({ status: "failed", error: "opaque failure", failure: { kind: "auth", agent: "codex" } }))?.kind, "provider");
  const limited = summary({ status: "stopped", stopReason: "usage limit of Claude Code", providerLimit: { agent: "claude", name: "Claude Code", resetsAt: Date.now() + 3_600_000 } });
  assert.equal(nextRunAction(limited)?.kind, "provider-limit"); assert.match(nextRunAction(limited)!.detail, /Reset reported for/); assert.match(executionLabel(limited), /Provider/);
  assert.equal(nextRunAction(summary({ status: "stopped", stopReason: "reported API-equivalent usage limit" }))?.label, "Extend budget & resume");
  assert.equal(nextRunAction(summary({ status: "cancelled" }))?.title, "Stopped by you");
});

test("council publishing precedes checks; empty results do not request a check or review", () => {
  const review = { verdict: "approve", summary: "Looks good", findings: [], reviewers: [], markdown: "Looks good" } as Run["review"];
  assert.equal(nextRunAction(summary({ pattern: "council", review }))?.kind, "publish-review");
  assert.equal(nextRunAction(summary()), null);
  assert.equal(checksLabel(summary(), false, "result"), "Not configured");
  const action = nextRunAction(summary({ checkCantRun: { command: "missing", reason: "Missing runner" } }));
  assert.match(action!.detail, /Missing runner\. You/); assert.match(action!.detail, /original base/);
});

test("dispatch status distinguishes a pending pause from an idle pause in saved summaries", () => {
  const run = { ...summary({ status: "running", pauseRequested: true }), steps: [{ id: "active", status: "running" }] } as Run;
  assert.equal(dispatchLabel(strip(run)), "Pausing after active work");
  run.steps[0]!.status = "done";
  assert.equal(dispatchLabel(strip(run)), "Dispatch paused");
  assert.equal(executionLabel(strip(run)), "Dispatch paused");
  assert.equal(dispatchLabel({ ...strip(run), pauseRequested: false }), undefined);
});

test("auth classification and quota reset survive the engine and journal reload", async () => {
  const adapter = getAdapter("claude"), original = adapter.run;
  try {
    for (const kind of ["auth", "usage_limit"] as const) {
      const resetsAt = Date.now() + 60_000;
      adapter.run = async () => ({ ok: false, finalText: "", error: "opaque provider refusal", errorKind: kind, resetsAt: kind === "usage_limit" ? resetsAt : undefined });
      const run = await settled(await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Fail clearly", roles: { agent: ["claude"] }, options: {} }));
      assert.equal(run.steps.find(step => step.kind === "agent")!.errorKind, kind);
      assert.equal(nextRunAction(run)?.kind, kind === "auth" ? "provider" : "provider-limit");
      if (kind === "auth") assert.deepEqual(run.failure, { kind, agent: "claude" });
      else assert.equal(run.providerLimit?.resetsAt, resetsAt);
      await flushWrites(); const restored = new RunManager(findPattern); await restored.load();
      assert.deepEqual(restored.get(run.id)?.failure, run.failure); assert.deepEqual(restored.get(run.id)?.providerLimit, run.providerLimit); await restored.shutdown();
    }
  } finally { adapter.run = original; }
});

test("rejected checkpoints cannot be replayed through Resume, including legacy records", async () => {
  const run = await settled(await manager.start({ pattern: pattern(async () => { throw new RejectedError("You rejected the plan"); }), repo: repository(), task: "Reject checkpoint", roles: {}, options: {} }));
  assert.equal(run.rejected, true); assert.equal(planRejected(run), true); assert.equal(executionLabel(run), "Plan rejected");
  assert.equal(nextRunAction(run)?.kind, "rerun");
  await assert.rejects(manager.resume(run.id), /Edit the task and start a new run/);
  delete run.rejected;
  await assert.rejects(manager.resume(run.id), /Edit the task and start a new run/);
});

test("TDD expected failures and proof warnings do not count as failed work", async () => {
  const run = await settled(await manager.start({ pattern: pattern(async ctx => {
    const tree = await ctx.worktree("result");
    await ctx.checkBeforeImplementation(tree, "Expected red", "false");
    await ctx.checkBeforeImplementation(tree, "Premature green", "true");
    await ctx.checkBeforeImplementation(tree, "Broken runner", "missing-qa-red-command");
    return "checked";
  }), repo: repository(), task: "Red checks", roles: {}, options: {} }));
  const red = run.steps.find(step => step.title === "Expected red")!, green = run.steps.find(step => step.title === "Premature green")!;
  assert.equal(red.status, "done"); assert.equal(red.outcome, "expected");
  assert.equal(green.outcome, "warning"); assert.equal(run.lastCheck, undefined);
  assert.deepEqual(failedWork(run.steps).map(step => step.title), ["Broken runner"]);
  assert.equal(failedWork([{ status: "failed", outcome: "warning", title: "Proof" }] as Step[]).length, 0);
});

test("a cancelled check reports a stop instead of a null exit code", async () => {
  const run = await manager.start({ pattern: pattern(async ctx => { const tree = await ctx.worktree("result"); await ctx.check(tree); return "checked"; }), repo: repository(), task: "Stop check", roles: {}, options: {}, loop: { check: "sleep 30" } });
  await until(() => run.steps.some(step => step.kind === "check" && step.status === "running")); manager.cancel(run.id); await settled(run);
  const check = run.steps.find(step => step.kind === "check")!;
  assert.equal(check.status, "cancelled"); assert.equal(check.finalText, "Stopped before it finished"); assert.doesNotMatch(check.finalText!, /exit code null/);
});

test("no-op chats have no review artifact while failed partial edits remain inspectable", async () => {
  const adapter = getAdapter("claude"), original = adapter.run;
  try {
    adapter.run = async () => ({ ok: true, finalText: "Answer only" });
    const empty = await settled(await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Answer", roles: { agent: ["claude"] }, options: {} }));
    assert.deepEqual(empty.artifacts, []);
    adapter.run = async opts => { writeFileSync(join(opts.cwd, "partial.txt"), "work kept\n"); return { ok: false, finalText: "", error: "Stopped after writing", errorKind: "other" }; };
    const partial = await settled(await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Partial", roles: { agent: ["claude"] }, options: {} }));
    assert.equal(partial.status, "failed"); assert.match(partial.artifacts[0]!.stat!, /new untracked file/);
  } finally { adapter.run = original; }
});
