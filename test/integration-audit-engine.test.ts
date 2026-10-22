import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, TeamContext as Context } from "../src/engine.js";

const home = await mkdtemp(join(tmpdir(), "codeflow-audit-engine-home-"));
process.env.CODEFLOW_HOME = home;
process.env.CODEFLOW_MAX_AGENTS = "1";
process.env.CODEFLOW_MAX_CHECKS = "1";
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager, TeamContext } = await import("../src/engine.js");
const { adapters } = await import("../src/adapters/index.js");
const { TeamPlanEditError } = await import("../src/workflow-control.js");
const { flushWrites, journalEntry } = await import("../src/store.js");
const repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-audit-engine-repo-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
await writeFile(join(repo, "README.md"), "Audit fixture\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
after(async () => { await flushWrites(); await rm(repo, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });

const pattern = (run: (ctx: Context) => Promise<string>): Pattern => ({ id: "audit", name: "Audit", description: "", summary: "", roles: [], options: [], run });
async function until(condition: () => boolean) { const deadline = Date.now() + 10_000; while (!condition()) { if (Date.now() > deadline) throw new Error("Timed out waiting for audit fixture"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
async function finished(manager: InstanceType<typeof RunManager>, run: Run) { await until(() => run.status !== "running"); return manager.get(run.id)!; }

test("overlapping budget pauses remain paused until every hold is released", async () => {
  const controller = new AbortController();
  const run = { id: "clock-audit", loop: { maxMinutes: 0.001 }, usage: {}, steps: [] } as unknown as Run;
  const ctx = new TeamContext(run, controller, { emit() {} } as unknown as InstanceType<typeof RunManager>);
  ctx.startClock(0.001);
  ctx.pauseClock(); ctx.pauseClock(); ctx.resumeClock();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.signal.aborted, false, "one outstanding user decision still pauses the budget");
  ctx.resumeClock();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.signal.aborted, true);
  ctx.stopClock();
});

test("pausing queued agent work removes it from dispatch without occupying the only slot", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const original = adapters.claude.run;
  adapters.claude.run = async (opts) => { calls.push(opts.prompt); if (opts.prompt === "first") await hold; return { ok: true, finalText: "done" }; };
  const manager = new RunManager();
  const p = pattern(async (ctx) => { const wt = await ctx.worktree("work"); await ctx.ask({ title: ctx.run.task, role: "worker", agent: "claude", mode: "read", cwd: wt, prompt: ctx.run.task }); return "done"; });
  try {
    const first = await manager.start({ repo, pattern: p, task: "first", roles: {}, options: {} });
    await until(() => calls.includes("first"));
    const paused = await manager.start({ repo, pattern: p, task: "paused", roles: {}, options: {} });
    await until(() => manager.busy.agents.waiting === 1);
    manager.setPaused(paused.id, true);
    await until(() => manager.busy.agents.waiting === 0);
    const third = await manager.start({ repo, pattern: p, task: "third", roles: {}, options: {} });
    release();
    await finished(manager, first); await finished(manager, third);
    assert.deepEqual(calls, ["first", "third"]);
    assert.equal(paused.status, "running");
    assert.equal(manager.busy.agents.running, 0);
    manager.setPaused(paused.id, false);
    assert.equal((await finished(manager, paused)).status, "done");
    assert.deepEqual(calls, ["first", "third", "paused"]);
  } finally { release(); adapters.claude.run = original; await manager.shutdown(); }
});

test("pausing a queued check prevents it running after another check releases its slot", async () => {
  const releaseFile = join(home, "release-check");
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const script = `const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.exit(0)}},10)`;
  const manager = new RunManager();
  const p = (command: string) => pattern(async (ctx) => { const wt = await ctx.worktree("work"); await ctx.check(wt, "Audit check", command); return "done"; });
  try {
    const first = await manager.start({ repo, pattern: p(`node -e ${quote(script)}`), task: "first check", roles: {}, options: {} });
    await until(() => manager.busy.checks.running === 1);
    const paused = await manager.start({ repo, pattern: p("true"), task: "paused check", roles: {}, options: {} });
    await until(() => manager.busy.checks.waiting === 1);
    manager.setPaused(paused.id, true);
    await until(() => manager.busy.checks.waiting === 0);
    await writeFile(releaseFile, "release");
    await finished(manager, first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(paused.status, "running");
    assert.equal(paused.steps[0]!.endedAt, undefined);
    assert.equal(manager.busy.checks.running, 0);
    manager.setPaused(paused.id, false);
    assert.equal((await finished(manager, paused)).status, "done");
  } finally { await writeFile(releaseFile, "release"); await manager.shutdown(); }
});

test("cached input counts toward token ceilings and fresh allocations reset invocation ceilings", async () => {
  const original = adapters.claude.run;
  let calls = 0;
  adapters.claude.run = async (_opts, emit) => { calls++; emit({ kind: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 100 }); return { ok: true, finalText: "done" }; };
  const manager = new RunManager();
  try {
    const p = (fresh: boolean) => pattern(async (ctx) => { const wt = await ctx.worktree("work"); for (let index = 0; index < 2; index++) { if (fresh && index) ctx.freshBudget(); await ctx.ask({ title: `Turn ${index}`, role: "worker", agent: "claude", mode: "read", cwd: wt, prompt: "fixture" }); } return "done"; });
    const cached = await manager.start({ repo, pattern: p(false), task: "cached ceiling", roles: {}, options: {}, loop: { maxTokens: 100 } });
    assert.equal((await finished(manager, cached)).status, "stopped");
    assert.equal(calls, 1);
    calls = 0;
    const fresh = await manager.start({ repo, pattern: p(true), task: "fresh invocation allocation", roles: {}, options: {}, loop: { maxInvocations: 1 } });
    assert.equal((await finished(manager, fresh)).status, "done");
    assert.equal(calls, 2);
  } finally { adapters.claude.run = original; await manager.shutdown(); }
});

test("cancel and immediate resume waits for a pending workflow write before reconstructing the journal", async () => {
  let launchCount = 0;
  let loadedPlan: string | undefined;
  let releaseWrite!: () => void;
  const storageBarrier = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const p = pattern(async (ctx) => {
    if (++launchCount === 1) await ctx.approve("plan", "Review workflow", "Unedited workflow");
    else loadedPlan = await ctx.remember("workflow", "reviewed-plan", async () => "Unedited workflow");
    return "done";
  });
  const manager = new RunManager((id) => id === p.id ? p : undefined);
  let pendingWrite: Promise<unknown> | undefined;
  const writes = (manager as unknown as { teamPlanWrites: Map<string, Promise<unknown>> }).teamPlanWrites;
  try {
    const run = await manager.start({ repo, pattern: p, task: "slow workflow persistence", roles: {}, options: {}, approvals: { plan: true } });
    await until(() => !!run.awaiting);
    // A controlled storage barrier models editTeamPlan awaiting I/O before its journal
    // append. No production sleep/fault hook is needed, and replay is observed externally.
    pendingWrite = storageBarrier.then(async () => {
      await journalEntry(run.id, "workflow:reviewed-plan#1", "Reviewed workflow saved while cancelling");
      throw new TeamPlanEditError("The run stopped while saving. The edit is retained for resume.", 409);
    });
    void pendingWrite.catch(() => undefined);
    writes.set(run.id, pendingWrite);
    manager.cancel(run.id);
    await finished(manager, run);
    const resumed = manager.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(launchCount, 1, "resume must not dispatch before the pending edit is durable");
    releaseWrite();
    await resumed;
    assert.equal((await finished(manager, run)).status, "done");
    assert.equal(loadedPlan, "Reviewed workflow saved while cancelling");
  } finally {
    releaseWrite();
    await pendingWrite?.catch(() => undefined);
    writes.clear();
    await manager.shutdown();
  }
});

test("final check reuse requires the same commit, clean checkout, inputs and verification profile", async () => {
  for (const change of ["none", "commit", "dirty", "untracked", "profile"]) {
    let first: Awaited<ReturnType<Context["check"]>>, second: typeof first;
    const p = pattern(async ctx => {
      const wt = await ctx.worktree("build");
      first = await ctx.check(wt, "Initial check");
      if (change === "dirty" || change === "commit") await writeFile(join(wt.path, "README.md"), "Changed after check\n");
      if (change === "commit") await ctx.commit(wt, "Changed commit");
      if (change === "untracked") await writeFile(join(wt.path, "input.txt"), "Changed input\n");
      if (change === "profile") ctx.run.loop.verification!.checks.push({ id: "extra", kind: "custom", command: "node -e 'console.log(2)'", required: true, timeoutMs: 10000 });
      second = await ctx.check(wt, "Final check", undefined, { reuse: true });
      return "checked";
    });
    const manager = new RunManager(id => id === p.id ? p : undefined);
    try {
      const command = "node -e 'console.log(1)'";
      const run = await manager.start({ repo, pattern: p, task: `Check reuse ${change}`, roles: {}, options: {}, loop: { check: command, verification: { name: "Required", checks: [{ id: "primary", kind: "custom", command, required: true, timeoutMs: 10000 }] } } });
      await finished(manager, run);
      assert.equal(first!.ok, true, run.error);
      assert.equal(second!.ok, change !== "dirty", change);
      assert.equal(run.usage.checks, change === "none" ? 1 : 2, change);
    } finally { await manager.shutdown(); }
  }
});
