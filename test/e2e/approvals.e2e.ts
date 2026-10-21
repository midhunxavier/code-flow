import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ApprovalRecord } from "../../src/approvals.js";
import type { Run, RunEvent } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer approval-inbox-e2e", "content-type": "application/json" };
let server: ChildProcess;
let browser: Browser;
let page: Page;
let base: string;
let repo: string;
let browserApprovalReads = 0;

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function start(tools: boolean) {
  return api<Run>("/api/runs", { pattern: "solo", repo, task: "ASK-APPROVAL implement the sample", roles: { agent: ["codex"] }, approvals: { tools }, loop: { check: "", prove: false, maxMinutes: 1, maxSteps: 5 } });
}

before(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-approvals-ui-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Approval fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: await mkdtemp(join(tmpdir(), "codeflow-approvals-ui-home-")), CODEFLOW_TOKEN: "approval-inbox-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break;
    if (attempt === 99 || server.exitCode !== null) throw new Error(`Approval server did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname === "/api/approvals") browserApprovalReads++; });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
  await page.goto(base);
});

after(async () => {
  await browser?.close();
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
  });
});

test("a live opt-in run receives a one-action inbox and an old approval cannot be reused", { timeout: 30_000 }, async () => {
  const run = await start(true);
  const records = await until(() => api<ApprovalRecord[]>(`/api/approvals?run=${run.id}`), (records) => records.some((record) => record.status === "pending"));
  const request = records.find((record) => record.status === "pending")!;
  assert.equal(request.command, "rm -rf build");
  assert.ok(request.cwd?.includes(run.id), "approval is tied to this run's isolated worktree");
  const inbox = page.getByRole("alert", { name: "Tool approval required" });
  await inbox.waitFor();
  assert.match(await inbox.innerText(), /rm -rf build/);
  await page.reload();
  await inbox.waitFor(); // Reconnecting receives a fresh pending snapshot.
  assert.equal(browserApprovalReads, 0, "live approvals arrive without HTTP polling");
  await inbox.getByRole("button", { name: "Approve once", exact: true }).click();
  await inbox.waitFor({ state: "detached" });
  const finished = await until(() => api<Run>(`/api/runs/${run.id}`), (value) => value.status !== "running");
  assert.equal(finished.status, "done", finished.error);
  const exported = await api<{ events: RunEvent[] }>(`/api/runs/${run.id}/export?transcript=1`);
  assert.ok(exported.events.some((item) => item.type === "agent" && item.event.kind === "tool_result" && item.event.callId === "i3" && !item.event.isError));
  assert.equal((await api<ApprovalRecord[]>(`/api/approvals?run=${run.id}`))[0]!.status, "approved");
  const replay = await fetch(base + `/api/approvals/${request.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) });
  assert.equal(replay.status, 409);
});

test("headless runs decline native requests and cancellation removes a live inbox request", { timeout: 30_000 }, async () => {
  const headless = await start(false);
  const finished = await until(() => api<Run>(`/api/runs/${headless.id}`), (value) => value.status !== "running");
  assert.equal(finished.status, "done", finished.error);
  assert.deepEqual(await api(`/api/approvals?run=${headless.id}`), []);
  const exported = await api<{ events: RunEvent[] }>(`/api/runs/${headless.id}/export?transcript=1`);
  assert.ok(exported.events.some((item) => item.type === "agent" && item.event.kind === "tool_result" && item.event.callId === "i3" && item.event.isError));
  const cancelled = await start(true);
  const [request] = await until(() => api<ApprovalRecord[]>(`/api/approvals?run=${cancelled.id}`), (records) => records.some((record) => record.status === "pending"));
  await api(`/api/runs/${cancelled.id}/cancel`, {});
  await until(() => api<ApprovalRecord[]>(`/api/approvals?run=${cancelled.id}`), (records) => records.every((record) => record.status !== "pending"));
  const late = await fetch(base + `/api/approvals/${request!.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) });
  assert.equal(late.status, 409);
  await page.getByRole("alert", { name: "Tool approval required" }).waitFor({ state: "detached" });
});
