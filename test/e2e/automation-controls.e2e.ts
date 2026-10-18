import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AutomationEvent, Trigger } from "../../src/automation.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "automation-controls-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, repo: string;
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
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-automation-controls-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Automation controls fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: await mkdtemp(join(tmpdir(), "codeflow-automation-controls-home-")), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 99 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage();
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close(); if (!server || server.exitCode !== null) return; server.kill("SIGTERM");
  await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); });
});

test("automation time zones, dry-run settings, failed events and explicit retry work in the browser", { timeout: 45_000 }, async () => {
  const run = { repo, pattern: "solo", task: "Automation controls task", baseRef: "missing-for-event-qa", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } };
  const trigger = await api<Trigger>("/api/automations", { name: "Automation QA", enabled: true, webhook: true, isolate: false, schedule: { at: "02:30", timezone: "Europe/Stockholm" }, run });
  const accepted = await fetch(`${base}/hooks/${trigger.id}`, { method: "POST", headers: { authorization: `Bearer ${trigger.token}`, "content-type": "application/json" }, body: JSON.stringify({ details: "Preserve this event on retry" }) });
  assert.equal(accepted.status, 202);
  await until(() => api<AutomationEvent[]>(`/api/automations/${trigger.id}/events`), (events) => events.some((event) => event.state === "failed"));
  await page.goto(base + "/#/settings/automations");
  const row = page.locator(".auto-row", { hasText: "Automation QA" });
  await row.getByText("Schedule and next times", { exact: true }).click();
  await row.getByLabel("Time zone", { exact: true }).fill("America/New_York");
  await row.getByRole("button", { name: "Save schedule", exact: true }).click();
  await until(() => api<Trigger[]>("/api/automations"), (triggers) => { const schedule = triggers.find((t) => t.id === trigger.id)?.schedule; return !!schedule && "at" in schedule && schedule.timezone === "America/New_York"; });
  await row.getByLabel("Next scheduled times", { exact: true }).getByText(/Next runs in America\/New_York/).waitFor();
  await row.getByRole("button", { name: "Preview and events", exact: true }).click();
  const inspector = page.getByLabel("Preview and events for Automation QA", { exact: true });
  await inspector.getByText("Dry run", { exact: true }).waitFor();
  await inspector.getByText(/Permissions: standard/).waitFor();
  await inspector.getByRole("cell", { name: "failed", exact: true }).waitFor();
  assert.match(await inspector.innerText(), /Preserve this event on retry/);
  // Repair the original failure externally, then replay the exact saved event/configuration.
  execFileSync("git", ["branch", "missing-for-event-qa", "main"], { cwd: repo });
  await inspector.getByRole("button", { name: "Retry event", exact: true }).click();
  const events = await until(() => api<AutomationEvent[]>(`/api/automations/${trigger.id}/events`), (history) => history.some((event) => event.state === "started" && event.retries === 1));
  assert.match(events[0]!.input.details!, /Preserve this event/);
  await inspector.getByText("started (1 retry)", { exact: true }).waitFor();
  assert.equal(await inspector.getByRole("button", { name: "Retry event", exact: true }).count(), 0);
});
