import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { CoordinatedChange } from "../../src/repo-coordination.js";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "coordinated-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, home: string, records: string, repos: string[], base: string, project: string, server: ChildProcess, browser: Browser, page: Page, port: number;
const browserErrors: string[] = [];
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 50_000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Coordinated fixture timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 100)); } }
async function start() { server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_RECORD_DIR: records, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); let output = ""; server.stdout?.on("data", (chunk) => { output += String(chunk); }); server.stderr?.on("data", (chunk) => { output += String(chunk); }); for (let attempt = 0; ; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return; if (server.exitCode !== null || attempt >= 120) throw new Error(`Coordinator server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); } }
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-coordinated-e2e-"))); home = join(directory, "data"); records = join(directory, "records"); await mkdir(records); repos = [join(directory, "api"), join(directory, "web")];
  for (const repo of repos) { await mkdir(join(repo, ".codeflow"), { recursive: true }); git(repo, "init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Coordinated fixture\n"); await writeFile(join(repo, ".gitignore"), ".worktrees/\n.env\n"); await writeFile(join(repo, ".env"), "HOST_ONLY_SECRET=must-not-copy\n"); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false, copy: [".env"], trust: "full" })); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"); }
  port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start(); project = (await api("/api/projects", { name: "Coordinated fixture", repos })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10_000); page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, repos[0]!);
});
after(async () => { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); });

test("two real repositories execute a verified dependency DAG, pin receipts and explicitly merge a reviewed matrix", { timeout: 90_000 }, async () => {
  assert.equal((await fetch(base + "/api/coordinated-changes")).status, 401);
  const bases = repos.map((repo) => git(repo, "rev-parse", "HEAD"));
  await page.goto(base + "/?token=" + token + "#/settings/workspace"); await page.getByRole("button", { name: "Coordinated changes", exact: true }).click(); const panel = page.getByRole("region", { name: "Coordinated repository changes", exact: true });
  await panel.getByText("Create a coordinated change", { exact: true }).click(); await panel.getByLabel("Coordinated project", { exact: true }).selectOption(project); await panel.getByLabel("Coordinated change name", { exact: true }).fill("Verified API and web rollout");
  for (const [index, nodeId] of ["repo1", "repo2"].entries()) { await panel.getByLabel(`Repository for ${nodeId}`, { exact: true }).selectOption(repos[index]!); await panel.getByLabel(`Task for ${nodeId}`, { exact: true }).fill(`Add fixture output for ${nodeId}`); await panel.getByLabel(`Verification for ${nodeId}`, { exact: true }).fill("ls claude-*.txt >/dev/null"); }
  await panel.getByLabel("repo2 depends on repo1", { exact: true }).check(); await panel.getByRole("button", { name: "Start coordinated change", exact: true }).click();
  const card = panel.getByRole("article", { name: "Coordinated change Verified API and web rollout", exact: true }); await card.waitFor();
  let job = await until(() => api<CoordinatedChange[]>("/api/coordinated-changes").then((jobs) => jobs.find((job) => job.name === "Verified API and web rollout")!), (job) => job.status === "ready");
  assert.deepEqual(job.nodes.map((node) => node.baseCommit), bases); assert.deepEqual(job.nodes[1]!.dependencies, [job.nodes[0]!.result]);
  for (const node of job.nodes) { const run = await api<Run>(`/api/runs/${node.runId}`); assert.equal(run.status, "done"); assert.equal(run.trust, "safe"); assert.deepEqual(run.loop.copy, []); assert.deepEqual(run.approvals, {}); const metadata = (run as Run & { coordination: { jobId: string; nodeId: string; claimId: string; attempt: number } }).coordination; assert.deepEqual(metadata, { jobId: job.id, nodeId: node.id, claimId: node.claimId, attempt: 1 }); const first = JSON.parse((await readFile(join(home, "runs", `${run.id}.jsonl`), "utf8")).split("\n")[0]!); assert.deepEqual(first.run.coordination, metadata); assert.equal(git(node.run.repo, "rev-parse", `refs/heads/${node.result!.branch}`), node.result!.commit); assert.equal(await readFile(join(run.worktrees[0]!.path, ".env"), "utf8").then(() => true, () => false), false); }
  const prompts = await Promise.all((await readdir(records)).filter((name) => name.startsWith("claude-")).map((name) => readFile(join(records, name), "utf8").then(JSON.parse))); const downstream = prompts.find((item) => item.prompt.includes("Add fixture output for repo2")); assert.ok(downstream); assert.match(downstream.prompt, new RegExp(job.nodes[0]!.result!.commit)); assert.doesNotMatch(JSON.stringify(prompts), /must-not-copy/);
  await card.getByRole("button", { name: "Validate and preview shipping matrix", exact: true }).waitFor({ timeout: 15_000 }); await card.getByRole("button", { name: "Validate and preview shipping matrix", exact: true }).click(); await card.getByRole("region", { name: "Pinned shipping matrix", exact: true }).waitFor({ timeout: 30_000 });
  job = (await api<CoordinatedChange[]>("/api/coordinated-changes")).find((item) => item.id === job.id)!; assert.equal(job.shipping!.entries.length, 2); assert.deepEqual(job.shipping!.entries.map((entry) => entry.validation.target), bases);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
  await card.getByRole("button", { name: "Merge repo1 into main", exact: true }).click(); job = await until(() => api<CoordinatedChange[]>("/api/coordinated-changes").then((jobs) => jobs.find((item) => item.id === job.id)!), (job) => job.nodes[0]!.status === "shipped"); assert.equal(job.status, "partial-shipped"); assert.equal(git(repos[1]!, "rev-parse", "refs/heads/main"), bases[1]);
  // A concurrent target update is refused before shipping the second repository.
  await writeFile(join(repos[1]!, "concurrent.txt"), "Unrelated target update\n"); git(repos[1]!, "add", "concurrent.txt"); git(repos[1]!, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "concurrent target"); const moved = git(repos[1]!, "rev-parse", "HEAD");
  await card.getByRole("button", { name: "Merge repo2 into main", exact: true }).click(); await panel.getByRole("alert").getByText(/changed.*no shipping/i).waitFor(); assert.equal(git(repos[1]!, "rev-parse", "HEAD"), moved);
  await card.getByRole("button", { name: "Validate and preview shipping matrix", exact: true }).click(); await until(() => api<CoordinatedChange[]>("/api/coordinated-changes").then((jobs) => jobs.find((item) => item.id === job.id)!), (next) => next.shipping?.id !== job.shipping?.id);
  await card.getByRole("button", { name: "Merge repo2 into main", exact: true }).click(); job = await until(() => api<CoordinatedChange[]>("/api/coordinated-changes").then((jobs) => jobs.find((item) => item.id === job.id)!), (job) => job.status === "shipped"); assert.ok(job.nodes.every((node) => node.shippedCommit)); assert.deepEqual(browserErrors, []);
});

test("forged task authority is rejected and cancelled persisted coordination never dispatches on restart", { timeout: 30_000 }, async () => {
  const input = { project, name: "Cancelled fixture", nodes: repos.map((repo, index) => ({ id: `n${index}`, dependsOn: index ? ["n0"] : [], run: { repo, project, pattern: "solo", task: "Cancelled before dependent work", roles: { agent: ["claude"] }, options: {}, loop: { check: "true" } } })) };
  for (const extra of [{ coordination: { jobId: "forged" } }, { context: { paths: [], attachments: [{ data: "eA==" }] } }]) { const response = await fetch(base + "/api/coordinated-changes", { method: "POST", headers, body: JSON.stringify({ ...input, nodes: input.nodes.map((node) => ({ ...node, run: { ...node.run, ...extra } })) }) }); assert.equal(response.status, 400); }
  let job = await api<CoordinatedChange>("/api/coordinated-changes", input); job = await api<CoordinatedChange>(`/api/coordinated-changes/${job.id}/cancel`, { expectedRevision: job.revision }); assert.equal(job.status, "cancelled"); const before = (await api<Run[]>("/api/runs")).length;
  await stop(); await start(); await new Promise((resolve) => setTimeout(resolve, 5500)); job = (await api<CoordinatedChange[]>("/api/coordinated-changes")).find((item) => item.id === job.id)!; assert.equal(job.status, "cancelled"); assert.equal((await api<Run[]>("/api/runs")).length, before);
});
