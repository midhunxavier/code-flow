import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import type { DeferredRunJob } from "../../src/deferred-runs.js";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "deferred-ui-fixture";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, home: string, repo: string, base: string, project: string, port: number;
let child: ChildProcess, browser: Browser, page: Page;
const request = () => ({ repo, project, pattern: "solo", task: "Implement deferred fixture", roles: { agent: ["claude"] }, options: {}, trust: "full", approvals: { tools: true, plan: true }, loop: { check: "true", maxMinutes: 1, maxSteps: 5, copy: [".env"] } });
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 20_000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Deferred fixture timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); } }
async function start() {
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return; if (child.exitCode !== null || attempt === 399) throw new Error(`Deferred server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
async function stop() { if (!child || child.exitCode !== null || child.signalCode !== null) return; child.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-deferred-browser-"))); home = join(directory, "home"); repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Deferred fixture\n"); await writeFile(join(repo, ".gitignore"), ".env\n"); await writeFile(join(repo, ".env"), "HOST_SECRET=must-not-copy\n");
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "true", copy: [".env"], trust: "full" }));
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  await start(); project = (await api("/api/projects", { name: "Deferred fixture", repos: [repo] })).id;
  const bundle = await build({ stdin: { contents: `import {h,render} from "preact"; import {DeferredRunsPanel} from "./ui/deferred-runs.tsx"; render(h(DeferredRunsPanel,{runRequest:${JSON.stringify(request())},repo:${JSON.stringify(repo)},project:${JSON.stringify(project)}}),document.body);`, resolveDir: root }, bundle: true, write: false, format: "esm", jsx: "automatic", jsxImportSource: "preact", target: "es2022" });
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ extraHTTPHeaders: headers }); page.setDefaultTimeout(7000);
  await page.route(base + "/deferred-fixture", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><script type="module">${bundle.outputFiles![0]!.text.replace(/<\/script/gi, "<\\/script")}</script></body></html>` }));
});
after(async () => { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); });

test("browser explicitly saves and cancels a future safe request and the API rejects forged identities/uploads", { timeout: 30_000 }, async () => {
  assert.equal((await fetch(base + "/api/deferred-runs")).status, 401);
  for (const extra of [{ deferred: { jobId: "forged", claimId: "forged", attempt: 1 } }, { context: { attachments: [{ name: "secret", data: "eA==" }] } }]) {
    const response = await fetch(base + "/api/deferred-runs", { method: "POST", headers, body: JSON.stringify({ run: { ...request(), ...extra } }) }); assert.equal(response.status, 400);
  }
  await page.goto(base + "/deferred-fixture"); await page.getByText("Queue this run configuration", { exact: true }).click();
  await page.getByLabel("Deferred run label", { exact: true }).fill("Later from browser"); await page.getByLabel("Deferred start condition", { exact: true }).selectOption("at");
  await page.getByRole("button", { name: "Save deferred run", exact: true }).click();
  const card = page.getByRole("article", { name: "Deferred run Later from browser", exact: true }); await card.waitFor();
  const job = (await api<DeferredRunJob[]>("/api/deferred-runs"))[0]!;
  assert.equal(job.status, "waiting-time"); assert.ok(job.notBefore > Date.now()); assert.equal(job.run.trust, "safe"); assert.deepEqual(job.run.loop.copy, []); assert.deepEqual(job.run.approvals, { plan: false, tools: false });
  await card.getByRole("button", { name: "Cancel deferred run", exact: true }).click(); await card.getByText("Cancelled", { exact: true }).waitFor();
  assert.equal((await api<DeferredRunJob[]>("/api/deferred-runs"))[0]!.attempts, 0); assert.equal((await api<Run[]>("/api/runs")).length, 0);
  assert.doesNotMatch(await readFile(join(home, "deferred-runs.json"), "utf8"), /must-not-copy|"attachments"/);
});

test("elapsed start survives restart, fake-agent launch persists exact claim, and startup recovers only matching identities", { timeout: 90_000 }, async () => {
  let job = await api<DeferredRunJob>("/api/deferred-runs", { name: "Restarted deferred launch", run: request(), notBefore: Date.now() + 500 });
  await stop(); await new Promise((resolve) => setTimeout(resolve, 550)); await start();
  job = await until(() => api<DeferredRunJob[]>("/api/deferred-runs").then((jobs) => jobs.find((item) => item.id === job.id)!), (item) => item.status === "started");
  const run = await until(() => api<Run>(`/api/runs/${job.runId}`), (run) => run.status !== "running");
  assert.equal(run.status, "done", run.error); assert.equal(run.trust, "safe"); assert.deepEqual(run.loop.copy, []); assert.deepEqual(run.approvals, {}); assert.equal(run.trigger!.via, "deferred");
  assert.deepEqual(run.deferred, { jobId: job.id, claimId: job.claimId, attempt: 1 }); assert.ok(run.worktrees.length);
  for (const tree of run.worktrees) await assert.rejects(access(join(tree.path, ".env")), /ENOENT/);
  const firstEvent = JSON.parse((await readFile(join(home, "runs", `${run.id}.jsonl`), "utf8")).split("\n")[0]!); assert.equal(firstEvent.type, "run"); assert.deepEqual(firstEvent.run.deferred, run.deferred);
  await stop();
  const file = join(home, "deferred-runs.json"), stored = JSON.parse(await readFile(file, "utf8"));
  const matching = stored.jobs.find((item: DeferredRunJob) => item.id === job.id); matching.status = "claimed"; delete matching.runId;
  const mismatch = { ...structuredClone(matching), id: `d-${randomUUID()}`, name: "Unknown mismatched launch", claimId: randomUUID() }; stored.jobs.push(mismatch);
  await writeFile(file, JSON.stringify(stored)); await start();
  const jobs = await api<DeferredRunJob[]>("/api/deferred-runs"); assert.equal(jobs.find((item) => item.id === job.id)!.status, "started"); const unknown = jobs.find((item) => item.id === mismatch.id)!; assert.equal(unknown.status, "unknown");
  assert.equal((await api<Run[]>("/api/runs")).length, 1, "startup reconciliation never launches duplicate work");
  const wrong = await fetch(base + `/api/deferred-runs/${unknown.id}/attach`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: unknown.revision, runId: run.id }) }); assert.equal(wrong.status, 409);
  await page.goto(base + "/deferred-fixture"); const card = page.getByRole("article", { name: "Deferred run Unknown mismatched launch", exact: true });
  await card.waitFor(); assert.equal(await card.getByRole("button", { name: "Retry unknown launch", exact: true }).isDisabled(), true);
  await card.getByRole("button", { name: "Cancel queue recovery", exact: true }).click(); await card.getByText("Cancelled", { exact: true }).waitFor();
  // A cancelled claim that had created a run before crashing is recovered as cancelled.
  await stop(); const cancelled = JSON.parse(await readFile(file, "utf8")); const original = cancelled.jobs.find((item: DeferredRunJob) => item.id === job.id); original.status = "claimed"; original.cancelRequested = true; delete original.runId; await writeFile(file, JSON.stringify(cancelled)); await start();
  assert.equal((await api<DeferredRunJob[]>("/api/deferred-runs")).find((item) => item.id === job.id)!.status, "cancelled");
  assert.equal((await api<Run[]>("/api/runs")).length, 1);
});

test("deferred launches keep strict project membership after restart and never restore a removed repository", { timeout: 30_000 }, async () => {
  const selected = (await api("/api/projects", { name: "Strict deferred destination", repos: [repo] })).id;
  const job = await api<DeferredRunJob>("/api/deferred-runs", { run: { ...request(), project: selected, projectSelection: "explicit" }, notBefore: Date.now() + 60_000 });
  assert.equal(job.run.projectSelection, "explicit");
  await api(`/api/projects/${selected}`, { repos: [] });
  const before = (await api<Run[]>("/api/runs")).length;
  await stop();
  const file = join(home, "deferred-runs.json"), saved = JSON.parse(await readFile(file, "utf8"));
  saved.jobs.find((item: DeferredRunJob) => item.id === job.id).notBefore = Date.now() - 1;
  await writeFile(file, JSON.stringify(saved)); await start();
  const failed = await until(() => api<DeferredRunJob[]>("/api/deferred-runs").then(jobs => jobs.find(item => item.id === job.id)!), item => item.status === "failed");
  assert.match(failed.reason!, /explicit member/);
  assert.equal((await api<Run[]>("/api/runs")).length, before);
  assert.deepEqual((await api<any[]>("/api/projects")).find(item => item.id === selected).repos, []);
});
