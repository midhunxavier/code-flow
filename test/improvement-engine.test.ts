import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, TeamContext } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-improvement-engine-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { adapters } = await import("../src/adapters/index.js");
const { flushWrites, readRunCheckpoint } = await import("../src/store.js");
const repo = mkdtempSync(join(tmpdir(), "codeflow-improvement-engine-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
after(async () => { await flushWrites(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const pattern = (run: (ctx: TeamContext) => Promise<string>): Pattern => ({ id: "fixture", name: "Fixture", summary: "", description: "", roles: [], options: [], run });
async function until(test: () => boolean) { const end = Date.now() + 10000; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
async function finished(manager: InstanceType<typeof RunManager>, id: string): Promise<Run> { await until(() => manager.get(id)?.status !== "running"); await flushWrites(); return manager.get(id)!; }

test("required verification gates cannot be hidden by a passing primary check", async () => {
  const p = pattern(async (ctx) => { const tree = await ctx.worktree("result"); const result = await ctx.check(tree); ctx.setVerdict(result?.ok ? "passed" : "failing"); return "Checked"; });
  const manager = new RunManager();
  const started = await manager.start({ repo, pattern: p, task: "verify", roles: {}, options: {}, loop: { check: "true", verification: { name: "quality", checks: [{ id: "primary", kind: "unit", command: "true", required: true, timeoutMs: 10000 }, { id: "lint", kind: "lint", command: "false", required: true, timeoutMs: 10000 }] } } });
  const run = await finished(manager, started.id);
  assert.equal(run.verdict, "failing");
  assert.equal(run.verification?.state, "needs-changes");
  assert.deepEqual(run.verification?.checks.map((check) => check.check.id), ["primary", "lint"]);
  assert.equal(run.steps.filter((step) => step.kind === "check").length, 2);
  assert.ok((await readRunCheckpoint<Run>(run.id))?.run.steps.length);
  const reloaded = new RunManager(); await reloaded.load();
  assert.equal(reloaded.get(run.id)?.verification?.state, "needs-changes");
  assert.equal(reloaded.get(run.id)?.steps.length, 2);
});

test("profile verification stops at tracked, staged or commit drift before a later gate can hide it", async () => {
  const commands = ["printf 'rewritten\\n' > README.md", "printf 'staged\\n' > README.md && git add README.md", "git -c user.name=test -c user.email=test@test commit --allow-empty -qm moved", "git update-index --assume-unchanged README.md && printf 'hidden\\n' > README.md"];
  for (const command of commands) {
    const manager = new RunManager();
    try {
      const p = pattern(async (ctx) => { const tree = await ctx.worktree("result"); const checked = await ctx.check(tree); ctx.setVerdict(checked?.ok ? "passed" : "failing"); return "checked"; });
      const started = await manager.start({ repo, pattern: p, task: "pin verification", roles: {}, options: {}, loop: { check: command, verification: { name: "pinned", checks: [{ id: "rewrite", kind: "custom", command, required: true, timeoutMs: 10000 }, { id: "restore", kind: "custom", command: "git reset --hard HEAD && true", required: true, timeoutMs: 10000 }] } } });
      const run = await finished(manager, started.id);
      assert.equal(run.verification?.state, "blocked");
      assert.equal(run.verdict, "failing");
      assert.match(run.verification!.skipped[0]!.reason, /original commit was not verified/);
      assert.equal(run.steps.filter((step) => step.kind === "check").length, 1, "no later gate may conceal a rewrite");
    } finally { await manager.shutdown(); }
  }
});

test("safe pause holds dispatch and cancellation releases a paused run", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => releaseFirst = resolve);
  let calls = 0;
  const original = adapters.claude.run;
  adapters.claude.run = async () => { calls++; return { ok: true, finalText: "done" }; };
  const manager = new RunManager();
  try {
    const p = pattern(async (ctx) => { const tree = await ctx.worktree("result"); await first; await ctx.ask({ title: "After checkpoint", role: "worker", agent: "claude", mode: "read", cwd: tree, prompt: "fixture" }); return "done"; });
    const run = await manager.start({ repo, pattern: p, task: "pause", roles: {}, options: {} });
    manager.setPaused(run.id, true); releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 0);
    manager.setPaused(run.id, false);
    assert.equal((await finished(manager, run.id)).status, "done");
    assert.equal(calls, 1);
    const waiting = await manager.start({ repo, pattern: pattern(async (ctx) => { const tree = await ctx.worktree("result"); manager.setPaused(ctx.run.id, true); await ctx.ask({ title: "Paused", role: "worker", agent: "claude", mode: "read", cwd: tree, prompt: "fixture" }); return "unreachable"; }), task: "cancel pause", roles: {}, options: {} });
    await until(() => !!waiting.pauseRequested);
    manager.cancel(waiting.id);
    assert.equal((await finished(manager, waiting.id)).status, "cancelled");
  } finally { adapters.claude.run = original; await manager.shutdown(); }
});

test("reported token ceiling stops the next agent operation", async () => {
  let calls = 0;
  const original = adapters.claude.run;
  adapters.claude.run = async (_opts, event) => { calls++; event({ kind: "usage", inputTokens: 8, outputTokens: 3 }); return { ok: true, finalText: "done" }; };
  const manager = new RunManager();
  try {
    const p = pattern(async (ctx) => { const tree = await ctx.worktree("result"); for (let i = 0; i < 2; i++) await ctx.ask({ title: `Turn ${i}`, role: "worker", agent: "claude", mode: "read", cwd: tree, prompt: "fixture" }); return "done"; });
    const run = await manager.start({ repo, pattern: p, task: "budget", roles: {}, options: {}, loop: { maxTokens: 10 } });
    const final = await finished(manager, run.id);
    assert.equal(final.status, "stopped");
    assert.equal(calls, 1);
    assert.match(final.stopReason!, /token/);
  } finally { adapters.claude.run = original; await manager.shutdown(); }
});

test("human file coverage is tied to a commit and human rework survives reload", async () => {
  const manager = new RunManager();
  try {
    const p = pattern(async (ctx) => { const tree = await ctx.worktree("result"); writeFileSync(join(tree.path, "auth.ts"), "export const permitted = true;\n"); await ctx.commit(tree, "fixture auth change"); return "done"; });
    const run = await manager.start({ repo, pattern: p, task: "Review fixture", roles: {}, options: {} });
    await finished(manager, run.id);
    const branch = run.worktrees[0]!.branch;
    const before = await manager.reviewCoverage(run.id, branch);
    assert.equal(before.risk.level, "high"); assert.deepEqual(before.coverage.unreviewed, ["auth.ts"]);
    await manager.recordFileReview(run.id, { branch, expectedHead: before.head, path: "auth.ts", reviewed: true });
    const reviewed = await manager.reviewCoverage(run.id, branch);
    assert.equal(reviewed.coverage.percent, 100);
    await manager.recordHumanRework(run.id, { branch, expectedHead: before.head, minutes: 15, note: "Checked the permission boundary" });
    await assert.rejects(manager.recordFileReview(run.id, { branch, expectedHead: before.head, path: "unrelated.txt", reviewed: true }), /changed file/);
    const tree = run.worktrees[0]!;
    writeFileSync(join(tree.path, "auth.ts"), "export const permitted = false;\n");
    execFileSync("git", ["add", "."], { cwd: tree.path });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "moving result"], { cwd: tree.path });
    const changed = await manager.reviewCoverage(run.id, branch);
    assert.equal(changed.stale, true); assert.equal(changed.coverage.reviewed, 0);
    await assert.rejects(manager.recordFileReview(run.id, { branch, expectedHead: before.head, path: "auth.ts", reviewed: true }), /branch changed/);
    await flushWrites(); const reloaded = new RunManager(); await reloaded.load();
    assert.equal(reloaded.get(run.id)?.humanRework?.[0]?.minutes, 15);
  } finally { await manager.shutdown(); }
});
