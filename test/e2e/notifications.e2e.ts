import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { NotificationDelivery } from "../../src/notifications.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer notifications-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string, mode: string, requests: string;
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-notifications-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Notifications fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  mode = join(directory, "mode"); requests = join(directory, "requests.jsonl"); await writeFile(mode, "200");
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "./test/fake-notification-transport.mjs", "--import", "tsx", "src/server.ts"], { cwd: root, env: {
    ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "notifications-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
    CODEFLOW_NOTIFICATIONS_JSON: JSON.stringify([{ id: "fixture", name: "Browser fixture", protocol: "webhook", urlEnv: "NOTIFICATION_FIXTURE_URL", secretEnv: "NOTIFICATION_FIXTURE_CREDENTIAL" }]),
    NOTIFICATION_FIXTURE_URL: "https://notifications-fixture.invalid/private-path?key=secret-fixture-url", NOTIFICATION_FIXTURE_CREDENTIAL: "secret-fixture-credential", NOTIFICATION_FIXTURE_MODE: mode, NOTIFICATION_FIXTURE_REQUESTS: requests,
  }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 99 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage();
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("notification opt-in, real run delivery, visible failure and explicit retry work with an injected local transport", { timeout: 60_000 }, async () => {
  await page.goto(base + "/#/settings/notifications");
  const target = page.getByRole("article", { name: "Notification settings for Browser fixture", exact: true });
  assert.equal(await target.getByLabel("Enable notifications to this destination").isChecked(), false);
  assert.equal((await api("/api/notifications/deliveries")).length, 0);
  await assert.rejects(readFile(requests), /ENOENT/);
  await target.getByLabel("Enable notifications to this destination").check();
  await target.getByLabel("Run finished", { exact: true }).check();
  await target.getByLabel("All projects", { exact: true }).check();
  await target.getByRole("button", { name: "Save notification settings", exact: true }).click();
  await until(() => api("/api/notifications"), (targets) => targets[0]?.settings.enabled === true);
  const run = await api<{ id: string }>("/api/runs", { repo, pattern: "solo", task: "Notification browser task", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
  const history = await until(() => api<NotificationDelivery[]>("/api/notifications/deliveries"), (items) => items.some((item) => item.runId === run.id && item.state === "delivered"));
  assert.equal(history.filter((item) => item.runId === run.id).length, 1);
  const publicData = JSON.stringify({ targets: await api("/api/notifications"), history });
  assert.doesNotMatch(publicData, /private-path|secret-fixture|NOTIFICATION_FIXTURE/);
  await writeFile(mode, "403");
  await target.getByRole("button", { name: "Send test notification", exact: true }).click();
  const failed = await until(() => api<NotificationDelivery[]>("/api/notifications/deliveries"), (items) => items.some((item) => item.manual && item.state === "failed"));
  const failedId = failed.find((item) => item.manual && item.state === "failed")!.id;
  await page.getByRole("button", { name: "Retry delivery", exact: true }).waitFor();
  await writeFile(mode, "200");
  await page.getByRole("button", { name: "Retry delivery", exact: true }).click();
  const retried = await until(() => api<NotificationDelivery[]>("/api/notifications/deliveries"), (items) => items.some((item) => item.id === failedId && item.state === "delivered"));
  assert.equal(retried.find((item) => item.id === failedId)!.totalAttempts, 2);
  await target.getByLabel("Enable notifications to this destination").uncheck();
  await target.getByRole("button", { name: "Save notification settings", exact: true }).click();
  await until(() => api("/api/notifications"), (targets) => targets[0]?.settings.enabled === false);
  const calls = (await readFile(requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 3, "one opted-in completion, one explicit test, and one explicit retry");
  assert.equal(calls[0]!.payload.runId, run.id);
});
