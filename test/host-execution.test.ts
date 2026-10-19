import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Run, RunEvent, StartRunInput } from "../src/engine.js";
import type { RunnerManager } from "../src/collab/runner.js";
import type { MemberRecord } from "../src/collab/store.js";
import type { HostProjectPolicy, HostExecutionOptions } from "../src/collab/host-execution.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-host-execution-")));
process.env.CODEFLOW_HOME = join(root, "home");
const { HostExecution, handleHostExecution } = await import("../src/collab/host-execution.js");
const { CollabStore, memberActor, ownerActor } = await import("../src/collab/store.js");
const { findPattern } = await import("../src/patterns/index.js");
const { CollabError } = await import("../src/collab/model.js");
const owner = ownerActor(), queues: InstanceType<typeof HostExecution>[] = [], stores: InstanceType<typeof CollabStore>[] = [];
after(async () => { for (const q of queues) await q.close(); for (const store of stores) await store.close(); rmSync(root, { recursive: true, force: true }); });
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
let fixtureId = 0;
async function fixture() {
  const dir = join(root, String(++fixtureId)), repo = join(dir, "repo"); mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "sample\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
  const members: MemberRecord[] = ["alice", "bob"].map((name) => ({ userId: `u-${name}`, username: name, displayName: name, enabled: true, roles: { "p-1": "contributor", "p-2": "contributor" } }));
  const alice = memberActor(members[0]!, "browser"), bob = memberActor(members[1]!, "browser");
  const store = new CollabStore({ dir: join(dir, "team"), members: () => members, projects: () => [{ id: "p-1", name: "Project one" }, { id: "p-2", name: "Private project" }] }); stores.push(store); await store.load();
  await store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0);
  const runs = new Map<string, Run>(), listeners = new Map<string, Set<(event: RunEvent) => void>>(); let starts = 0;
  const emit = (run: Run) => { for (const listener of listeners.get(run.id) ?? []) listener({ type: "run", run, seq: 0, ts: Date.now(), runId: run.id } as unknown as RunEvent); };
  const manager = {
    async start(input: StartRunInput) {
      const runId = `run-${++starts}`, branch = `codeflow/${runId}/solo`, path = join(dir, runId);
      git(repo, "worktree", "add", "-q", "-b", branch, path, input.baseRef ?? "HEAD");
      const run = { id: runId, repo, baseRef: input.baseRef, branchPrefix: `codeflow/${runId}`, project: input.project, status: "running", task: input.task, pattern: "solo", worktrees: [{ name: "solo", branch, path }], steps: [], notes: [], summary: "" } as unknown as Run;
      runs.set(runId, run); await input.beforeDispatch?.(run); return run;
    },
    get: (id: string) => runs.get(id), list: () => [...runs.values()],
    subscribe(id: string, listener: (event: RunEvent) => void) { const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set); return () => set.delete(listener); },
    cancel(id: string) { const run = runs.get(id); if (!run || run.status !== "running") return false; run.status = "cancelled"; emit(run); return true; },
    async reviewCoverage(id: string, branch: string) { return { head: git(repo, "rev-parse", branch), files: [] }; },
    addNote() {},
  } as unknown as RunnerManager;
  let enabled = true;
  const options: HostExecutionOptions = { dir: join(dir, "queue"), store, manager, members: () => members, findPattern, projectRepos: () => [repo], resolveRepo: () => repo, enabled: () => enabled, availableAgents: async () => ["codex"] };
  const q = new HostExecution(options); queues.push(q); await q.load();
  const policy: HostProjectPolicy = { projectId: "p-1", enabled: true, userIds: ["u-alice", "u-bob"], agent: "codex", trust: "standard", maxMinutes: 5, maxSteps: 10 };
  const configure = async (patch: Partial<HostProjectPolicy> = {}) => q.configure({ revision: q.view(owner).revision, policy: { ...policy, ...patch } });
  const task = (who = "u-alice") => store.createTask(owner, { projectId: "p-1", repository: "app", title: "Write greeting", goal: "Add a file", owner: who });
  const finish = (id: string) => { const run = runs.get(id)!; writeFileSync(join(run.worktrees[0]!.path, "hello.txt"), "hello\n"); git(run.worktrees[0]!.path, "add", "."); git(run.worktrees[0]!.path, "commit", "-qm", "greeting"); run.status = "done"; run.summary = "Added greeting"; emit(run); };
  return { q, options, configure, policy, task, members, alice, bob, store, repo, runs, finish, starts: () => starts, disable: () => { enabled = false; } };
}
const status = (code: number) => (error: unknown) => error instanceof CollabError && error.status === code;
async function settle(q: InstanceType<typeof HostExecution>, done: () => boolean) { for (let n = 0; n < 100; n++) { await q.tick(); if (done()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail("Queue did not settle"); }

test("host execution is opt-in per project and per teammate; roles alone do not grant it", async () => {
  const f = await fixture(), task = await f.task();
  await assert.rejects(f.q.enqueue(f.alice, task.id, { revision: task.revision }), status(403));
  await f.configure({ userIds: ["u-bob"] });
  await assert.rejects(f.q.enqueue(f.alice, task.id, { revision: task.revision }), status(403));
  await assert.rejects(f.q.enqueue(f.bob, task.id, { revision: task.revision }), status(409));
  await f.configure(); f.members[0]!.roles["p-1"] = "reviewer";
  await assert.rejects(f.q.enqueue(f.alice, task.id, { revision: task.revision }), status(403));
  assert.equal(f.starts(), 0);
});

test("FIFO queue deduplicates concurrent requests and publishes attributed worktree checkpoints", async () => {
  const f = await fixture(); await f.configure(); const a = await f.task(), b = await f.task("u-bob");
  const [one, duplicate] = await Promise.all([f.q.enqueue(f.alice, a.id, { revision: a.revision }), f.q.enqueue(f.alice, a.id, { revision: a.revision })]); assert.equal(one.id, duplicate.id);
  await f.q.enqueue(f.bob, b.id, { revision: b.revision }); await f.q.tick();
  let jobs = f.q.view(owner).jobs; assert.deepEqual(jobs.map((j) => j.state), ["running", "queued"]); assert.equal(f.starts(), 1);
  const attempt = (await f.store.task(owner, a.id)).attempts[0]!; assert.equal(attempt.user.userId, "u-alice"); assert.equal(attempt.runnerName, "Host computer");
  assert.equal(f.runs.get(jobs[0]!.runId!)!.project, "p-1"); assert.equal(git(f.repo, "status", "--porcelain"), "");
  const safe = JSON.stringify(f.q.view(f.alice)); assert.ok(!safe.includes(f.repo)); assert.ok(!safe.includes("contentHash")); assert.ok(!safe.includes("userIds"));
  f.finish(jobs[0]!.runId!); await settle(f.q, () => f.starts() === 2);
  jobs = f.q.view(owner).jobs; assert.deepEqual(jobs.map((j) => j.state), ["finished", "running"]);
  const completed = await f.store.task(owner, a.id); assert.equal(completed.checkpoints.length, 1); assert.equal(completed.checkpoints[0]!.bundle, "available");
});

test("owner concurrency limit, cancellation ownership and project privacy are enforced", async () => {
  const f = await fixture(); await f.configure(); await f.q.configure({ revision: f.q.view(owner).revision, concurrency: 2 });
  for (const who of [f.alice, f.bob]) { const t = await f.task(who.userId); await f.q.enqueue(who, t.id, { revision: t.revision }); }
  await f.q.tick(); assert.equal(f.starts(), 2); const job = f.q.view(owner).jobs[0]!;
  await assert.rejects(f.q.cancel(f.bob, job.id), status(403));
  delete f.members[1]!.roles["p-1"]; assert.deepEqual(f.q.view(f.bob).jobs, []); await assert.rejects(f.q.cancel(f.bob, job.id), status(404));
  await f.q.cancel(owner, job.id); await settle(f.q, () => f.q.view(owner).jobs.every((j) => j.state === "cancelled"));
});

test("revoking a grant stops active work and rejects queued work before spawning", async () => {
  const f = await fixture(); await f.configure();
  for (let n = 0; n < 2; n++) { const t = await f.task(); await f.q.enqueue(f.alice, t.id, { revision: t.revision }); }
  await f.q.tick(); await f.configure({ userIds: [] });
  await settle(f.q, () => f.q.view(owner).jobs.every((j) => ["failed", "cancelled"].includes(j.state)));
  assert.equal(f.starts(), 1); assert.deepEqual(f.q.view(owner).jobs.map((j) => j.state), ["cancelled", "failed"]);
});

test("queued edits, repository remapping and unavailable host cannot execute stale requests", async () => {
  for (const change of ["task", "mapping", "disabled"] as const) {
    const f = await fixture(); await f.configure(); const t = await f.task(); await f.q.enqueue(f.alice, t.id, { revision: t.revision });
    if (change === "task") await f.store.updateTask(owner, t.id, { goal: "Different work" }, t.revision);
    if (change === "mapping") f.options.resolveRepo = () => join(f.repo, "missing");
    if (change === "disabled") f.disable();
    await f.q.tick(); assert.equal(f.starts(), 0); assert.equal(f.q.view(owner).jobs[0]!.state, "failed");
  }
});

test("restart retains FIFO and reconciles running tasks without duplicate execution", async () => {
  const f = await fixture(); await f.configure();
  for (let n = 0; n < 2; n++) { const t = await f.task(); await f.q.enqueue(f.alice, t.id, { revision: t.revision }); }
  await f.q.tick(); const first = f.q.view(owner).jobs[0]!; await f.q.close();
  const restored = new HostExecution(f.options); queues.push(restored); await restored.load(); await restored.tick(); assert.equal(f.starts(), 1);
  f.finish(first.runId!); await settle(restored, () => f.starts() === 2); assert.deepEqual(restored.view(owner).jobs.map((j) => j.state), ["finished", "running"]);
});

test("unknown starts are not retried and corrupt persistent storage fails closed", async () => {
  const f = await fixture(); await f.configure(); const t = await f.task(); await f.q.enqueue(f.alice, t.id, { revision: t.revision }); await f.q.close();
  const file = join(f.options.dir!, "queue.json"), state = JSON.parse(readFileSync(file, "utf8")); state.jobs[0].state = "starting"; writeFileSync(file, JSON.stringify(state));
  const restored = new HostExecution(f.options); queues.push(restored); await restored.load(); await restored.tick(); assert.equal(f.starts(), 0); assert.equal(restored.view(owner).jobs[0]!.state, "interrupted"); await restored.close();
  state.jobs[0].id = "../../outside"; writeFileSync(file, JSON.stringify(state)); const invalid = new HostExecution(f.options); queues.push(invalid); await assert.rejects(invalid.load()); await assert.rejects(invalid.tick(), status(503));
});

test("HTTP surface rejects settings escalation, execution overrides, extra segments and methods", async () => {
  const f = await fixture(); await f.configure(); const t = await f.task();
  const server = createServer((req, res) => { const parts = (req.url ?? "").split("/").filter(Boolean); void handleHostExecution(req, res, parts, f.q, f.alice, () => { if (req.headers.origin !== "http://test") throw new CollabError("Origin required", 403); }).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const request = (path: string, body: unknown = {}, method = "POST", origin = "http://test") => fetch(`${url}/api/host-execution${path}`, { method, headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    assert.equal((await request("/settings", { revision: 1, concurrency: 4 }, "PUT")).status, 403);
    for (const extra of [{ repo: "/tmp" }, { agent: "claude" }, { trust: "full" }, { loop: { setup: "arbitrary" } }, { userId: "owner" }]) assert.equal((await request(`/tasks/${t.id}`, { revision: t.revision, ...extra })).status, 400);
    assert.equal((await request(`/tasks/${t.id}/extra`)).status, 404);
    assert.equal((await request(`/tasks/${t.id}`, {}, "DELETE")).status, 404);
    assert.equal((await request(`/tasks/${t.id}`, { revision: t.revision }, "POST", "http://other")).status, 403);
    assert.equal((await request(`/tasks/${t.id}`, { revision: t.revision })).status, 202);
    assert.equal(f.starts(), 0);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("permission revoked during CLI discovery is rechecked before any run dispatch", async () => {
  const f = await fixture(); await f.configure(); const t = await f.task();
  await f.q.enqueue(f.alice, t.id, { revision: t.revision });
  f.options.availableAgents = async () => { f.members[0]!.enabled = false; return ["codex"]; };
  await f.q.tick(); assert.equal(f.starts(), 0); assert.equal(f.q.view(owner).jobs[0]!.state, "failed");
  assert.equal((await f.store.task(owner, t.id)).attempts.length, 0);
});

test("removing a queued task stays cancelled after a restart", async () => {
  const f = await fixture(); await f.configure(); const t = await f.task();
  const job = await f.q.enqueue(f.alice, t.id, { revision: t.revision }); await f.q.cancel(f.alice, job.id); await f.q.close();
  const restored = new HostExecution(f.options); queues.push(restored); await restored.load(); await restored.tick();
  assert.equal(f.starts(), 0); assert.equal(restored.view(owner).jobs[0]!.state, "cancelled");
});

test("a storage directory failure disables the queue and cancels running work", async () => {
  const f = await fixture(); await f.configure(); const t = await f.task(); await f.q.enqueue(f.alice, t.id, { revision: t.revision }); await f.q.tick();
  const runId = f.q.view(owner).jobs[0]!.runId!;
  rmSync(f.options.dir!, { recursive: true, force: true }); writeFileSync(f.options.dir!, "unavailable storage");
  await assert.rejects(f.configure()); assert.throws(() => f.q.view(owner), status(503)); assert.equal(f.runs.get(runId)!.status, "cancelled");
});

test("the settings API keeps project policies within the restart storage limit", async () => {
  const f = await fixture(); await f.q.close();
  const file = join(f.options.dir!, "queue.json"), state = JSON.parse(readFileSync(file, "utf8"));
  state.policies = Array.from({ length: 200 }, (_, i) => ({ ...f.policy, projectId: `p-${i}`, enabled: false, userIds: [] })); writeFileSync(file, JSON.stringify(state));
  const restored = new HostExecution(f.options); queues.push(restored); await restored.load();
  await assert.rejects(restored.configure({ revision: restored.view(owner).revision, policy: { ...f.policy, projectId: "p-new", enabled: false, userIds: [] } }), status(400));
  await restored.configure({ revision: restored.view(owner).revision, policy: { ...f.policy, enabled: false, userIds: [] } }); assert.equal(restored.view(owner).policies.length, 200);
});
