import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pattern, StartRunInput } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-workspace-activity-home-")); process.env.CODEFLOW_HOME = home;
const { RunManager, RunConflictError } = await import("../src/engine.js");
const { flushWrites } = await import("../src/store.js");
const repositories: string[] = [], managers: InstanceType<typeof RunManager>[] = [];
after(async () => { for (const manager of managers) await manager.shutdown(); await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => resolve = done); return { promise, resolve }; };
async function until(predicate: () => boolean) { const deadline = Date.now() + 10_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-workspace-activity-repo-"))); repositories.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "Workspace lease fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const pattern: Pattern = { id: "fixture", name: "Fixture", summary: "", description: "", roles: [], options: [], run: async (ctx) => { await ctx.worktree("result"); return "done"; } };
  const manager = new RunManager((id) => id === pattern.id ? pattern : undefined); managers.push(manager);
  const input: StartRunInput = { repo, pattern, task: "workspace lease", roles: {}, options: {} };
  return { repo, manager, input };
}

test("exclusive mutation leases block new starts and related-worktree resumes, while self idle inspection remains valid", async () => {
  const { repo, manager, input } = fixture(), entered = deferred(), release = deferred();
  const lease = manager.withIdleRepository(repo, async () => { entered.resolve(); await release.promise; }, { kind: "file-edit", owner: "fixture" });
  await entered.promise; assert.equal(manager.inspectRepositoryActivity().leases[0]!.kind, "file-edit"); assert.equal(manager.isRepositoryIdle(repo), true, "a publication can inspect idle run activity from inside its own mutation lease");
  await assert.rejects(manager.start({ ...input, repo: repo + "/." }), RunConflictError);
  await assert.rejects(manager.withIdleRepository(repo, async () => {}), RunConflictError);
  release.resolve(); await lease; assert.equal(manager.inspectRepositoryActivity().leases.length, 0);
  const run = await manager.start(input); await until(() => run.status !== "running"); const tree = run.worktrees[0]!;
  await manager.withIdleRepository(tree.path, async () => {
    await assert.rejects(manager.resume(run.id), RunConflictError);
    await assert.rejects(manager.start(input), RunConflictError);
  }, { kind: "checkpoint-revert", owner: run.id });
  assert.equal(manager.inspectRepositoryActivity().leases.length, 0);
});

test("startup claims close the gap before a run exists and do not serialize unrelated allowed starts", async () => {
  const { repo, manager, input } = fixture(), entered = deferred(), release = deferred();
  const internal = manager as unknown as { startResolved(input: StartRunInput): ReturnType<InstanceType<typeof RunManager>["start"]> };
  const original = internal.startResolved.bind(manager);
  internal.startResolved = async (value) => { entered.resolve(); await release.promise; return original(value); };
  const first = manager.start(input); await entered.promise;
  assert.equal(manager.list().length, 0); assert.equal(manager.isRepositoryIdle(repo), false);
  await assert.rejects(manager.withIdleRepository(repo, async () => {}), /starting runs/);
  const second = manager.start(input); await until(() => manager.inspectRepositoryActivity().starting[0]?.count === 2);
  release.resolve(); const [one, two] = await Promise.all([first, second]); assert.notEqual(one.id, two.id);
  await until(() => one.status !== "running" && two.status !== "running");
  assert.equal(manager.inspectRepositoryActivity().starting.length, 0);
  await assert.rejects(manager.withIdleRepository(repo, async () => { throw new Error("fixture mutation failed"); }), /fixture mutation failed/);
  assert.equal(manager.inspectRepositoryActivity().leases.length, 0); await manager.withIdleRepository(repo, async () => {});
});

test("shutdown waits pending startup work and prevents a late run launch", async () => {
  const { manager, input } = fixture(), entered = deferred(), release = deferred();
  const internal = manager as unknown as { startResolved(input: StartRunInput): ReturnType<InstanceType<typeof RunManager>["start"]> };
  const original = internal.startResolved.bind(manager);
  internal.startResolved = async (value) => { entered.resolve(); await release.promise; return original(value); };
  const starting = manager.start(input); await entered.promise;
  const stopped = manager.shutdown(); release.resolve(); await assert.rejects(starting, /shutting down/); await stopped;
  assert.equal(manager.list().length, 0); assert.equal(manager.inspectRepositoryActivity().starting.length, 0);
});

test("shutdown lets an already claimed workspace mutation settle before releasing activity", async () => {
  const { repo, manager } = fixture(), entered = deferred(), release = deferred();
  const mutation = manager.withIdleRepository(repo, async () => { entered.resolve(); await release.promise; writeFileSync(join(repo, "README.md"), "Saved before shutdown\n"); });
  await entered.promise; let stopped = false; const stopping = manager.shutdown().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(stopped, false);
  release.resolve(); await mutation; await stopping; assert.equal(manager.inspectRepositoryActivity().leases.length, 0);
});
