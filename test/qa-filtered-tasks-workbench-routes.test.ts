import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "../src/engine.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-checkpoint-routes-"))), repo = join(directory, "repo"), home = join(directory, "home");
const headers = { authorization: "Bearer qa-checkpoint-routes", "content-type": "application/json" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, encoding: "utf8" }).trim();
let server: ChildProcess, port = 0, original: Run, older = "", made = "", worktree = "";
const call = async (path: string, body?: unknown) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };

before(async () => {
  execFileSync("mkdir", ["-p", repo]); git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "older\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "older main commit"); older = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "README.md"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "run base");
  port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const value = (probe.address() as AddressInfo).port; probe.close(() => resolve(value)); }); });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, PORT: String(port), CODEFLOW_REMOTE_PORT: "0", CODEFLOW_TOKEN: "qa-checkpoint-routes", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let attempt = 0; attempt < 150 && !await fetch(`http://127.0.0.1:${port}/api/health`, { headers }).then((response) => response.ok, () => false); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const started = await call("/api/runs", { repo, pattern: "solo", task: "Checkpoint route fixture", roles: { agent: ["codex"] }, loop: { check: "", maxSteps: 3 } }); assert.equal(started.status, 201, JSON.stringify(started.body));
  for (let attempt = 0; attempt < 200; attempt++) { original = (await call(`/api/runs/${started.body.id}`)).body; if (original.status !== "running") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.equal(original.status, "done", original.error); worktree = original.worktrees[0]!.path;
  git(worktree, "add", "-A"); await writeFile(join(worktree, "run-made.txt"), "made by the run\n"); git(worktree, "add", "-A"); git(worktree, "commit", "-qm", "run work"); made = git(worktree, "rev-parse", "HEAD");
});
after(async () => { server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); await rm(directory, { recursive: true, force: true }); });

test("fork accepts the run's base and later commits but refuses history from before the run", async () => {
  const refused = await call(`/api/runs/${original.id}/fork`, { commit: older });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /not part of this run: it was made before the run started/);
  assert.equal(((await call("/api/runs")).body as Run[]).filter((run) => run.parentRunId === original.id).length, 0);
  const listed = (await call(`/api/workspace/checkpoints?repo=${encodeURIComponent(worktree)}&base=${original.baseRef}`)).body;
  assert.deepEqual(listed.checkpoints.map((item: { sha: string; owned: boolean }) => [item.sha, item.owned]), [[made, true], [original.baseRef, true], [older, false]]);
  const forked = await call(`/api/runs/${original.id}/fork`, { commit: made }); assert.equal(forked.status, 201, JSON.stringify(forked.body));
  // The child shares the repository's idle-workspace lease; let it finish before the next tests change the worktree.
  for (let attempt = 0; attempt < 200 && (await call(`/api/runs/${forked.body.id}`)).body.status === "running"; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
});

test("applying checkpoint files returns 409 for a moved HEAD and asks before deleting files", async () => {
  const stale = await call("/api/workspace/apply-checkpoint", { repo: worktree, runId: original.id, source: original.baseRef, expectedHead: original.baseRef, paths: ["README.md"] });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /HEAD changed since checkpoints were loaded/);
  const body = { repo: worktree, runId: original.id, source: original.baseRef, expectedHead: made, paths: ["run-made.txt"] };
  const asked = await call("/api/workspace/apply-checkpoint", body);
  assert.equal(asked.status, 409); assert.equal(asked.body.confirm, "deleteFiles"); assert.match(asked.body.error, /run-made\.txt/);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  const applied = await call("/api/workspace/apply-checkpoint", { ...body, confirmDeletes: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.deepEqual(applied.body.deleted, ["run-made.txt"]); assert.equal(git(worktree, "status", "--porcelain"), "D run-made.txt");
  git(worktree, "checkout", "--", ".");
});

test("staging a revert over a tracked edit says to commit or save it first", async () => {
  const preview = await call("/api/workspace/preview-revert", { repo: worktree, runId: original.id, commit: made, expectedHead: made }); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  await writeFile(join(worktree, "README.md"), "a tracked edit\n");
  const refused = await call("/api/workspace/apply-revert", { repo: worktree, runId: original.id, commit: made, expectedHead: made, fingerprint: preview.body.fingerprint });
  assert.notEqual(refused.status, 200); assert.equal(refused.body.error, "Commit or save all existing changes before reverting a commit");
  git(worktree, "checkout", "--", ".");
});
