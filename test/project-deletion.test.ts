import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "codeflow-project-deletion-"));
process.env.CODEFLOW_HOME = home;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects } = await import("../src/projects.js");
const { memoryStore } = await import("../src/memory.js");
const { flushWrites, RUNS_DIR } = await import("../src/store.js");
after(async () => { await flushWrites(); await rm(home, { recursive: true, force: true }); });
let sequence = 0;

async function fixture(t: TestContext) {
  const directory = join(home, `case-${++sequence}`), repo = join(directory, "repo");
  await mkdir(repo, { recursive: true }); await mkdir(RUNS_DIR, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Keep repository files\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  const canonical = await realpath(repo), projects = new Projects(join(directory, "projects.json")); await projects.load();
  const project = await projects.create({ name: "Delete me", repos: [canonical] });
  const other = await projects.create({ name: "Keep me", repos: [canonical] });
  const ids: string[] = [];
  const seed = async (name: string, extra: Record<string, unknown> = {}) => {
    const id = `delete-${sequence}-${name}`, now = Date.now() - 1000;
    const run = { id, project: project.id, task: name, pattern: "solo", repo: canonical, baseRef: git("rev-parse", "HEAD"), baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(directory, "worktrees", id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: now, endedAt: now + 1, seen: true, archived: false, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [], ...extra };
    await writeFile(join(RUNS_DIR, `${id}.jsonl`), JSON.stringify({ seq: 1, ts: now, runId: id, type: "run", run }) + "\n");
    ids.push(id); return id;
  };
  const manager = new RunManager(findPattern, projects);
  t.after(async () => { await manager.shutdown(); });
  return { directory, repo: canonical, git, projects, project, other, seed, manager, ids };
}

test("project deletion removes archived, legacy and related run history, keeping other projects and Git files", async t => {
  const f = await fixture(t);
  const owner = await f.seed("owner"), side = await f.seed("side", { chatLink: { kind: "side", workspaceId: owner, sourceId: owner } });
  const archived = await f.seed("archived", { archived: true }), legacy = await f.seed("legacy", { project: undefined });
  const kept = await f.seed("other", { project: f.other.id });
  await f.manager.load();
  const deleted: string[] = []; f.manager.subscribeAll(run => { if (run.deleted) deleted.push(run.id); });
  await f.manager.removeProject(f.project.id);
  assert.equal(f.projects.get(f.project.id), undefined); assert.ok(f.projects.get(f.other.id));
  for (const id of [owner, side, archived, legacy]) {
    assert.equal(f.manager.get(id), undefined);
    assert.equal(existsSync(join(RUNS_DIR, `${id}.jsonl`)), false);
  }
  assert.ok(deleted.indexOf(side) < deleted.indexOf(owner), "related chats are removed before their workspace owner");
  assert.ok(f.manager.get(kept)); assert.equal(await readFile(join(f.repo, "README.md"), "utf8"), "Keep repository files\n");
  assert.ok(f.git("rev-parse", "main"));
  const restarted = new RunManager(findPattern, f.projects); await restarted.load();
  for (const id of [owner, side, archived, legacy]) assert.equal(restarted.get(id), undefined);
  assert.ok(restarted.get(kept)); await restarted.shutdown();
});

test("an active run prevents deleting the project or any earlier run", async t => {
  const f = await fixture(t), done = await f.seed("done"), active = await f.seed("active"); await f.manager.load();
  const busy = t.mock.method(f.manager as any, "busyRun", (run: { id: string }) => run.id === active);
  await assert.rejects(f.manager.removeProject(f.project.id), /Finish or stop/);
  assert.ok(f.projects.get(f.project.id)); assert.ok(f.manager.get(done)); assert.ok(f.manager.get(active));
  busy.mock.restore(); await f.manager.removeProject(f.project.id); assert.equal(f.manager.get(active), undefined);
});

test("cleanup failures keep the project retryable and deletion blocks concurrent resume or moves", async t => {
  const f = await fixture(t), id = await f.seed("run"); await f.manager.load();
  const failed = t.mock.method(memoryStore, "purgeRun", async () => { throw new Error("memory unavailable"); });
  await assert.rejects(f.manager.removeProject(f.project.id), /memory unavailable/);
  assert.ok(f.projects.get(f.project.id)); assert.ok(f.manager.get(id)); failed.mock.restore();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const original = memoryStore.purgeRun.bind(memoryStore);
  const paused = t.mock.method(memoryStore, "purgeRun", async (runId: string) => { entered(); await gate; return original(runId); });
  const deleting = f.manager.removeProject(f.project.id); await waiting;
  try {
    await assert.rejects(f.manager.resume(id), /being deleted/);
    await assert.rejects(f.manager.setProject(id, f.other.id), /being deleted/);
    await assert.rejects(f.manager.deleteRun(id), /being deleted/);
  } finally { release(); await deleting; paused.mock.restore(); }
  assert.equal(f.projects.get(f.project.id), undefined); assert.equal(f.manager.get(id), undefined);
});

test("a related chat in another project prevents deleting its workspace owner", async t => {
  const f = await fixture(t), owner = await f.seed("owner");
  const side = await f.seed("side", { project: f.other.id, chatLink: { kind: "side", workspaceId: owner, sourceId: owner } });
  await f.manager.load(); await assert.rejects(f.manager.removeProject(f.project.id), /shared workspace/);
  assert.ok(f.projects.get(f.project.id)); assert.ok(f.manager.get(owner)); assert.ok(f.manager.get(side));
});
