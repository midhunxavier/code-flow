import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { git, remoteWorkerFixture } from "../remote-worker-fixture.js";

const root = fileURLToPath(new URL("../..", import.meta.url)), headers = { authorization: "Bearer remote-workers-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, fixture: Awaited<ReturnType<typeof remoteWorkerFixture>>, hostRecord: string;
const errors: string[] = [];
async function api(path: string, body?: unknown) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<any>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 30_000; while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((accept) => setTimeout(accept, 50)); } }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-remote-worker-e2e-"))); fixture = await remoteWorkerFixture(directory); const repo = fixture.source;
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false, check: "true", copy: [".env"] })); git(repo, "add", ".codeflow"); git(repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "configure browser fixture"); hostRecord = join(directory, "host-agent-record"); await mkdir(hostRecord);
  const port = await new Promise<number>((accept) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = (listener.address() as AddressInfo).port; listener.close(() => accept(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, ...fixture.env, PORT: String(port), CODEFLOW_HOME: fixture.home, CODEFLOW_TOKEN: "remote-workers-e2e", FAKE_RECORD_DIR: hostRecord, PATH: `${fixture.folder}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); let output = ""; server.stdout?.on("data", (chunk) => output += chunk); server.stderr?.on("data", (chunk) => output += chunk);
  for (let count = 0; count < 150; count++) { if (await fetch(base + "/api/health", { headers }).then((value) => value.ok, () => false)) break; if (count === 149 || server.exitCode !== null) throw new Error(output); await new Promise((accept) => setTimeout(accept, 100)); }
  await api("/api/projects", { name: "Remote worker", repos: [repo] });
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", (error) => errors.push(error.message)); await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, repo); await page.goto(base + "/?token=remote-workers-e2e");
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((accept) => { const timer = setTimeout(() => { server.kill("SIGKILL"); accept(); }, 5000); server.once("exit", () => { clearTimeout(timer); accept(); }); }); } if (directory) await rm(directory, { recursive: true, force: true }); });

test("composer selects a remote worker, stages references, imports its result and inspects public receipts", { timeout: 60_000 }, async () => {
  await page.getByRole("button", { name: "Agent workflow mode", exact: true }).click(); await page.getByLabel("Task", { exact: true }).fill("WRITE remote browser fixture"); await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#checkCmd")?.value === "true");
  await page.locator(".composer-options > summary").click(); await page.locator(".advanced-controls > summary").click(); await page.getByLabel("Agent execution", { exact: true }).selectOption("fixture"); await page.getByLabel("Worker repository mapping", { exact: true }).selectOption("project");
  await page.locator(".taskbox").getByRole("button", { name: "Permissions", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: /^Ask for approval/ }).isDisabled(), true); await page.keyboard.press("Escape");
  await page.locator('.taskbox input[type="file"]').setInputFiles({ name: "reference.txt", mimeType: "text/plain", buffer: Buffer.from("explicit staged reference") }); await page.getByRole("button", { name: "Remove reference.txt", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Start run/ }).click(); await page.waitForURL(/#\/run\//); const id = page.url().split("#/run/")[1]!;
  const run = await until(() => api(`/api/runs/${id}`), (run) => run.status !== "running"); assert.equal(run.status, "done", run.error); assert.deepEqual(run.loop.remoteWorker, { workerId: "fixture", repoMapping: "project" }); assert.deepEqual(run.loop.copy, []); assert.equal(run.approvals.tools, false); assert.equal(run.lastCheck.ok, true);
  const step = run.steps.find((step: any) => step.remote); assert.equal(step.remote.state, "completed"); assert.equal(step.sessionId, undefined); const result = await readFile(join(run.worktrees[0].path, "result.txt"), "utf8"); assert.equal(result, "local exact base\nexplicit staged reference"); assert.equal((await readdir(hostRecord)).length, 0, "no host agent fallback");
  const receipt = await api(`/api/runs/${id}/remote-steps/${step.id}/receipt`, {}); assert.equal(receipt.remote.state, "completed"); assert.equal(JSON.stringify(receipt).includes("capability"), false); assert.equal(JSON.stringify(receipt).includes("result.bundle"), false);
  await page.locator("button.show-work").first().click();
  const panel = page.getByLabel("Remote execution receipt", { exact: true }); await panel.getByRole("button", { name: "Inspect remote receipt", exact: true }).click(); await panel.getByText("Receipt: completed", { exact: true }).waitFor(); assert.equal(await panel.getByRole("button", { name: "Cancel remote execution", exact: true }).count(), 0);
  const invalid = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ repo: fixture.source, task: "WRITE", pattern: "solo", roles: { agent: ["claude"] }, approvals: { tools: true }, loop: { remoteWorker: { workerId: "fixture", repoMapping: "project" } } }) }); assert.equal(invalid.status, 400);
  await page.goto(base + "/#/settings/connections/execution"); const worker = page.getByLabel("Worker Fixture worker", { exact: true }); await worker.getByRole("button", { name: "Check worker connection", exact: true }).click(); await worker.getByText("claude: CLI installed", { exact: true }).waitFor(); assert.deepEqual(errors, []);
});
