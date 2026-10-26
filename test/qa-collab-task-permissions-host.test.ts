import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Run, RunEvent, StartRunInput } from "../src/engine.js";
import type { RunnerManager } from "../src/collab/runner.js";
import type { MemberRecord } from "../src/collab/store.js";
import type { HostProjectPolicy, HostExecutionOptions } from "../src/collab/host-execution.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-collab-permissions-host-")));
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

test("non-owner queue refusal explains ownership and never claims the task", async () => {
  const f = await fixture(); await f.configure(); const task = await f.task();
  await assert.rejects(f.q.enqueue(f.bob, task.id, { revision: task.revision }), (error: any) => error.status === 409 && /task owner/.test(error.message) && !/while queued/.test(error.message));
  assert.equal(f.starts(), 0); assert.deepEqual(f.q.view(owner).jobs, []);
});

test("repeated started requests return the original job for both old and refreshed revisions", async () => {
  const f = await fixture(); await f.configure(); const task = await f.task(); const first = await f.q.enqueue(f.alice, task.id, { revision: task.revision }); await f.q.tick();
  const refreshed = await f.store.task(owner, task.id); assert.ok(refreshed.revision > task.revision);
  for (const revision of [task.revision, refreshed.revision]) assert.equal((await f.q.enqueue(f.alice, task.id, { revision })).id, first.id);
  assert.equal(f.starts(), 1); assert.equal(f.q.view(owner).jobs.length, 1);
  f.members[0]!.roles["p-1"] = "viewer";
  await assert.rejects(f.q.enqueue(f.alice, task.id, { revision: refreshed.revision }), status(403));
  await settle(f.q, () => f.q.view(owner).jobs.every(job => job.state === "cancelled"));
  assert.equal(f.starts(), 1, "the internal host runner retains only reporting/cleanup authority after revocation");
});
