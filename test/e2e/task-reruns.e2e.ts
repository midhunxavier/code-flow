import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer task-reruns-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;
const browserErrors: string[] = [];
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 25_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-task-rerun-e2e-"))); repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]); await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  await writeFile(join(repo, "baseline.test.mjs"), "import { test } from 'node:test'; test('baseline', () => {});\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "task-reruns-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
  await page.goto(base + "/?token=task-reruns-e2e");
});
after(async () => {
  await browser?.close(); if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("task rerun controls preview dependency invalidation and execute a child with explicit retained baseline labels", { timeout: 60_000 }, async () => {
  const body = { repo, pattern: "auto-team", task: "AUTO-SAME-PROVIDER Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, loop: { check: "node --test", maxSteps: 20, maxMinutes: 2 }, approvals: { plan: false } };
  const started = await api<{ id: string }>("/api/runs", body);
  const original = await until(() => api(`/api/runs/${started.id}`), (run) => run.status !== "running"); assert.equal(original.team.status, "completed");
  await page.goto(base + `/#/run/${started.id}`);
  await page.locator(".team-details > summary").click();
  const controls = page.locator(".team-rerun");
  await controls.locator(":scope > summary").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`Rerun panel missing: ${JSON.stringify(browserErrors)} ${String(await page.locator("body").innerText()).slice(0, 3000)}`); });
  await controls.locator(":scope > summary").click();
  await controls.getByLabel("Rerun Beta dependent implementation", { exact: true }).check();
  await controls.getByLabel("Task rerun preview", { exact: true }).getByText("Execute: beta", { exact: true }).waitFor();
  await controls.getByLabel("Task rerun preview", { exact: true }).getByText("Retain as baseline inputs: alpha", { exact: true }).waitFor();
  await controls.getByLabel("New instructions for beta", { exact: true }).fill("Inspect alpha's existing artifact and confirm beta still satisfies acceptance.");
  await controls.getByLabel("New invocation budget", { exact: true }).fill("12");
  await controls.getByRole("button", { name: "Start selected task rerun", exact: true }).click();
  const childSummary = (await until(() => api<any[]>("/api/runs"), (runs) => runs.some((run) => run.parentRunId === started.id && run.teamRerun))).find((run) => run.parentRunId === started.id && run.teamRerun)!;
  const child = await until(() => api(`/api/runs/${childSummary.id}`), (run) => run.status !== "running");
  assert.equal(child.team.status, "completed", child.error ?? JSON.stringify(child.team.gaps));
  assert.deepEqual(child.steps.filter((step: any) => step.taskId && step.kind === "agent").map((step: any) => step.taskId), ["beta"]);
  assert.ok(!child.steps.some((step: any) => step.title === "Plan Auto team")); assert.equal(child.baseRef, original.team.verification.head);
  if (await page.locator(".team-details").getAttribute("open") === null) await page.locator(".team-details > summary").click();
  await page.getByText(/Retained baseline input from/).waitFor(); await page.getByText(/No new diff from this rerun turn/).waitFor();
  assert.equal((await api(`/api/runs/${started.id}`)).team.metrics.invocations, original.team.metrics.invocations);
  const stale = await fetch(base + `/api/runs/${started.id}/rerun-tasks`, { method: "POST", headers, body: JSON.stringify({ expectedHead: "0".repeat(40), taskIds: ["alpha"], budget: { maxSteps: 12, maxMinutes: 2 } }) }); assert.equal(stale.status, 409);
  const forged = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ ...body, teamRerun: child.teamRerun }) }); assert.equal(forged.status, 400);
});
