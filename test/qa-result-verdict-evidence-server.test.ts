// QA regressions over HTTP: conflicts are 409 (busy runs, a finished run resumed with nothing to do,
// stale team state), invalid races are refused before a run exists, and unknown or missing things
// are 404 without leaking paths. A real server on a free port with fake agents; never 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "qa-verdict-token";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let server: ChildProcess, base: string, repo: string, home: string;

async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...(body === undefined ? { authorization: headers.authorization } : headers), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 2000)}`); await new Promise(r => setTimeout(r, 100)); }
}
const settled = (id: string) => until(() => call(`/api/runs/${id}`).then(r => r.body), run => run.status !== "running");

before(async () => {
  if (!existsSync(join(root, "public/index.html"))) execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  repo = realpathSync(mkdtempSync(join(tmpdir(), "cf-qa-verdict-srv-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "hello\n"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false })); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); });
  assert.ok(port !== 4317 && port !== 4318);
  base = `http://127.0.0.1:${port}`; home = mkdtempSync(join(tmpdir(), "cf-qa-verdict-srv-home-"));
  server = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: TOKEN, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let i = 0; i < 150; i++) { if (await fetch(`${base}/api/health`, { headers: { authorization: headers.authorization } }).then(r => r.ok, () => false)) return; await new Promise(r => setTimeout(r, 200)); }
  throw new Error("server didn't start");
});
after(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  for (const path of [repo, home]) if (path) rmSync(path, { recursive: true, force: true });
});

test("a race or debate with too few participants is refused before any run exists (t07-11)", async () => {
  const count = (await call("/api/runs")).body.length;
  for (const contestants of [["codex", "codex"], ["codex"]]) {
    const refused = await call("/api/runs", { repo, pattern: "race", task: "Race", roles: { contestants, judge: ["claude"] } });
    assert.equal(refused.status, 400, JSON.stringify(refused.body)); assert.match(refused.body.error, /at least 2 contestants/);
  }
  const debate = await call("/api/runs", { repo, pattern: "debate", task: "Debate", roles: { debaters: ["claude"], synthesizer: ["claude"], builder: [] } });
  assert.equal(debate.status, 400); assert.match(debate.body.error, /at least 2 debaters/);
  assert.equal((await call("/api/runs")).body.length, count, "nothing was created");
});

test("busy runs and finished runs refuse lifecycle requests with 409 (t07-11, S15-8)", { timeout: 120_000 }, async () => {
  const started = await call("/api/runs", { repo, pattern: "fix-review", task: "Fix it", roles: { builder: ["codex"], reviewer: ["claude"] }, loop: { check: "sleep 6; true" } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.id;
  const running = await until(() => call(`/api/runs/${id}`).then(r => r.body), run => run.status === "running" && run.worktrees.length > 0);
  const branch = running.worktrees[0].branch, worktree = running.worktrees[0].name;
  for (const [path, body] of [["resume", {}], ["archive", { cleanup: false }], ["outcome", { decision: "accepted", branch, expectedHead: "0".repeat(40) }], ["followups", { kind: "reply", agent: "codex", worktree, message: "more" }], ["merge", { branch, into: "main" }], ["validate-merge", { branch, into: "main" }]] as const) {
    const response = await call(`/api/runs/${id}/${path}`, body);
    assert.equal(response.status, 409, `${path}: ${JSON.stringify(response.body)}`);
  }
  assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers }).then(r => r.status)), 409);
  const finished = await settled(id);
  assert.equal(finished.status, "done", finished.error);
  assert.equal((await call(`/api/runs/${id}/seen`, {})).status, 200);
  const before = await call(`/api/runs/${id}`).then(r => r.body);
  const resumed = await call(`/api/runs/${id}/resume`, {});
  assert.equal(resumed.status, 409); assert.match(resumed.body.error, /already finished/);
  const afterResume = await call(`/api/runs/${id}`).then(r => r.body);
  assert.deepEqual([afterResume.seen, afterResume.endedAt, afterResume.resumes ?? 0, !!afterResume.archived], [before.seen, before.endedAt, before.resumes ?? 0, !!before.archived]);
  assert.equal((await call(`/api/runs/${id}/archive`, { cleanup: false })).status, 200);
  assert.equal((await call(`/api/runs/${id}/resume`, {})).status, 409);
  assert.equal((await call(`/api/runs/${id}`)).body.archived, true, "a refused resume does not unarchive it");
});

test("stale team state is 409; an unknown task or a finished team says what is actually wrong (t11-12)", { timeout: 120_000 }, async () => {
  const started = await call("/api/runs", { repo, pattern: "auto-team", task: "Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { maxMembers: 3 }, approvals: { plan: true }, loop: { maxSteps: 24 } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const awaiting = await until(() => call(`/api/runs/${started.body.id}`).then(r => r.body), run => !!run.awaiting || run.status !== "running");
  assert.ok(awaiting.awaiting, JSON.stringify({ status: awaiting.status, error: awaiting.error, team: awaiting.team?.status }));
  const revision = awaiting.team.revision, task = awaiting.team.tasks[0].id;
  const unknown = await call(`/api/runs/${awaiting.id}/task-priority`, { taskId: "no-such-task", priority: 5, revision });
  assert.equal(unknown.status, 400); assert.match(unknown.body.error, /not on this team's plan/);
  const stale = await call(`/api/runs/${awaiting.id}/task-priority`, { taskId: task, priority: 5, revision: revision + 7 });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /plan changed/);
  assert.equal((await call(`/api/runs/${awaiting.id}/task-priority`, { taskId: task, priority: 5, revision })).status, 200);
  await call(`/api/runs/${awaiting.id}/cancel`, {}); await settled(awaiting.id);

  // A chat whose AI team finished and was applied: there is nothing to resume or resolve.
  const chat = await call("/api/runs", { repo, pattern: "solo", task: "AUTO-MINIMAL implement the requested result", roles: { agent: ["claude"] }, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 16, maxMinutes: 5, approvePlan: false } });
  assert.equal(chat.status, 201, JSON.stringify(chat.body));
  const finished = await until(() => call(`/api/runs/${chat.body.id}`).then(r => r.body), run => run.status !== "running" && !!run.teamTurns?.[0]?.report, 90_000);
  const execution = finished.teamTurns[0].executionId;
  const resume = await call(`/api/runs/${finished.id}/team-resume`, { execution });
  assert.equal(resume.status, 409); assert.match(resume.body.error, /already finished/); assert.doesNotMatch(resume.body.error, /Resolve the saved result/);
  const resolution = await call(`/api/runs/${finished.id}/team-resolution?execution=${execution}`);
  assert.equal(resolution.status, 409, "nothing is left to resolve: not a malformed request"); assert.match(resolution.body.error, /No unresolved team changes/);
  assert.equal((await call(`/api/runs/${finished.id}/team-resolution?execution=unknown`)).status, 400);

  // Templates: publishing over a newer version is a conflict.
  const template = { schemaVersion: 1, id: "qa-verdict", version: 1, name: "QA", description: "QA", scope: "personal", autoEnabled: true, parameters: ["task"], roles: ["builder"], tasks: [{ id: "build", title: "Build", role: "builder", kind: "implementation", instructions: "Do {{task}}", dependsOn: [], paths: ["src"], acceptance: ["Done"] }], contracts: [], task: "{{task}}", criteria: [] };
  assert.equal((await call("/api/team-templates", { template, expectedVersion: 0 })).status, 201);
  assert.equal((await call("/api/team-templates", { template, expectedVersion: 0 })).status, 409);
  assert.equal((await call("/api/team-templates", { template: { ...template, version: 3 }, expectedVersion: 1 })).status, 400);
});

test("a missing workspace file is 404 'File not found' without the absolute path (t08-14)", async () => {
  for (const path of ["does/not/exist.ts", "nope.txt", "README.md/x"]) {
    const missing = await call(`/api/workspace/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
    assert.equal(missing.status, 404, `${path}: ${JSON.stringify(missing.body)}`); assert.equal(missing.body.error, "File not found");
    assert.ok(!missing.body.error.includes(repo));
    const viewer = await call(`/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
    assert.equal(viewer.status, 404, `viewer ${path}: ${JSON.stringify(viewer.body)}`); assert.doesNotMatch(viewer.body.error, /ENOTDIR|lstat/);
  }
  writeFileSync(join(repo, "notes.txt"), "draft\n");
  const loaded = await call(`/api/workspace/file?repo=${encodeURIComponent(repo)}&path=notes.txt`);
  assert.equal(loaded.status, 200);
  rmSync(join(repo, "notes.txt"));
  const saved = await call("/api/workspace/file", { repo, path: "notes.txt", text: "edited\n", expectedHash: loaded.body.hash });
  assert.equal(saved.status, 404); assert.match(saved.body.error, /no longer exists/); assert.ok(!saved.body.error.includes(repo)); assert.doesNotMatch(saved.body.error, /ENOENT|lstat/);
});

test("unknown shared-account operations are 404 whatever the content type (S15-5)", async () => {
  for (const [method, path] of [["GET", "/api/accounts/abc"], ["GET", "/api/accounts/abc/sessions"], ["GET", "/api/accounts/x/y/z"], ["DELETE", "/api/accounts/abc/sessions"]]) {
    const response = await fetch(base + path!, { method, headers: { authorization: headers.authorization } });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match((await response.json() as { error: string }).error, /Unknown shared account operation/);
  }
  const remove = await fetch(`${base}/api/accounts/abc`, { method: "DELETE", headers: { authorization: headers.authorization } });
  assert.equal(remove.status, 415, "account removal is now a real JSON operation");
  const create = await fetch(`${base}/api/accounts`, { method: "POST", headers: { authorization: headers.authorization }, body: "x" });
  assert.equal(create.status, 415, "a real operation still needs JSON");
});
