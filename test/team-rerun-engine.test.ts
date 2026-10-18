import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-rerun-engine-home-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { buildTeamEvaluation } = await import("../src/team-evaluation.js");
const { flushWrites } = await import("../src/store.js");
const repositories: string[] = [], managers: InstanceType<typeof RunManager>[] = [];
after(async () => { for (const manager of managers) await manager.shutdown(); await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
async function finished(run: Run) { return until(() => run, (value) => value.status !== "running"); }
async function source(prove = false) {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-rerun-engine-repo-")); repositories.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove }));
  writeFileSync(join(repo, "README.md"), "Rerun fixture\n"); writeFileSync(join(repo, "baseline.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('baseline', () => assert.equal(1, 1));\n");
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  const manager = new RunManager(findPattern); managers.push(manager);
  const run = await manager.start({ repo, pattern: findPattern("auto-team")!, task: "AUTO-SAME-PROVIDER Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false } });
  await finished(run); return { run, manager, git };
}
const request = (run: Run, taskIds = ["beta"]) => ({ expectedHead: run.team!.verification!.head, taskIds, budget: { maxSteps: 12, maxInvocations: 12, maxMinutes: 2 } });

test("selective execution runs the accepted subset with retained baseline inputs and no planning turn", async () => {
  const { run, manager, git } = await source(); assert.equal(run.team?.status, "completed", run.error);
  const before = structuredClone(run), originalHead = git("rev-parse", run.worktrees.find((tree) => tree.name === "integration")!.branch);
  const child = await finished(await manager.rerunTeamTasks(run.id, request(run)));
  assert.equal(child.status, "done", child.error ?? JSON.stringify(child.team?.gaps));
  assert.equal(child.team?.status, "completed"); assert.equal(child.baseRef, originalHead); assert.equal(child.parentRunId, run.id);
  assert.deepEqual(child.steps.filter((step) => step.taskId && step.kind === "agent").map((step) => step.taskId), ["beta"]);
  assert.ok(!child.steps.some((step) => step.title === "Plan Auto team")); assert.equal(child.team!.metrics.coordinatorInvocations, 0);
  assert.ok(child.team!.verification!.reviewed); assert.ok(child.steps.some((step) => step.title.startsWith("Auto team independent review")));
  assert.equal(child.team!.tasks.find((task) => task.id === "alpha")!.retainedBaseline?.sourceRunId, run.id);
  assert.equal(child.team!.tasks.find((task) => task.id === "alpha")!.attempts, 0);
  const evaluation = buildTeamEvaluation(child, { mode: "fake" });
  assert.equal(evaluation.verification.retainedTasks, 1); assert.equal(evaluation.verification.newlyExecutedTasks, 1);
  assert.deepEqual(run, before, "the original metadata and evidence remain unchanged"); assert.equal(git("rev-parse", run.worktrees.find((tree) => tree.name === "integration")!.branch), originalHead);
});

test("an unchanged rerun passes only a fresh check and independent review without fabricated proof", async () => {
  const { run, manager } = await source(true); assert.equal(run.team?.status, "completed", run.error ?? JSON.stringify(run.team?.gaps));
  const child = await finished(await manager.rerunTeamTasks(run.id, request(run, ["alpha"])));
  assert.equal(child.status, "done", child.error ?? JSON.stringify(child.team?.gaps)); assert.equal(child.team?.status, "completed");
  assert.deepEqual(child.teamRerun!.rerunTaskIds, ["alpha", "beta"]);
  assert.deepEqual(child.steps.filter((step) => step.taskId && step.kind === "agent").map((step) => step.taskId), ["alpha", "beta"]);
  assert.ok(child.team!.tasks.every((task) => task.noNewDiff)); assert.equal(child.facts?.proof, undefined); assert.equal(child.facts?.proofNotRequired, "unchanged-rerun");
  assert.equal(child.team!.verification!.check, "passed"); assert.equal(child.team!.verification!.approved, true);
  assert.equal(buildTeamEvaluation(child, { mode: "fake" }).verified, true);
});

test("a failed source can rerun all unfinished dependencies with a fresh independent budget", async () => {
  process.env.FAKE_FAIL_VENDOR = "claude";
  let original: Awaited<ReturnType<typeof source>>;
  try { original = await source(); } finally { delete process.env.FAKE_FAIL_VENDOR; }
  assert.equal(original.run.team?.status, "blocked"); assert.equal(original.run.status, "stopped");
  const child = await finished(await original.manager.rerunTeamTasks(original.run.id, request(original.run, ["alpha"])));
  assert.equal(child.status, "done", child.error ?? JSON.stringify(child.team?.gaps)); assert.equal(child.team?.status, "completed");
  assert.equal(child.loop.maxInvocations, 12); assert.ok(child.team!.metrics.invocations < original.run.team!.metrics.invocations);
  assert.ok(child.team!.verification!.reviewed);
});

test("source claim blocks resume while creation is pending and identical requests share one child", async () => {
  const { run, manager } = await source();
  const start = manager.start.bind(manager); let release!: () => void; const gate = new Promise<void>((resolve) => release = resolve);
  manager.start = async (input) => { if (input.teamRerun) await gate; return start(input); };
  const first = manager.rerunTeamTasks(run.id, request(run));
  await until(() => manager.isRepositoryIdle(run.repo), (idle) => !idle);
  await assert.rejects(manager.resume(run.id), /already running/);
  const second = manager.rerunTeamTasks(run.id, request(run)); release();
  const [one, two] = await Promise.all([first, second]); assert.equal(one.id, two.id); await finished(one);
});

test("a pinned rerun resumes its actual accepted plan after restart and forbids plan editor replacement", async () => {
  const { run, manager } = await source(); run.approvals.plan = true;
  const child = await manager.rerunTeamTasks(run.id, request(run));
  await until(() => child.awaiting, (value) => !!value);
  assert.equal(child.steps.filter((step) => step.kind === "agent").length, 0);
  await assert.rejects(manager.editTeamPlan(child.id, {}), /keeps its pinned task graph/);
  manager.cancel(child.id); await finished(child); await manager.shutdown();
  const restored = new RunManager(findPattern); managers.push(restored); await restored.load();
  const recovered = await restored.resume(child.id); await until(() => recovered.awaiting, (value) => !!value);
  assert.equal(recovered.steps.filter((step) => step.kind === "agent").length, 0);
  assert.equal(recovered.team!.tasks.find((task) => task.id === "alpha")!.retainedBaseline?.sourceRunId, run.id);
  restored.answer(child.id, { decision: "approve" }); await finished(recovered);
  assert.equal(recovered.team?.status, "completed", recovered.error ?? JSON.stringify(recovered.team?.gaps));
  assert.deepEqual(recovered.steps.filter((step) => step.taskId && step.kind === "agent").map((step) => step.taskId), ["beta"]);
});
