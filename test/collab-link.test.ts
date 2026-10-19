import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The team collaboration acceptance test (spec §11): a HUB and two linked instances, each a real `src/server.ts`
 * child with its own CODEFLOW_HOME, port and owner token, driven over HTTP only. Alice's computer runs a task and
 * publishes a checkpoint, hands the task to Bob, whose computer imports the bundle before ownership moves and
 * continues from the checkpoint; a restart re-executes nothing; a viewer reads but cannot create; a revoked runner
 * is cut off and its link says so. Nothing from src is imported here, so nothing can land in ~/.codeflow.
 */
const root = fileURLToPath(new URL("..", import.meta.url)), fakeBin = join(root, "test", "fake-bin");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-collab-link-")));
const PASSWORD = "a long enough team password 123", TERMINAL = ["finished", "failed", "stopped", "paused", "unknown", "superseded"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now(), elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;

interface Instance { name: string; home: string; port: number; remotePort: number; token: string; base: string; child?: ChildProcess; output: string }
interface Reply { status: number; body: any; headers: Headers; text: string }
interface CallInit { method?: string; headers?: Record<string, string>; json?: unknown }

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`); return result.stdout.trim();
}
const hasCommit = (cwd: string, commit: string) => spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd }).status === 0;
/** An OS-assigned loopback port; the user's own server lives on 4317/4318, so those are never used even if the OS hands them out. */
async function freePort(): Promise<number> { for (;;) { const port = await new Promise<number>((resolve, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); }); if (port !== 4317 && port !== 4318) return port; } }
async function instance(name: string): Promise<Instance> { const [port, remotePort] = [await freePort(), await freePort()]; const home = join(scratch, `home-${name}`); mkdirSync(home, { recursive: true }); return { name, home, port, remotePort, token: randomBytes(24).toString("hex"), base: `http://127.0.0.1:${port}`, output: "" }; }
/** `node --import tsx src/server.ts` with the fake agents first on PATH and every CODEFLOW_ and FAKE_ variable of the parent environment dropped, so a developer's shell cannot change what the servers do. */
async function start(server: Instance): Promise<void> {
  const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!/^(?:CODEFLOW_|FAKE_)/.test(key)) env[key] = value;
  Object.assign(env, { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, CODEFLOW_HOME: server.home, PORT: String(server.port), CODEFLOW_REMOTE_PORT: String(server.remotePort), CODEFLOW_TOKEN: server.token });
  server.output += `\n[${server.name}] starting at ${elapsed()}\n`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); server.child = child;
  const collect = (chunk: Buffer) => { server.output = (server.output + chunk.toString()).slice(-200_000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${server.name} exited with ${child.exitCode} before answering /api/health`);
    if (await fetch(`${server.base}/api/health`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(5000) }).then((response) => response.ok, () => false)) return;
    if (Date.now() > deadline) throw new Error(`${server.name} did not answer /api/health within 60 s`); await sleep(100);
  }
}
/** SIGTERM is the server's graceful stop (runs are interrupted, the link's stream closes); a server that will not stop in 15 s is killed so a rerun never finds the port busy. */
async function stop(server: Instance): Promise<void> {
  const child = server.child; if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())), killer = setTimeout(() => child.kill("SIGKILL"), 15_000); child.kill("SIGTERM"); await exited; clearTimeout(killer);
  server.output += `\n[${server.name}] stopped at ${elapsed()}\n`;
}
async function call(base: string, path: string, init: CallInit = {}): Promise<Reply> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers }; let body: string | undefined;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
  const response = await fetch(base + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(30_000) }), text = await response.text();
  let parsed: unknown; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers, text };
}
/** The owner API of one instance: the bearer is honoured on the local listener only, which is where these servers listen. */
const owner = (server: Instance) => (path: string, init: CallInit = {}) => call(server.base, path, { ...init, headers: { authorization: `Bearer ${server.token}`, ...init.headers } });
function expect(reply: Reply, status: number, what: string): any { assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text.slice(0, 600)}`); return reply.body; }
async function until<T>(probe: () => Promise<T>, ok: (value: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> { const deadline = Date.now() + timeoutMs; for (;;) { const value = await probe(); if (ok(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}: ${JSON.stringify(value).slice(0, 3000)}`); await sleep(200); } }
const solo = { pattern: "solo", roles: { agent: ["claude"] }, trust: "safe", loop: { check: "true", maxSteps: 4, maxMinutes: 2 } };
/** The runner credential each linked instance keeps in its link file (0600); the test owns the homes, so it may read them to speak to the hub as the runner itself. */
const runnerToken = (server: Instance): string => { const document = JSON.parse(readFileSync(join(server.home, "team-connections", readdirSync(join(server.home, "team-connections")).find((name) => name.endsWith(".json"))!), "utf8")); assert.match(document.token, /^tr-[A-Za-z0-9_-]{43}$/); return document.token; };
const bearer = (token: string) => (path: string, init: CallInit = {}) => call(hub.base, path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
const runsOf = (body: any): any[] => Array.isArray(body) ? body : Array.isArray(body?.runs) ? body.runs : [];

const hub = await instance("hub"), a = await instance("a"), b = await instance("b"), servers = [hub, a, b];
let origin = "", base = "", workA = "", workB = "";
let hubApi: ReturnType<typeof owner>, aApi: ReturnType<typeof owner>, bApi: ReturnType<typeof owner>;
let projectId = "", aliceId = "", bobId = "", taskId = "";
let firstAttempt: any, checkpoint: any, aRunId = "", runsOnA = 0, bRunId = "";
/** A failed phase carries the servers' stdout/stderr and their server.log tails, since the cause is usually in a child's output rather than in the HTTP answer. */
const phase = (name: string, fn: () => Promise<void>) => test(name, async () => {
  try { await fn(); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error)), logs = servers.map((server) => { const log = join(server.home, "server.log"), tail = existsSync(log) ? readFileSync(log, "utf8").slice(-3000) : "(no server.log)"; return `[${server.name} ${server.base}]\n${server.output.slice(-4000)}\n--- ${server.name} server.log ---\n${tail}`; }).join("\n\n");
    failure.message += `\n\n(after ${elapsed()}) ===== server output =====\n${logs}`; throw failure;
  }
});

before(async () => {
  // One origin with the base commit (README plus a repo config that turns the fail-to-pass proof off, so a solo run is one agent turn) and two clones, as two teammates would have.
  origin = join(scratch, "origin"); mkdirSync(origin); git(origin, "init", "-q", "-b", "main"); writeFileSync(join(origin, "README.md"), "sample\n"); mkdirSync(join(origin, ".codeflow")); writeFileSync(join(origin, ".codeflow", "config.json"), JSON.stringify({ prove: false })); git(origin, "add", "-A"); git(origin, "commit", "-qm", "init");
  base = git(origin, "rev-parse", "HEAD"); git(scratch, "clone", "-q", "--no-hardlinks", origin, join(scratch, "work-a")); git(scratch, "clone", "-q", "--no-hardlinks", origin, join(scratch, "work-b")); workA = realpathSync(join(scratch, "work-a")); workB = realpathSync(join(scratch, "work-b"));
  await Promise.all(servers.map(start)); hubApi = owner(hub); aApi = owner(a); bApi = owner(b);
});
after(async () => { await Promise.all(servers.map(stop)); rmSync(scratch, { recursive: true, force: true }); });

phase("the hub owner defines the project, its repository key and the accounts; two computers link as alice and bob and map the repository", async () => {
  const project = expect(await hubApi("/api/projects", { json: { name: "Team fixture", repos: [origin] } }), 201, "POST /api/projects"); projectId = project.id; assert.match(projectId, /^p-[a-f0-9]{8}$/);
  const empty = expect(await hubApi("/api/team/board"), 200, "GET /api/team/board"); assert.equal(empty.tasks.length, 0); assert.equal(empty.me.userId, "owner");
  const defined = expect(await hubApi(`/api/team/projects/${projectId}/repositories`, { method: "PUT", json: { repositories: [{ key: "app", label: "App", defaultBranch: "main" }], revision: empty.revision } }), 200, "PUT repositories");
  assert.equal(defined.role, "maintainer"); assert.deepEqual(defined.repositories.map((repo: any) => repo.key), ["app"]);
  let accounts = expect(await hubApi("/api/accounts"), 200, "GET /api/accounts");
  for (const [username, displayName, role] of [["alice", "Alice", "contributor"], ["bob", "Bob", "contributor"], ["carol", "Carol", "viewer"]]) accounts = expect(await hubApi("/api/accounts", { json: { revision: accounts.revision, username, displayName, password: PASSWORD, roles: { [projectId]: role } } }), 201, `POST /api/accounts ${username}`);
  aliceId = accounts.users.find((user: any) => user.username === "alice").id; bobId = accounts.users.find((user: any) => user.username === "bob").id; assert.ok(aliceId && bobId && aliceId !== bobId);
  const before = expect(await aApi("/api/team-link"), 200, "GET /api/team-link (A, before)"); assert.equal(before.linked, false); assert.equal(before.connection, "offline");
  const linkedA = expect(await aApi("/api/team-link/connect", { json: { url: hub.base, username: "alice", password: PASSWORD, name: "alice-laptop" } }), 201, "POST /api/team-link/connect (A)");
  assert.equal(linkedA.linked, true); assert.equal(linkedA.url, hub.base); assert.equal(linkedA.user.userId, aliceId); assert.equal(linkedA.user.username, "alice"); assert.equal(linkedA.machineName, "alice-laptop"); assert.match(linkedA.runnerId, /^r-[a-f0-9]{16}$/); assert.equal(linkedA.runner?.id, linkedA.runnerId, "the link reports what the hub knows about this runner"); assert.doesNotMatch(JSON.stringify(linkedA), /tr-[A-Za-z0-9_-]{43}/, "the credential never leaves the link");
  const linkedB = expect(await bApi("/api/team-link/connect", { json: { url: hub.base, username: "bob", password: PASSWORD, name: "bob-laptop" } }), 201, "POST /api/team-link/connect (B)"); assert.equal(linkedB.user.userId, bobId);
  assert.deepEqual(expect(await aApi("/api/team-link/mappings", { method: "PUT", json: { projectId, repository: "app", path: workA } }), 200, "PUT mappings (A)").mappings, { [projectId]: { app: workA } });
  assert.deepEqual(expect(await bApi("/api/team-link/mappings", { method: "PUT", json: { projectId, repository: "app", path: workB } }), 200, "PUT mappings (B)").mappings, { [projectId]: { app: workB } });
  const runners = expect(await hubApi("/api/team/runners"), 200, "GET /api/team/runners (hub owner)"); assert.deepEqual(runners.map((runner: any) => [runner.name, runner.userId, runner.online]).sort(), [["alice-laptop", aliceId, true], ["bob-laptop", bobId, true]]);
  // The linked owners see the hub's board through the proxy, as themselves.
  const boardViaA = expect(await aApi("/api/team/board"), 200, "GET /api/team/board (A, proxied)"); assert.equal(boardViaA.me.userId, aliceId); assert.equal(boardViaA.projects[0]?.role, "contributor"); assert.deepEqual(boardViaA.projects[0]?.members.map((member: any) => member.username).sort(), ["alice", "bob", "carol", "owner"]);
  await until(() => aApi("/api/team-link").then((reply) => reply.body), (state) => state?.connection === "connected", "A's event stream to connect", 20_000);
});

phase("alice's computer runs the task the owner assigned her and publishes progress and a checkpoint to the hub", async () => {
  const task = expect(await hubApi("/api/team/tasks", { json: { projectId, repository: "app", title: "Add a greeting file", goal: "Create a greeting file in the repository root.", acceptance: "A new text file exists in the repository root.", owner: aliceId } }), 201, "POST /api/team/tasks");
  taskId = task.id; assert.match(taskId, /^t-[a-f0-9]{16}$/); assert.equal(task.owner.userId, aliceId); assert.equal(task.status, "planned"); assert.equal(task.revision, 1);
  // Bob cannot start alice's task from his computer; the hub refuses the claim and B keeps no record of it.
  const refused = await bApi(`/api/team-link/tasks/${taskId}/start`, { json: solo }); assert.equal(refused.status, 403, refused.text); assert.match(refused.body.error, /Only the task owner may start an attempt/); assert.deepEqual(expect(await bApi("/api/team-link/attempts"), 200, "GET /api/team-link/attempts (B)"), []);
  const started = expect(await aApi(`/api/team-link/tasks/${taskId}/start`, { json: solo }), 201, "POST /api/team-link/tasks/:id/start (A)"); assert.match(started.attemptId, /^[a-f0-9]{32}$/); assert.ok(started.runId); aRunId = started.runId;
  const done = await until(() => hubApi(`/api/team/tasks/${taskId}`).then((reply) => reply.body), (t) => TERMINAL.includes(t?.attempts?.[0]?.state), "alice's attempt to end on the hub");
  firstAttempt = done.attempts[0]; assert.equal(done.attempts.length, 1);
  assert.equal(firstAttempt.state, "finished", `attempt ended as ${firstAttempt.state}: ${firstAttempt.reason ?? ""} / run ${JSON.stringify((await aApi(`/api/runs/${aRunId}`)).body).slice(0, 1500)}`);
  assert.equal(firstAttempt.id, started.attemptId); assert.equal(firstAttempt.runnerName, "alice-laptop"); assert.equal(firstAttempt.user.userId, aliceId); assert.equal(firstAttempt.runId, aRunId); assert.equal(firstAttempt.baseCommit, base);
  assert.ok(firstAttempt.lastSeq > 1, `progress was published more than once (seq ${firstAttempt.lastSeq})`); assert.ok(firstAttempt.progress.changedFiles?.length, "the published progress names the changed files"); assert.ok(firstAttempt.progress.changedFiles.some((path: string) => /^claude-.*\.txt$/.test(path)), JSON.stringify(firstAttempt.progress.changedFiles)); assert.equal(firstAttempt.progress.runStatus, "done"); assert.equal(firstAttempt.progress.tests?.ok, true); assert.match(firstAttempt.head, /^[a-f0-9]{40}$/); assert.notEqual(firstAttempt.head, base);
  assert.equal(done.status, "working"); assert.equal(done.checkpoints.length, 1); checkpoint = done.checkpoints[0];
  assert.equal(checkpoint.bundle, "available"); assert.equal(checkpoint.attemptId, firstAttempt.id); assert.equal(firstAttempt.checkpointId, checkpoint.id); assert.equal(checkpoint.ref, `refs/codeflow/team/${checkpoint.id}`); assert.equal(checkpoint.commit, firstAttempt.head); assert.equal(checkpoint.baseCommit, base); assert.ok(checkpoint.changedFiles.length); assert.equal(checkpoint.createdBy.userId, aliceId); assert.match(checkpoint.requirements, /Add a greeting file/);
  const bundle = join(hub.home, "team", "checkpoints", `${checkpoint.id}.bundle`); assert.equal(statSync(bundle).size, checkpoint.size, "the hub stores the bundle it was promised"); assert.equal(hasCommit(workA, checkpoint.commit), true);
  assert.ok(done.audit.some((entry: any) => entry.action === "attempt-finished")); assert.ok(done.audit.some((entry: any) => entry.action === "bundle-stored"));
  const runs = runsOf(expect(await aApi("/api/runs"), 200, "GET /api/runs (A)")); runsOnA = runs.length; assert.equal(runsOnA, 1); assert.equal(runs[0].id, aRunId); assert.equal(runs[0].status, "done", runs[0].error);
  const records = expect(await aApi("/api/team-link/attempts"), 200, "GET /api/team-link/attempts (A)"); assert.equal(records.length, 1); assert.equal(records[0].state, "finished"); assert.equal(records[0].runStatus, "done"); assert.equal(records[0].lastAckedSeq, records[0].lastSeq); assert.equal(records[0].checkpointId, checkpoint.id); assert.equal(records[0].pendingFinish, undefined);
  assert.equal(runsOf(expect(await bApi("/api/runs"), 200, "GET /api/runs (B)")).length, 0, "the hub never commands bob's computer");
});

phase("alice hands the task over; bob's computer imports the checkpoint before ownership moves and continues from it", async () => {
  const offered = expect(await aApi(`/api/team-link/tasks/${taskId}/handover`, { json: { to: bobId, note: "Take it from here" } }), 200, "POST /api/team-link/tasks/:id/handover (A)");
  assert.equal(offered.handoff.state, "offered"); assert.equal(offered.handoff.to.userId, bobId); assert.equal(offered.handoff.from.userId, aliceId); assert.equal(offered.handoff.checkpointId, checkpoint.id, "the finished attempt's own checkpoint is handed over, not a new one"); assert.equal(offered.checkpoints.length, 1); assert.equal(offered.owner.userId, aliceId);
  const handoffId = offered.handoff.id, headB = git(workB, "rev-parse", "HEAD"); assert.equal(hasCommit(workB, checkpoint.commit), false, "bob's clone has only the base before accepting");
  // The accept is refused where the import cannot happen, and the hub is untouched by the failure.
  const nowhere = await bApi(`/api/team-link/tasks/${taskId}/accept`, { json: { handoffId, repo: join(scratch, "nowhere") } }); assert.equal(nowhere.status, 400, nowhere.text); assert.match(nowhere.body.error, /not inside a Git repository/); assert.equal(expect(await hubApi(`/api/team/tasks/${taskId}`), 200, "GET task").handoff?.state, "offered");
  const accepted = expect(await bApi(`/api/team-link/tasks/${taskId}/accept`, { json: { handoffId, repo: workB } }), 200, "POST /api/team-link/tasks/:id/accept (B)");
  assert.equal(accepted.owner.userId, bobId); assert.equal(accepted.handoff, undefined); assert.equal(accepted.handoffs.length, 1); assert.equal(accepted.handoffs[0].id, handoffId); assert.equal(accepted.handoffs[0].state, "accepted"); assert.equal(accepted.status, "working");
  // The first attempt ended before the hand-over, so it stays `finished`: only a paused, stopped or unknown attempt is superseded by a change of owner; either way nothing is current any more.
  assert.equal(accepted.attempts.length, 1); assert.equal(accepted.attempts[0].state, "finished"); assert.equal(accepted.attempts[0].id, firstAttempt.id);
  assert.equal(hasCommit(workB, checkpoint.commit), true, "the checkpoint commit reached bob's clone"); assert.equal(git(workB, "rev-parse", "HEAD"), headB, "HEAD untouched"); assert.equal(git(workB, "rev-parse", `refs/codeflow/team/${checkpoint.id}`), checkpoint.commit, "the checkpoint lands under its hub id, the id the board and the branch name use"); assert.equal(git(workB, "status", "--porcelain"), "", "the working tree is untouched");
  const summary = expect(await hubApi(`/api/team/board?project=${projectId}`), 200, "GET board (hub owner)").tasks.find((entry: any) => entry.id === taskId); assert.equal(summary.owner.userId, bobId); assert.equal(summary.handoff, undefined, "the card shows only a pending hand-over"); assert.equal(summary.attempt, undefined, "a finished attempt is not the board's current attempt"); assert.equal(summary.checkpoint?.id, checkpoint.id);
  // The hub keeps everyone's inbox: alice learns bob accepted, bob was offered the task (both read here as the runner credential of each computer).
  const alice = bearer(runnerToken(a)), bob = bearer(runnerToken(b));
  const aliceInbox = expect(await alice("/api/team/inbox"), 200, "GET /api/team/inbox (alice's runner)"); assert.ok(aliceInbox.items.some((item: any) => item.kind === "handoff-accepted" && item.taskId === taskId && item.by.userId === bobId), JSON.stringify(aliceInbox)); assert.ok(aliceInbox.items.some((item: any) => item.kind === "assigned" && item.by.userId === "owner")); assert.ok(aliceInbox.unread >= 2);
  const bobInbox = expect(await bob("/api/team/inbox"), 200, "GET /api/team/inbox (bob's runner)"); assert.ok(bobInbox.items.some((item: any) => item.kind === "handoff-offered" && item.taskId === taskId && item.by.userId === aliceId), JSON.stringify(bobInbox));
  assert.equal(aliceInbox.items.some((item: any) => item.kind === "handoff-offered"), false, "inboxes are personal");
  const me = expect(await bob("/api/team/me"), 200, "GET /api/team/me (bob's runner)"); assert.equal(me.me.userId, bobId); assert.equal(me.me.via, "runner"); assert.equal(me.runners.length, 1);
  // Bob continues from the checkpoint: his run starts at its commit and ends as a second attempt with its own checkpoint on top of the first.
  const started = expect(await bApi(`/api/team-link/tasks/${taskId}/start`, { json: { ...solo, fromCheckpointId: checkpoint.id } }), 201, "POST /api/team-link/tasks/:id/start (B)"); bRunId = started.runId;
  const run = expect(await bApi(`/api/runs/${bRunId}`), 200, "GET /api/runs/:id (B)"); assert.equal(run.baseRef, checkpoint.commit, "the run starts from the checkpoint commit"); assert.equal(run.repo, workB); assert.ok(run.task.includes("Take it from here"), "the agent reads the hand-over note");
  const done = await until(() => hubApi(`/api/team/tasks/${taskId}`).then((reply) => reply.body), (t) => TERMINAL.includes(t?.attempts?.[1]?.state), "bob's attempt to end on the hub");
  const second = done.attempts[1]; assert.equal(second.state, "finished", `bob's attempt ended as ${second.state}: ${second.reason ?? ""} / run ${JSON.stringify((await bApi(`/api/runs/${bRunId}`)).body).slice(0, 1500)}`);
  assert.equal(second.id, started.attemptId); assert.equal(second.runnerName, "bob-laptop"); assert.equal(second.user.userId, bobId); assert.equal(second.fromCheckpointId, checkpoint.id); assert.equal(second.baseCommit, checkpoint.commit); assert.ok(second.lastSeq > 1);
  assert.equal(done.checkpoints.length, 2); const next = done.checkpoints.find((entry: any) => entry.id === second.checkpointId); assert.ok(next); assert.equal(next.baseCommit, base); assert.equal(next.bundle, "available"); assert.equal(next.createdBy.userId, bobId); assert.equal(hasCommit(workB, next.commit), true);
  assert.equal(runsOf(expect(await bApi("/api/runs"), 200, "GET /api/runs (B)")).length, 1);
});

phase("restarting alice's computer re-executes nothing: the hub's attempts and A's runs are unchanged", async () => {
  const before = expect(await hubApi(`/api/team/tasks/${taskId}`), 200, "GET task before the restart"), attemptsBefore = before.attempts.map((attempt: any) => [attempt.id, attempt.state, attempt.lastSeq]);
  await stop(a); assert.notEqual(a.child?.exitCode, null, "A exited on SIGTERM"); await start(a);
  const state = await until(() => aApi("/api/team-link").then((reply) => reply.body), (link) => link?.connection === "connected", "A's link to reconnect after the restart", 30_000); assert.equal(state.linked, true); assert.equal(state.user.userId, aliceId); assert.equal(state.runner?.id, state.runnerId);
  // Reconcile runs right after start-up; give it a moment, then nothing must have changed anywhere.
  await sleep(1500);
  const records = expect(await aApi("/api/team-link/attempts"), 200, "GET /api/team-link/attempts (A, after)"); assert.equal(records.length, 1); assert.equal(records[0].state, "finished"); assert.equal(records[0].attemptId, firstAttempt.id); assert.equal(records[0].pendingFinish, undefined);
  const after = expect(await hubApi(`/api/team/tasks/${taskId}`), 200, "GET task after the restart"); assert.deepEqual(after.attempts.map((attempt: any) => [attempt.id, attempt.state, attempt.lastSeq]), attemptsBefore, "the hub lists exactly the same attempts"); assert.equal(after.revision, before.revision, "the restart changed nothing on the task"); assert.equal(after.checkpoints.length, 2);
  const runs = runsOf(expect(await aApi("/api/runs"), 200, "GET /api/runs (A, after)")); assert.equal(runs.length, runsOnA, "no run was started again on A"); assert.equal(runs[0].id, aRunId); assert.equal(runs[0].status, "done");
  const runners = expect(await hubApi("/api/team/runners"), 200, "GET /api/team/runners (hub owner)"); assert.equal(runners.length, 2, "reconnecting reuses the credential instead of minting another runner");
});

phase("a viewer signs in on the hub with a cookie, reads the board and is refused when creating a task", async () => {
  const login = await fetch(`${hub.base}/api/auth/login`, { method: "POST", headers: { origin: hub.base, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ username: "carol", password: PASSWORD }), signal: AbortSignal.timeout(30_000) });
  assert.equal(login.status, 200, await login.text()); const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]!).find((pair) => pair.startsWith(`codeflow_shared_${hub.port}=`)); assert.ok(cookie, "the shared session cookie was set");
  const carol = (path: string, init: CallInit = {}) => call(hub.base, path, { ...init, headers: { cookie, ...init.headers } });
  const board = expect(await carol("/api/team/board"), 200, "GET /api/team/board (carol)"); assert.equal(board.me.via, "browser"); assert.equal(board.projects[0]?.role, "viewer"); assert.equal(board.tasks.length, 1); assert.equal(board.tasks[0].owner.userId, bobId);
  const task = expect(await carol(`/api/team/tasks/${taskId}`), 200, "GET /api/team/tasks/:id (carol)"); assert.equal(task.checkpoints.length, 2); assert.equal(JSON.stringify(task).includes(workA), false, "no local path leaves the hub"); assert.equal(JSON.stringify(task).includes("tokenHash"), false);
  const create = await carol("/api/team/tasks", { headers: { origin: hub.base }, json: { projectId, repository: "app", title: "A viewer's task", goal: "none", acceptance: "none" } }); assert.equal(create.status, 403, create.text); assert.match(create.body.error, /A project contributor role is required to create tasks/);
  const noOrigin = await carol(`/api/team/tasks/${taskId}/comments`, { json: { text: "hello" } }); assert.equal(noOrigin.status, 403, noOrigin.text); assert.match(noOrigin.body.error, /same-origin JSON/);
  assert.equal((await carol("/api/team-link")).status, 403, "the link is the owner's alone");
  assert.equal((await carol("/api/team-link/connections")).status, 403, "saved connections are owner-only");
  assert.equal(expect(await carol("/api/team/board?teamConnection=unrelated"), 200, "shared board ignores owner selection").me.via, "browser"); assert.equal((await carol("/api/team/checkpoints/" + checkpoint.id + "/bundle")).status, 403, "viewers do not download bundles");
});

phase("revoking bob's runner on the hub cuts his computer off and the link reports it", async () => {
  const link = expect(await bApi("/api/team-link"), 200, "GET /api/team-link (B)"); assert.equal(link.error, undefined); const runnerId = link.runnerId; assert.match(runnerId, /^r-[a-f0-9]{16}$/);
  assert.deepEqual(expect(await hubApi(`/api/team/runners/${runnerId}`, { method: "DELETE" }), 200, "DELETE /api/team/runners/:id (hub owner)"), { revoked: true });
  const revoked = expect(await hubApi("/api/team/runners"), 200, "GET /api/team/runners").find((runner: any) => runner.id === runnerId); assert.ok(revoked.revokedAt); assert.equal(revoked.online, false);
  const proxied = await bApi("/api/team/board"); assert.ok([401, 502].includes(proxied.status), `${proxied.status}: ${proxied.text}`); assert.match(proxied.body.error, /credential/); assert.match(proxied.body.error, /Settings → Team/);
  const direct = await bearer(runnerToken(b))("/api/team/board"); assert.equal(direct.status, 401, direct.text); assert.match(direct.body.error, /connect this computer again in Settings → Team/);
  // The hub ends the runner's event stream at once; the link's next reconnect (1 s backoff) learns why and stays offline with the hub's words.
  const state = await until(() => bApi("/api/team-link").then((reply) => reply.body), (info) => info?.connection === "offline" && /credential/.test(info?.error ?? ""), "B's link to report the revocation", 20_000); assert.equal(state.linked, true, "the link is kept for the owner to disconnect or reconnect"); assert.match(state.error, /reconnect in Settings → Team/);
  // Alice's computer is unaffected, and bob's task start is refused by the hub rather than silently run.
  assert.equal(expect(await aApi("/api/team/board"), 200, "GET /api/team/board (A)").me.userId, aliceId);
  const start = await bApi(`/api/team-link/tasks/${taskId}/start`, { json: solo }); assert.equal(start.status, 401, start.text); assert.equal(runsOf(expect(await bApi("/api/runs"), 200, "GET /api/runs (B)")).length, 1, "nothing ran on bob's computer after the revocation");
});

phase("one computer keeps two team servers connected, runs work for each and preserves both across restart", async () => {
  const first = expect(await aApi("/api/team-link/connections"), 200, "connection inventory").connections.find((entry: any) => entry.url === hub.base);
  assert.ok(first?.id);
  const scoped = (connectionId: string) => (path: string, init: CallInit = {}) => aApi(path, { ...init, headers: { ...init.headers, "x-codeflow-team": connectionId } });
  const firstApi = scoped(first.id);
  // Bob's computer also hosts its own independent board, even while its remote credential is revoked.
  const bLocal = (path: string, init: CallInit = {}) => bApi(path, { ...init, headers: { ...init.headers, "x-codeflow-team": "local" } });
  const secondProject = expect(await bApi("/api/projects", { json: { name: "Second team project", repos: [workB] } }), 201, "second project").id;
  const boardB = expect(await bLocal("/api/team/board"), 200, "second local board");
  expect(await bLocal(`/api/team/projects/${secondProject}/repositories`, { method: "PUT", json: { revision: boardB.revision, repositories: [{ key: "app", label: "Other app", defaultBranch: "main" }] } }), 200, "second repository key");
  const accountsB = expect(await bApi("/api/accounts"), 200, "second accounts");
  const membersB = expect(await bApi("/api/accounts", { json: { revision: accountsB.revision, username: "dana", displayName: "Dana", password: PASSWORD, roles: { [secondProject]: "contributor" } } }), 201, "second account");
  const dana = membersB.users.find((entry: any) => entry.username === "dana").id;
  const second = expect(await aApi("/api/team-link/connect", { json: { url: b.base, username: "dana", password: PASSWORD, name: "a-on-second-team" } }), 201, "add second connection");
  const secondApi = scoped(second.id);
  expect(await secondApi("/api/team-link/mappings", { method: "PUT", json: { projectId: secondProject, repository: "app", path: workB } }), 200, "second mapping");
  assert.equal((await aApi("/api/team/board")).status, 409, "an ambiguous unscoped request cannot choose a team");
  assert.equal((await scoped("c-0000000000000000")("/api/team/board")).status, 404, "a stale selection never falls back to another team");
  assert.equal(expect(await firstApi("/api/team/board"), 200, "first board").me.userId, aliceId);
  assert.equal(expect(await secondApi("/api/team/board"), 200, "second board").me.userId, dana);
  assert.equal(expect(await scoped("local")("/api/team/board"), 200, "local board").me.userId, "owner");
  const t1 = expect(await hubApi("/api/team/tasks", { json: { projectId, repository: "app", title: "First independent task", goal: "Write a short note in README.md", acceptance: "README changed", owner: aliceId } }), 201, "first task");
  const t2 = expect(await bLocal("/api/team/tasks", { json: { projectId: secondProject, repository: "app", title: "Second independent task", goal: "Write a short note in README.md", acceptance: "README changed", owner: dana } }), 201, "second task");
  const results = await Promise.all([firstApi(`/api/team-link/tasks/${t1.id}/start`, { json: solo }), secondApi(`/api/team-link/tasks/${t2.id}/start`, { json: solo })]);
  for (const result of results) expect(result, 201, "start independent task");
  await until(() => Promise.all([hubApi(`/api/team/tasks/${t1.id}`), bLocal(`/api/team/tasks/${t2.id}`)]), (tasks) => tasks.every((reply) => reply.body.attempts[0]?.state === "finished"), "both independent checkpoints");
  const recordsA = expect(await firstApi("/api/team-link/attempts"), 200, "first attempts");
  const recordsB = expect(await secondApi("/api/team-link/attempts"), 200, "second attempts");
  assert.ok(recordsA.some((entry: any) => entry.taskId === t1.id)); assert.ok(recordsA.every((entry: any) => entry.taskId !== t2.id));
  assert.equal(recordsB.length, 1); assert.equal(recordsB[0].taskId, t2.id); assert.equal(recordsB[0].repo, workB);
  const downloaded = await aApi(`/api/team/checkpoints/${recordsB[0].checkpointId}/bundle?teamConnection=${second.id}`);
  assert.equal(downloaded.status, 200, "download links use the selected connection too");
  await stop(a); await start(a);
  const after = expect(await aApi("/api/team-link/connections"), 200, "connections after restart");
  assert.deepEqual(after.connections.filter((entry: any) => entry.linked).map((entry: any) => entry.id).sort(), [first.id, second.id].sort());
  assert.equal(expect(await secondApi("/api/team-link"), 200, "second connection after restart").runnerId, second.runnerId);
  assert.equal(expect(await firstApi("/api/team-link"), 200, "first connection after restart").runnerId, first.runnerId);
  expect(await secondApi("/api/team-link", { method: "DELETE" }), 200, "disconnect second only");
  assert.equal(expect(await firstApi("/api/team/board"), 200, "first remains connected").me.userId, aliceId);
  assert.equal((await secondApi("/api/team/board")).status, 404);
});
