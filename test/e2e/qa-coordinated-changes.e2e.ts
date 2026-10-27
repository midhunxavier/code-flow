import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import type { CoordinatedChange } from "../../src/repo-coordination.js";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "coordinated-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, home: string, records: string, repos: string[], base: string, project: string, server: ChildProcess, browser: Browser, page: Page, port: number;
const browserErrors: string[] = [];
let secondProject: string, smallProject: string;
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
const shot = async (name: string, focus?: Locator) => { if (evidence) { await focus?.scrollIntoViewIfNeeded(); await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), fullPage: false }); } };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 50_000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Coordinated fixture timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 100)); } }
async function start() { server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_RECORD_DIR: records, FAKE_SLEEP_VENDOR: "codex", FAKE_SLEEP_MS: "40000", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); let output = ""; server.stdout?.on("data", (chunk) => { output += String(chunk); }); server.stderr?.on("data", (chunk) => { output += String(chunk); }); server.once("exit", () => { if (evidence) void mkdir(evidence, { recursive: true }).then(() => writeFile(join(evidence, `server-${Date.now()}.log`), output)); }); for (let attempt = 0; ; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return; if (server.exitCode !== null || attempt >= 600) throw new Error(`Coordinator server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); } }
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-coordinated-e2e-"))); home = join(directory, "data"); records = join(directory, "records"); await mkdir(records); repos = ["api", "web", "other-a", "other-b", "other-c", "small"].map(name => join(directory, name));
  for (const repo of repos) { await mkdir(join(repo, ".codeflow"), { recursive: true }); git(repo, "init", "-q", "-b", repo === repos[1] ? "master" : "main"); await writeFile(join(repo, "README.md"), "Coordinated fixture\n"); await writeFile(join(repo, ".gitignore"), ".worktrees/\n.env\n"); await writeFile(join(repo, ".env"), "HOST_ONLY_SECRET=must-not-copy\n"); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false, copy: [".env"], trust: "full" })); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"); }
  port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start(); project = (await api("/api/projects", { name: "Coordinated fixture", repos: repos.slice(0, 2) })).id; secondProject = (await api("/api/projects", { name: "Other fixture", repos: repos.slice(2, 5) })).id; smallProject = (await api("/api/projects", { name: "Small fixture", repos: repos.slice(5) })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10_000); page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, repos[0]!);
});
after(async () => { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); });


const jobs = () => api<CoordinatedChange[]>("/api/coordinated-changes");
const latest = async (id: string) => (await jobs()).find(job => job.id === id)!;
const request = (name: string, slow = false, check = "true") => ({ project, name, nodes: repos.slice(0, 2).map((repo, i) => ({ id: i ? "repo2" : "repo1", dependsOn: i ? ["repo1"] : [], run: { repo, pattern: "solo", task: `${name} ${i}`, roles: { agent: [slow && !i ? "codex" : "claude"] }, options: {}, loop: { check } } })) });
async function panelFor(projectId = project) {
  await page.goto(`${base}/?token=${token}#/project/${projectId}/repositories`);
  await page.getByRole("link", { name: /Open repository tools/ }).first().click();
  await page.getByRole("button", { name: "Coordinated changes", exact: true }).click();
  const panel = page.getByRole("region", { name: "Coordinated repository changes", exact: true }); await panel.waitFor(); return panel;
}
const refresh = async () => { await page.getByRole("button", { name: "Refresh coordinated changes", exact: true }).click(); };
const cardFor = (name: string) => page.getByRole("article", { name: `Coordinated change ${name}`, exact: true });
const cancelDialog = () => page.getByRole("dialog", { name: "Cancel coordinated change?", exact: true });

test("route project and typed task drafts survive project changes, including fewer repositories", { timeout: 60_000 }, async () => {
  const panel = await panelFor(secondProject); await panel.getByText("Create a coordinated change", { exact: true }).click();
  await until(() => panel.getByLabel("Coordinated project", { exact: true }).inputValue(), value => value === secondProject);
  await panel.getByLabel("Task for repo1", { exact: true }).fill("Keep first draft"); await panel.getByLabel("Task for repo2", { exact: true }).fill("Keep second draft");
  await panel.getByLabel("Provider for repo2", { exact: true }).selectOption("codex"); await panel.getByLabel("Verification for repo1", { exact: true }).fill("npm test"); await panel.getByLabel("repo2 depends on repo1", { exact: true }).check();
  await panel.getByRole("button", { name: "Add repository task", exact: true }).click(); await panel.getByLabel("Task for repo3", { exact: true }).fill("Keep extra draft");
  for (const target of [project, smallProject, secondProject]) {
    await panel.getByLabel("Coordinated project", { exact: true }).selectOption(target);
    assert.equal(await panel.getByLabel("Task for repo1", { exact: true }).inputValue(), "Keep first draft"); assert.equal(await panel.getByLabel("Task for repo2", { exact: true }).inputValue(), "Keep second draft"); assert.equal(await panel.getByLabel("Task for repo3", { exact: true }).inputValue(), "Keep extra draft");
    assert.equal(await panel.getByLabel("Provider for repo2", { exact: true }).inputValue(), "codex"); assert.equal(await panel.getByLabel("Verification for repo1", { exact: true }).inputValue(), "npm test"); assert.equal(await panel.getByLabel("repo2 depends on repo1", { exact: true }).isChecked(), true);
    if (target === smallProject) assert.equal(await panel.getByLabel("Repository for repo2", { exact: true }).inputValue(), "");
  }
  await shot("project-drafts-preserved", panel.getByLabel("Task for repo2", { exact: true }));
  await page.getByRole("button", { name: "Services", exact: true }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/projects", async route => { await gate; await route.continue(); });
  await page.getByRole("button", { name: "Coordinated changes", exact: true }).click();
  await panel.getByText("Create a coordinated change", { exact: true }).click();
  await panel.getByLabel("Task for repo1", { exact: true }).fill("Typed while projects load"); release();
  await until(() => panel.getByLabel("Repository for repo1", { exact: true }).inputValue(), value => value === repos[2]);
  assert.equal(await panel.getByLabel("Task for repo1", { exact: true }).inputValue(), "Typed while projects load"); await page.unroute("**/api/projects");
});

test("ready jobs default to each repository's branch, explain errors and expiry, and confirm cancellation", { timeout: 120_000 }, async () => {
  const panel = await panelFor(); await panel.getByText("Create a coordinated change", { exact: true }).click();
  await panel.getByLabel("Coordinated change name", { exact: true }).fill("Ready confirmation");
  for (const id of ["repo1", "repo2"]) { await panel.getByLabel(`Task for ${id}`, { exact: true }).fill(`Ready fixture ${id}`); await panel.getByLabel(`Verification for ${id}`, { exact: true }).fill("true"); }
  await panel.getByLabel("repo2 depends on repo1", { exact: true }).check(); await panel.getByRole("button", { name: "Start coordinated change", exact: true }).click();
  let job = await until(() => jobs().then(jobs => jobs.find(job => job.name === "Ready confirmation")!), job => job?.status === "ready");
  await refresh(); const card = cardFor(job.name); await card.getByLabel("Shipping target for repo2", { exact: true }).waitFor(); await until(() => card.getByLabel("Shipping target for repo2", { exact: true }).inputValue(), value => value === "master");
  assert.equal(await card.getByLabel("Shipping target for repo1", { exact: true }).inputValue(), "main");
  await card.getByLabel("Shipping target for repo2", { exact: true }).fill("develop"); await card.getByRole("button", { name: "Validate and preview shipping matrix", exact: true }).click(); await card.getByRole("alert").waitFor(); assert.match(await card.getByRole("alert").innerText(), /Branch "develop" does not exist/); assert.doesNotMatch(await card.getByRole("alert").innerText(), /rev-parse|fatal:|Your draft/); await shot("missing-shipping-branch", card.getByRole("alert"));
  await card.getByLabel("Shipping target for repo2", { exact: true }).fill("master"); await card.getByRole("button", { name: "Validate and preview shipping matrix", exact: true }).click(); await card.getByRole("region", { name: "Pinned shipping matrix", exact: true }).waitFor(); job = await latest(job.id);
  await page.clock.setFixedTime(job.shipping!.expiresAt + 1000); await panelFor(); await until(() => card.getByLabel("Shipping target for repo2", { exact: true }).inputValue(), value => value === "master"); await card.getByText(/Preview expired/).waitFor(); const merge = card.getByRole("button", { name: "Merge repo2 into master", exact: true }); assert.equal(await merge.isDisabled(), true); assert.match(await page.locator(`[id="${await merge.getAttribute("aria-describedby")}"]`).innerText(), /Validate/); await shot("expired-matrix", card.getByText(/Preview expired/)); await page.clock.setFixedTime(Date.now());
  await card.getByRole("button", { name: "Cancel coordinated change", exact: true }).click(); await cancelDialog().waitFor(); assert.match(await cancelDialog().innerText(), /Withdraw 2 verified results/); assert.match(await cancelDialog().innerText(), /reruns their agents/); await shot("cancel-ready-confirmation"); await cancelDialog().getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal((await latest(job.id)).revision, job.revision);
  await card.getByRole("button", { name: "Cancel coordinated change", exact: true }).click(); await cancelDialog().getByRole("button", { name: "Cancel coordinated change", exact: true }).click(); job = await until(() => latest(job.id), job => job.cancelRequested); assert.ok(job.nodes.every(node => node.status === "cancelled"));
  await refresh(); assert.equal(await card.getByRole("button", { name: "Retry task repo2", exact: true }).isDisabled(), true); await card.getByText(/Retry repo1 first/).waitFor(); assert.ok(job.history.some(entry => /Withdrew this verified result/.test(entry.detail)));
});

test("idle waiting has stable storage and cancels from the visible revision on its first confirmation", { timeout: 90_000 }, async () => {
  let job = await api<CoordinatedChange>("/api/coordinated-changes", request("Slow waiting", true)); job = await until(() => latest(job.id), job => job.nodes[0]!.status === "running" && job.nodes[1]!.status === "waiting");
  const revision = job.revision, mtime = (await stat(join(home, "coordinated-changes.json"))).mtimeMs;
  await panelFor(); await new Promise(resolve => setTimeout(resolve, 11000)); job = await latest(job.id); assert.equal(job.revision, revision); assert.equal((await stat(join(home, "coordinated-changes.json"))).mtimeMs, mtime);
  const card = cardFor(job.name); await card.getByRole("button", { name: "Cancel coordinated change", exact: true }).click(); await cancelDialog().waitFor(); assert.match(await cancelDialog().innerText(), /running or claimed tasks: repo1/); const cancelled = page.waitForResponse(response => response.url().endsWith(`/${job.id}/cancel`) && response.request().method() === "POST"); await cancelDialog().getByRole("button", { name: "Cancel coordinated change", exact: true }).click(); assert.equal((await cancelled).status(), 200);
  job = await latest(job.id); assert.equal(job.status, "cancelled"); const before = JSON.stringify(job); const retry = await fetch(`${base}/api/coordinated-changes/${job.id}/nodes/repo2/retry`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: job.revision }) }); assert.equal(retry.status, 400); assert.match((await retry.json()).error, /Retry repo1 first/); assert.equal(JSON.stringify(await latest(job.id)), before); await shot("cancelled-upstream-retry-explained", card.getByRole("button", { name: "Retry task repo2", exact: true }));
});

test("an exhausted task explains why retry is disabled", { timeout: 120_000 }, async () => {
  let job = await api<CoordinatedChange>("/api/coordinated-changes", request("Attempt limit", false, "false")); await panelFor(); const card = cardFor(job.name);
  for (let attempt = 1; attempt <= 3; attempt++) { job = await until(() => latest(job.id), job => job.nodes[0]!.status === "failed" && job.nodes[0]!.attempts === attempt); await refresh(); if (attempt < 3) await card.getByRole("button", { name: "Retry task repo1", exact: true }).click(); }
  const retry = card.getByRole("button", { name: "Retry task repo1", exact: true }); assert.equal(await retry.isDisabled(), true); assert.match(await page.locator(`[id="${await retry.getAttribute("aria-describedby")}"]`).innerText(), /three-attempt limit \(3\)/); await shot("attempt-limit", retry);
  job = await latest(job.id); await api(`/api/coordinated-changes/${job.id}/cancel`, { expectedRevision: job.revision });
});

test("a changed result branch blocks its dependent result and tells the browser which task to retry", { timeout: 90_000 }, async () => {
  let job = await api<CoordinatedChange>("/api/coordinated-changes", request("Changed result"));
  job = await until(() => latest(job.id), job => job.status === "ready");
  const run = await api<Run>(`/api/runs/${job.nodes[0]!.runId}`), tree = run.worktrees[0]!.path;
  await writeFile(join(tree, "after-verification.txt"), "changed after verification\n"); git(tree, "add", "after-verification.txt"); git(tree, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "changed result");
  job = await until(() => latest(job.id), job => job.nodes.every(node => node.status === "blocked")); await panelFor(); const card = cardFor(job.name);
  await card.getByRole("region", { name: "Repository task repo1", exact: true }).getByText(/repo1's result branch changed from/).waitFor(); await card.getByRole("region", { name: "Repository task repo2", exact: true }).getByText(/Dependency repo1.*changed/).waitFor();
  assert.equal(await card.getByRole("button", { name: "Retry task repo2", exact: true }).isDisabled(), true); assert.equal(await card.getByText(/Last verified branch/).count(), 2); assert.doesNotMatch(await card.innerText(), /fatal:|rev-parse|Your draft is preserved/); await shot("changed-result-dependency", card.getByRole("region", { name: "Repository task repo2", exact: true }).getByText(/Dependency repo1.*changed/));
  job = await latest(job.id); await api(`/api/coordinated-changes/${job.id}/cancel`, { expectedRevision: job.revision });
});

test("invalid coordinator storage keeps the app healthy and the corrupt bytes untouched", { timeout: 90_000 }, async () => {
  const file = join(home, "coordinated-changes.json"), good = await readFile(file, "utf8"), corrupt = JSON.parse(good); corrupt.jobs[0].status = corrupt.jobs[0].status === "cancelled" ? "ready" : "cancelled";
  for (const bad of ['{"version":1,"jobs":[', JSON.stringify(corrupt)]) {
    await stop(); await writeFile(file, bad); await start(); assert.equal((await fetch(base + "/api/health", { headers })).status, 200); const response = await fetch(base + "/api/coordinated-changes", { headers }); assert.equal(response.status, 400); assert.match((await response.json()).error, /coordinated-changes.json.*cannot be read/); await panelFor(); await page.getByRole("region", { name: "Coordinated repository changes", exact: true }).getByRole("alert").waitFor(); assert.equal(await readFile(file, "utf8"), bad); assert.ok(Array.isArray(await api("/api/runs"))); await shot("corrupt-storage-feature-error", page.getByRole("region", { name: "Coordinated repository changes", exact: true }).getByRole("alert"));
  }
  await stop(); await writeFile(file, good); await start(); assert.ok((await jobs()).length >= 3); assert.deepEqual(browserErrors, []);
});
