import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

/**
 * The runner side of the QA pass on team attempts: a hand-over note travels with its offer, never frozen into the
 * checkpoint a later offer reuses, and an offer the hub would refuse commits and mints nothing; Resume through the link
 * API continues the attempt the task page shows, never an older paused one behind a newer outcome. Runs are a stand-in
 * over real clones (the stubManager of test/collab-runner.test.ts), so heads, commits, bundles and imports are real.
 */
const root = mkdtempSync(join(tmpdir(), "codeflow-qa-collab-attempts-runner-")); process.env.CODEFLOW_HOME = join(root, "home");
const temp = join(root, "tmp"); mkdirSync(temp); process.env.TMPDIR = temp; assert.equal(tmpdir(), temp, "os.tmpdir() follows TMPDIR");
const { CODEFLOW_HOME } = await import("../src/config.js"); assert.equal(CODEFLOW_HOME, process.env.CODEFLOW_HOME, "src/config.js loaded before CODEFLOW_HOME was set");
const { findPattern } = await import("../src/patterns/index.js");
const { CollabStore, ownerActor, memberActor } = await import("../src/collab/store.js");
const { CollabError, currentAttempt } = await import("../src/collab/model.js");
const { createCheckpointBundle } = await import("../src/collab/checkpoints.js");
const { LocalHub } = await import("../src/collab/hub-client.js");
const { readError } = await import("../src/collab/hub-client.js");
const { CollabRunner } = await import("../src/collab/runner.js");
const { handleTeamLinkApi } = await import("../src/collab/link-api.js");
type Run = import("../src/engine.js").Run; type RunEvent = import("../src/engine.js").RunEvent; type MemberRecord = import("../src/collab/store.js").MemberRecord; type Task = import("../src/collab/model.js").Task; type SharedRole = import("../src/shared-accounts.js").SharedRole; type RunnerManager = import("../src/collab/runner.js").RunnerManager; type TeamLinkApiHost = import("../src/collab/link-api.js").TeamLinkApiHost;

const runners: InstanceType<typeof CollabRunner>[] = [];
after(async () => { for (const runner of runners) await runner.close(); rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`); return result.stdout.trim();
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(probe: () => T | Promise<T>, ok: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> { const deadline = Date.now() + timeoutMs; for (;;) { const value = await probe(); if (ok(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 3000)}`); await sleep(25); } }
const refuses = (status: number, pattern?: RegExp) => (error: unknown) => { assert.ok(error instanceof CollabError, `expected a CollabError, got ${String(error)}`); assert.equal(error.status, status, error.message); if (pattern) assert.match(error.message, pattern); return true; };
/** An origin with the base commit and clones of it, like teammates' repositories. */
function fixture(name: string) {
  const folder = join(root, name), origin = join(folder, "origin"); mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main"); writeFileSync(join(origin, "README.md"), "sample\n"); git(origin, "add", "-A"); git(origin, "commit", "-qm", "init");
  const base = git(origin, "rev-parse", "HEAD"), clone = (sub: string) => { const path = join(folder, sub); git(folder, "clone", "-q", "--no-hardlinks", origin, path); return realpathSync(path); };
  return { folder, base, clone };
}
const member = (userId: string, username: string, role: SharedRole): MemberRecord => ({ userId, username, displayName: username[0]!.toUpperCase() + username.slice(1), enabled: true, roles: { "p-1": role } });
const members = [member("u-bob", "bob", "contributor"), member("u-carol", "carol", "viewer")], owner = ownerActor("Mx");
async function newStore(name: string) { const store = new CollabStore({ dir: join(root, name, "team"), members: () => members, projects: () => [{ id: "p-1", name: "App" }], ownerName: () => "Mx" }); await store.load(); await store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0); return store; }
const newTask = (store: InstanceType<typeof CollabStore>, title = "Add a greeting file") => store.createTask(owner, { projectId: "p-1", repository: "app", title, goal: "Create a greeting file.", acceptance: "A file exists.", owner: "owner" });
const solo = { pattern: "solo", roles: { agent: ["claude" as const] }, trust: "safe" as const, loop: { check: "true", maxSteps: 4, maxMinutes: 2 } };
/** A RunManager stand-in over a real clone, as in test/collab-runner.test.ts: `start` adds a worktree on a result branch the way the engine does; the test ends runs itself; every call is counted. */
function stubManager(repo: string, worktrees: string) {
  type Listener = (event: RunEvent) => void;
  const runs = new Map<string, Run>(), listeners = new Map<string, Set<Listener>>(), calls: string[] = []; let n = 0;
  const emit = (run: Run) => { for (const listener of listeners.get(run.id) ?? []) listener({ type: "run", run, seq: 0, ts: Date.now(), runId: run.id } as unknown as RunEvent); };
  const manager = {
    async start(input: { task: string; baseRef?: string }) {
      calls.push("start"); const id = `2501010000-${String(++n).padStart(4, "0")}${randomBytes(2).toString("hex")}`, branch = `codeflow/${id}/solo`, path = join(worktrees, id); mkdirSync(worktrees, { recursive: true });
      const baseRef = input.baseRef ?? git(repo, "rev-parse", "HEAD"); git(repo, "worktree", "add", "-q", "-b", branch, path, baseRef);
      const run = { id, repo, baseRef, branchPrefix: `codeflow/${id}`, status: "running", task: input.task, pattern: "solo", worktrees: [{ name: "solo", branch, path: realpathSync(path) }], steps: [], notes: [], summary: "" } as unknown as Run; runs.set(id, run); return run;
    },
    get: (id: string) => runs.get(id),
    subscribe(id: string, listener: Listener) { const set = listeners.get(id) ?? new Set<Listener>(); set.add(listener); listeners.set(id, set); return () => { set.delete(listener); }; },
    cancel(id: string) { calls.push("cancel"); const run = runs.get(id); if (!run || run.status !== "running") return false; run.status = "cancelled"; emit(run); return true; },
    async resume(id: string) { calls.push(`resume ${id}`); const run = runs.get(id)!; run.status = "running"; emit(run); return run; },
    addNote(id: string, text: string) { calls.push("addNote"); runs.get(id)!.notes.push({ text } as never); },
    async reviewCoverage(id: string, branch: string) { const run = runs.get(id)!, head = git(repo, "rev-parse", `refs/heads/${branch}`), files = git(repo, "diff", "--name-only", `${run.baseRef}..${head}`).split("\n").filter(Boolean); return { head, files }; },
    list: () => [...runs.values()],
  } as unknown as RunnerManager;
  const end = (id: string, status: Run["status"]) => { const run = runs.get(id)!; run.status = status; emit(run); };
  const commit = (id: string, name: string) => { const wt = runs.get(id)!.worktrees[0]!; writeFileSync(join(wt.path, name), `${name}\n`); git(wt.path, "add", "-A"); git(wt.path, "commit", "-qm", name); return git(wt.path, "rev-parse", "HEAD"); };
  return { manager, calls, runs, end, commit };
}
function fakeRequest(method: string, body?: unknown): IncomingMessage { const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage; Object.assign(request, { method, headers: body === undefined ? {} : { "content-type": "application/json" } }); return request; }
function fakeResponse() { const out = { status: 0, body: undefined as unknown as { error?: string; code?: string } }; const response = { writeHead(status: number) { out.status = status; return response; }, end(text?: string) { out.body = text ? JSON.parse(text) : undefined; }, headersSent: false } as unknown as ServerResponse; return { response, out }; }

test("a linked runner preserves stale-revision codes and domain refusal text from its hub", async () => {
  const stale = await readError(new Response(JSON.stringify({ error: "Task changed; reload before saving", code: "stale-revision" }), { status: 409 }));
  assert.equal(stale.code, "stale-revision");
  assert.equal(stale.status, 409);
  const refused = await readError(new Response(JSON.stringify({ error: "Cancel the offered hand-over before deleting its checkpoint" }), { status: 409 }));
  assert.equal(refused.code, undefined);
  assert.match(refused.message, /Cancel the offered hand-over/);
});

test("a hand-over note travels with its offer: a refused offer commits nothing, a declined offer's note never reaches the next agent, and a legacy manifest note is not read", async () => {
  const f = fixture("handover"), repo = f.clone("work"), bobClone = f.clone("bob"), store = await newStore("handover"), hub = new LocalHub(store);
  const stub = stubManager(repo, join(f.folder, "worktrees")), runner = new CollabRunner({ manager: stub.manager, hub: () => hub, findPattern, dir: join(f.folder, "runner"), retryIntervalMs: 0 }); runners.push(runner);
  const task = await newTask(store), { runId } = await runner.startAttempt(task.id, { ...solo, repo });
  stub.commit(runId, "greeting.txt"); stub.end(runId, "cancelled");
  const paused = await until(() => store.task(owner, task.id), (t) => t.attempts[0]?.state === "paused" && t.checkpoints[0]?.bundle === "available", "the attempt to pause with its checkpoint");
  const worktree = stub.runs.get(runId)!.worktrees[0]!, branchHead = () => git(repo, "rev-parse", `refs/heads/${worktree.branch}`), headBefore = branchHead();
  writeFileSync(join(worktree.path, "README.md"), "sample\nan uncommitted change\n");
  // Refused before anything happens: no hand-over commit, no checkpoint, the change still uncommitted.
  await assert.rejects(runner.handOver(task.id, { to: "u-carol", note: "for carol", includeUncommitted: true }), refuses(400, /^The teammate needs at least the contributor role in this project$/));
  await assert.rejects(runner.handOver(task.id, { to: "u-nobody", note: "for nobody", includeUncommitted: true }), refuses(400, /^Choose the teammate from the project's members$/));
  await assert.rejects(runner.handOver(task.id, { to: "owner", note: "to myself", includeUncommitted: true }), refuses(400, /other than the task's current owner/));
  assert.equal(branchHead(), headBefore, "a refused offer commits nothing"); assert.notEqual(git(worktree.path, "status", "--porcelain"), "", "the change is still uncommitted");
  assert.deepEqual((await store.task(owner, task.id)).checkpoints.map((entry) => entry.id), paused.checkpoints.map((entry) => entry.id), "and mints no checkpoint");
  // Offered to bob, declined; offered again, accepted: the same checkpoint both times, with no note of its own.
  const bobActor = memberActor(members[0]!, "browser"), first = await runner.handOver(task.id, { to: "u-bob", note: "first offer, which bob declines", includeUncommitted: true });
  const checkpointId = first.handoff!.checkpointId, minted = first.checkpoints.find((entry) => entry.id === checkpointId)!;
  assert.notEqual(minted.commit, headBefore, "the uncommitted change was committed for the offer"); assert.equal(minted.note, "", "the note is not frozen into the checkpoint");
  await store.respondHandoff(bobActor, task.id, first.handoff!.id, "decline", first.revision);
  const second = await runner.handOver(task.id, { to: "u-bob", note: "second offer: please continue" }); assert.equal(second.handoff!.checkpointId, checkpointId, "a later offer reuses the checkpoint");
  const { runner: bobRunner } = await store.registerRunner("u-bob", "bob-laptop"), bobHub = new LocalHub(store, memberActor(members[0]!, "runner", bobRunner.id), { runnerId: bobRunner.id, runnerName: "bob-laptop" });
  const bobStub = stubManager(bobClone, join(f.folder, "bob-worktrees")), bob = new CollabRunner({ manager: bobStub.manager, hub: () => bobHub, findPattern, dir: join(f.folder, "bob-runner"), resolveRepo: () => bobClone, retryIntervalMs: 0 }); runners.push(bob);
  await bob.acceptHandoff(task.id, second.handoff!.id);
  const started = await bob.startAttempt(task.id, { ...solo, fromCheckpointId: checkpointId }), prompt = bobStub.runs.get(started.runId)!.task;
  assert.ok(prompt.includes("Hand-over note from Mx: second offer: please continue"), prompt); assert.ok(!prompt.includes("first offer"), "a declined offer's note never reaches the agent"); assert.ok(!prompt.includes("for carol"), "nor a refused one's");
  bobStub.end(started.runId, "cancelled"); await until(() => store.task(owner, task.id), (t) => t.attempts.at(-1)?.state === "paused", "bob's attempt to pause");

  // A checkpoint written by an older code-flow carries the note of the offer that minted it; only the accepted offer's note is read.
  const legacy = await newTask(store, "Legacy note"); git(repo, "checkout", "-q", "-b", "legacy"); writeFileSync(join(repo, "legacy.txt"), "legacy\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "legacy"); const head = git(repo, "rev-parse", "HEAD"); git(repo, "checkout", "-q", "main");
  const attemptId = randomBytes(16).toString("hex"), id = randomBytes(16).toString("hex"), bundle = await createCheckpointBundle(repo, head, f.base, id);
  let current = await store.claimAttempt(owner, legacy.id, { attemptId, runnerId: "local", runnerName: "Mx laptop", baseCommit: f.base, revision: legacy.revision });
  await store.addCheckpoint(owner, attemptId, { id, commit: head, baseCommit: f.base, branch: "legacy", size: bundle.size, sha256: bundle.sha256, note: "an old offer's note, meant for carol", requirements: "Legacy note", decisions: [], remaining: "", changedFiles: ["legacy.txt"] });
  await store.storeBundle(owner, id, createReadStream(bundle.file), { size: bundle.size, sha256: bundle.sha256 }); rmSync(bundle.file, { force: true }); await store.finishAttempt(owner, attemptId, { state: "finished", head });
  current = await store.task(owner, legacy.id); const offered = await store.offerHandoff(owner, legacy.id, { to: "u-bob", checkpointId: id, note: "the accepted offer's note" }, current.revision);
  await bob.acceptHandoff(legacy.id, offered.handoff!.id);
  const continued = await bob.startAttempt(legacy.id, { ...solo, fromCheckpointId: id }), legacyPrompt = bobStub.runs.get(continued.runId)!.task;
  assert.ok(legacyPrompt.includes("Hand-over note from Mx: the accepted offer's note"), legacyPrompt); assert.ok(!legacyPrompt.includes("meant for carol"), "the manifest's own note is never read");
  bobStub.end(continued.runId, "cancelled"); await until(() => store.task(owner, legacy.id), (t) => t.attempts.at(-1)?.state === "paused", "the legacy continuation to pause");
});

test("Resume through the link API continues the attempt the task page shows, never an older paused attempt behind a newer finished one", async () => {
  const f = fixture("resume"), repo = f.clone("work"), store = await newStore("resume"), hub = new LocalHub(store);
  const stub = stubManager(repo, join(f.folder, "worktrees")), runner = new CollabRunner({ manager: stub.manager, hub: () => hub, findPattern, dir: join(f.folder, "runner"), retryIntervalMs: 0 }); runners.push(runner);
  const host = { runner, store, manager: stub.manager, findPattern, agents: () => ["claude" as const] } as unknown as TeamLinkApiHost;
  const resume = async (taskId: string) => { const { response, out } = fakeResponse(), path = `/api/team-link/tasks/${taskId}/resume`; await handleTeamLinkApi(fakeRequest("POST", {}), response, new URL(`http://127.0.0.1${path}`), path.split("/").filter(Boolean), host); return out; };
  const task = await newTask(store), older = await runner.startAttempt(task.id, { ...solo, repo }); stub.end(older.runId, "cancelled");
  await until(() => store.task(owner, task.id), (t) => t.attempts[0]?.state === "paused", "the first attempt to pause");
  const newer = await runner.startAttempt(task.id, { ...solo, repo }); stub.commit(newer.runId, "done.txt"); stub.end(newer.runId, "done");
  let current: Task = await until(() => store.task(owner, task.id), (t) => t.attempts[1]?.state === "finished", "the second attempt to finish");
  assert.deepEqual(current.attempts.map((attempt) => attempt.state), ["superseded", "finished"]); assert.equal(currentAttempt(current), undefined, "the newer outcome is where the task stands");
  const refused = await resume(task.id); assert.equal(refused.status, 409); assert.match(refused.body.error!, /^No paused attempt of this task is on this computer; start a new attempt instead$/);
  assert.ok(!stub.calls.some((call) => call.startsWith("resume")), "the older run was not revived");
  await assert.rejects(runner.resumeAttempt(older.attemptId), refuses(409, /superseded/));
  current = await store.task(owner, task.id); assert.equal(current.attempts[0]!.state, "superseded", "nor its attempt on the hub");
  // The attempt the page shows still resumes.
  const third = await runner.startAttempt(task.id, { ...solo, repo }); stub.end(third.runId, "cancelled");
  await until(() => store.task(owner, task.id), (t) => t.attempts[2]?.state === "paused", "the third attempt to pause");
  const resumed = await resume(task.id); assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.ok(stub.calls.includes(`resume ${third.runId}`));
  stub.end(third.runId, "cancelled"); await until(() => store.task(owner, task.id), (t) => t.attempts[2]?.state === "paused", "the resumed attempt to pause again");
});
