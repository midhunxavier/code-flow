import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-final-delivery-")));
const repo = join(fixture, "repo"), remote = join(fixture, "origin.git"), home = join(fixture, "home"), bin = join(fixture, "bin"), gh = join(fixture, "gh.json");
const token = "qa-final-delivery", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, logs = "";
const errors: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json();
}
async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) { const value = await get(); if (ready(value)) return value; assert.ok(Date.now() < deadline, JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 50)); }
}
before(async () => {
  for (const dir of [repo, remote, home, bin]) mkdirSync(dir);
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "QA"); git(repo, "config", "user.email", "qa@test");
  writeFileSync(join(repo, "README.md"), "No-op delivery fixture\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const head = git(repo, "rev-parse", "HEAD"); git(remote, "init", "--bare", "-q", "-b", "main");
  // Populate a disposable local bare fixture without publishing to an external host.
  git(remote, "fetch", "--no-tags", repo, "main");
  for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/pull/120/head"]) git(remote, "update-ref", ref, head);
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(gh, JSON.stringify({ issues: [], prs: { 120: { number: 120, title: "No-op PR", body: "Fixture", url: "https://ghe.example.com/o/r/pull/120", state: "OPEN", author: { login: "owner" }, authorAssociation: "OWNER", headRefName: "feature", baseRefName: "main", mergeStateStatus: "BEHIND", isCrossRepository: false, comments: [] } } }));
  symlinkSync(join(root, "test/qa-github-pr-open-picker-gh.mjs"), join(bin, "gh"));
  const ports = await reserveQaPorts(); base = `http://127.0.0.1:${ports.port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await ports.release();
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(ports.port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_GH_STATE: gh, FAKE_NOOP_VENDOR: "codex", PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  server.stdout?.on("data", chunk => logs += chunk); server.stderr?.on("data", chunk => logs += chunk);
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(error.message));
});
after(async () => {
  await browser?.close(); server?.kill("SIGTERM");
  if (server?.exitCode === null && server.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); });
  const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR; if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "server.log"), logs); }
  rmSync(fixture, { recursive: true, force: true });
});
test("a no-op PR keeps delivery actions without advertising a code review or preview", async () => {
  const started = await api("/api/runs", { repo, pattern: "solo", task: "Inspect PR without changing files", roles: { agent: ["codex"] }, source: { kind: "pr", number: 120 }, checkpointOnFinish: true, loop: { check: "true" } });
  const run = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running" && !!value.endedAt);
  assert.equal(run.status, "done", run.error); const branch = run.artifacts[0].branch;
  assert.equal((await api(`/api/runs/${run.id}/review-coverage?branch=${encodeURIComponent(branch)}`)).files.length, 0);
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const status = page.getByRole("region", { name: "Pull request status", exact: true });
  await status.getByRole("heading", { name: "Update PR before merging", exact: true }).waitFor();
  assert.equal(await status.getByRole("button", { name: "Update branch", exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("region", { name: "Try and assess the result", exact: true }).count(), 0);
  assert.equal(await status.getByRole("button", { name: /Preview|Review changes|Accept result/ }).count(), 0);
  await api(`/api/runs/${run.id}/test-run`, { testRun: { reason: "QA evidence only" } }); await page.reload();
  const testRun = page.getByRole("region", { name: "Test run", exact: true });
  await testRun.getByRole("button", { name: "Archive test run", exact: true }).waitFor();
  assert.equal(await testRun.getByRole("button", { name: "Update branch", exact: true }).count(), 0);
  await testRun.getByRole("button", { name: "Archive test run", exact: true }).click();
  await until(() => api(`/api/runs/${run.id}`), value => !!value.archived);
  await testRun.waitFor({ state: "detached" }); assert.deepEqual(errors, []);
});
