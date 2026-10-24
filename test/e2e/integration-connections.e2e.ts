import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url)), token = "project-integrations-fixture";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const credential = "private-project-source-token", webhookToken = "private-notification-token";
let directory: string, repo: string, home: string, ghState: string, requests: string, project: string, otherProject: string, connection: string, webhook: string, port: number, base: string;
let server: ChildProcess, browser: Browser, page: Page;
const errors: string[] = [];
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json();
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 75)); }
}
async function start() {
  server = spawn(process.execPath, ["--import", "./test/fake-integration-transport.mjs", "--import", "./test/fake-notification-transport.mjs", "--import", "tsx", "src/server.ts"], { cwd: root, env: {
    ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_GH_STATE: ghState, SOURCE_IMPORT_KEY: credential,
    CODEFLOW_INTEGRATIONS_JSON: JSON.stringify([{ id: "admin-source", name: "Administrator source", provider: "gitlab", project: "group/admin", credentialEnv: "SOURCE_IMPORT_KEY", baseUrl: "https://source-fixture.invalid/api/v4/" }]),
    CODEFLOW_NOTIFICATIONS_JSON: "[]", NOTIFICATION_FIXTURE_CREDENTIAL: webhookToken, NOTIFICATION_FIXTURE_REQUESTS: requests,
  }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", chunk => output += chunk); server.stderr?.on("data", chunk => output += chunk);
  for (let i = 0; ; i++) { if (await fetch(base + "/api/health", { headers }).then(r => r.ok, () => false)) return; if (i === 150 || server.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 80)); }
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
const card = (name: string) => page.getByRole("article", { name: `${name} connections`, exact: true });
const wizard = () => page.getByRole("dialog");
async function connectionsPage() { await page.goto(`${base}/?token=${token}#/project/${project}/connections`); await card("GitHub").waitFor(); }
async function audit() {
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open]")].every(dialog => getComputedStyle(dialog).opacity === "1"));
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
  assert.deepEqual(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page fits its viewport");
}
const runBody = (projectId: string) => ({ project: projectId, projectSelection: "explicit", repo, pattern: "solo", task: "Controlled project fixture", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxMinutes: 1, maxSteps: 4 } });

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-project-integrations-"))); repo = join(directory, "repo"); home = join(directory, "home"); ghState = join(directory, "github.json"); requests = join(directory, "notifications.jsonl");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  await mkdir(repo); git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Project integration fixture\n");
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "true", setup: "true", prove: false }));
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"); git("branch", "feature");
  git("clone", "--bare", "-q", repo, join(directory, "upstream.git")); git("remote", "add", "origin", join(directory, "upstream.git"));
  await writeFile(ghState, JSON.stringify({ issues: [{ number: 3, title: "GitHub fixture issue", body: "Controlled source", url: "https://github.com/fixture/repo/issues/3" }], prs: { 7: { number: 7, title: "GitHub fixture PR", body: "Review this fixture", url: "https://github.com/fixture/repo/pull/7", headRefName: "feature", baseRefName: "main", state: "OPEN", isCrossRepository: false, failOn: "all" } }, comments: [], reviews: [] }));
  port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const number = (probe.address() as AddressInfo).port; probe.close(() => resolve(number)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start();
  project = (await api("/api/projects", { name: "Integration fixture", repos: [repo] })).id;
  otherProject = (await api("/api/projects", { name: "Other project", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message)); await page.addInitScript(() => localStorage.setItem("sideOpen", "0")); await mkdir(join(root, "output/playwright"), { recursive: true });
});
after(async () => { await browser?.close(); await stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

test("project setup guides authentication, handles failures, and saves a tested encrypted connection", { timeout: 60_000 }, async () => {
  assert.equal((await fetch(base + "/api/integration-connections")).status, 401);
  await connectionsPage();
  for (const name of ["GitHub", "GitLab", "Bitbucket", "Linear", "Jira", "Slack", "Webhooks"]) await card(name).waitFor();
  await card("GitLab").getByText(/Administrator-managed/).waitFor();
  assert.equal(await card("GitLab").getByRole("button", { name: "Disconnect", exact: true }).count(), 0);
  await card("GitLab").getByRole("button", { name: "Connect another", exact: true }).click();
  await wizard().getByLabel("Access token", { exact: true }).fill("invalid-secret-token"); await wizard().getByRole("button", { name: "Continue", exact: true }).click();
  await wizard().getByLabel("Connection name", { exact: true }).fill("Project GitLab"); await wizard().getByLabel("Repository on the service").fill("group/repo");
  await wizard().getByText("Advanced connection options", { exact: true }).click(); await wizard().getByLabel("API base URL (optional)").fill("https://source-fixture.invalid/api/v4/");
  await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("alert").filter({ hasText: "HTTP 401" }).waitFor(); assert.doesNotMatch(await wizard().innerText(), /invalid-secret-token/);
  await wizard().getByRole("button", { name: "Back", exact: true }).click(); await wizard().getByLabel("Access token", { exact: true }).fill(credential); await wizard().getByRole("button", { name: "Continue", exact: true }).click();
  await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("status").waitFor(); await audit();
  await page.screenshot({ path: join(root, "output/playwright/integration-connect.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await audit(); await page.screenshot({ path: join(root, "output/playwright/integration-connect-mobile.png"), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  await wizard().getByRole("button", { name: "Connect", exact: true }).click(); await wizard().waitFor({ state: "hidden" });
  connection = (await api("/api/integration-connections")).connections.find((c: any) => c.name === "Project GitLab").id;
  const state = await api(`/api/integration-connections/projects/${project}?repository=${encodeURIComponent(repo)}`); assert.deepEqual(state.bindings, [{ projectId: project, repository: repo, connectionId: connection }]);
  assert.doesNotMatch(JSON.stringify(state), /private-project-source-token|credentialRef|SOURCE_IMPORT_KEY/);
  assert.doesNotMatch(await readFile(join(home, "integration-secrets/connections.enc"), "utf8"), /private-project-source-token|Project GitLab/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /private-project-source-token/);
});

test("issue import retains project, repository and untrusted source through a real agent task", { timeout: 60_000 }, async () => {
  await card("GitLab").getByRole("button", { name: "Choose issue or PR", exact: true }).click(); await page.getByRole("button", { name: "Choose issue", exact: true }).click();
  const preview = page.getByRole("article", { name: "Source preview", exact: true }); await preview.getByRole("button", { name: "Start task from issue", exact: true }).click();
  await page.getByTitle(repo, { exact: true }).waitFor();
  const options = page.locator(".composer-options"); if (await options.getAttribute("open") === null) await options.locator(":scope > summary").click();
  const advanced = page.locator(".advanced-controls"); if (await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click(); await page.getByLabel("Workflow", { exact: true }).selectOption("solo");
  const started = page.waitForResponse(r => r.url().endsWith("/api/runs") && r.request().method() === "POST"); await page.getByRole("button", { name: /^(Start run|Send)$/, exact: true }).click();
  const response = await started, result = await response.json(); assert.equal(response.status(), 201, JSON.stringify(result));
  const run = await until(() => api(`/api/runs/${result.id}`), r => r.status !== "running"); assert.equal(run.status, "done", run.error); assert.equal(run.project, project); assert.equal(run.repo, repo); assert.equal(run.externalSource.integration, connection); assert.equal(run.externalSource.trusted, false); assert.deepEqual(run.externalSource.projectContext, { project, repository: repo });
  const forged = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ ...runBody(otherProject), externalSourceId: run.externalSource.id }) }); assert.equal(forged.status, 400); assert.match(await forged.text(), /project and repository/);
});

test("GitHub reuses CLI auth and opens review and failing-check tasks in the selected project", { timeout: 60_000 }, async () => {
  await connectionsPage(); await card("GitHub").getByRole("button", { name: "Connect", exact: true }).click(); await wizard().getByText(/gh auth login/).waitFor();
  const state = JSON.parse(await readFile(ghState, "utf8")); await writeFile(ghState, JSON.stringify({ ...state, signedOut: true }));
  await wizard().getByRole("button", { name: "Continue", exact: true }).click(); await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("alert").filter({ hasText: "gh auth login" }).waitFor();
  await writeFile(ghState, JSON.stringify(state)); await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("status").waitFor(); await wizard().getByRole("button", { name: "Connect", exact: true }).click(); await wizard().waitFor({ state: "hidden" });
  await card("GitHub").getByRole("button", { name: "Choose issue or PR", exact: true }).click(); await page.getByRole("button", { name: "Create pull request from completed work", exact: true }).click();
  await page.getByRole("button", { name: "Review pull request", exact: true }).click(); await page.getByRole("button", { name: "Load PR preview", exact: true }).click();
  const preview = page.getByRole("article", { name: "Source preview", exact: true }); await preview.getByText("test: FAILURE", { exact: true }).waitFor();
  await preview.getByRole("button", { name: "Fix failing checks", exact: true }).click(); await page.getByLabel("Task", { exact: true }).waitFor(); await page.getByTitle(repo, { exact: true }).waitFor(); assert.match(await page.getByLabel("Task", { exact: true }).inputValue(), /CI|check/i);
  assert.equal((await api("/api/runs")).length, 1, "choosing an action prepares a draft and does not publish or start without Send");
  await connectionsPage(); await card("GitHub").getByRole("button", { name: "Choose issue or PR", exact: true }).click(); await page.getByRole("button", { name: "Review pull request", exact: true }).click(); await page.getByRole("button", { name: "Load PR preview", exact: true }).click(); await preview.getByRole("button", { name: "Review pull request", exact: true }).click(); assert.match(await page.getByLabel("Task", { exact: true }).inputValue(), /review/i);
});

test("project notification setup starts off, explicitly tests delivery and sends only selected project events", { timeout: 60_000 }, async () => {
  await connectionsPage(); await card("Webhooks").getByRole("button", { name: "Connect", exact: true }).click(); await wizard().getByLabel("Webhook URL", { exact: true }).fill("https://notifications-fixture.invalid/private-path?key=private-fixture-url"); await wizard().getByLabel("Bearer token (optional)").fill(webhookToken); await wizard().getByRole("button", { name: "Continue", exact: true }).click(); await wizard().getByLabel("Connection name", { exact: true }).fill("Project updates"); await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("status").filter({ hasText: "HTTPS destination validated" }).waitFor(); await wizard().getByRole("button", { name: "Connect", exact: true }).click(); await wizard().waitFor({ state: "hidden" });
  webhook = (await api("/api/integration-connections")).connections.find((c: any) => c.name === "Project updates").id;
  await assert.rejects(readFile(requests), /ENOENT/);
  const target = page.getByRole("article", { name: "Notification settings for Project updates", exact: true }); assert.equal(await target.getByLabel("Enable notifications to this destination").isChecked(), false); assert.equal(await target.getByLabel("Integration fixture", { exact: true }).isChecked(), true);
  await target.getByRole("button", { name: "Send test notification", exact: true }).click(); await until(() => api("/api/notifications/deliveries"), items => items.some((d: any) => d.manual && d.state === "delivered"));
  await target.getByLabel("Enable notifications to this destination").check(); await target.getByLabel("Run finished", { exact: true }).check(); await target.getByRole("button", { name: "Save notification settings", exact: true }).click(); await until(() => api("/api/notifications"), items => items.find((t: any) => t.id === webhook)?.settings.enabled);
  const selected = await api("/api/runs", runBody(project)); await until(() => api("/api/notifications/deliveries"), items => items.some((d: any) => d.runId === selected.id && d.state === "delivered"));
  const excluded = await api("/api/runs", runBody(otherProject)); await until(() => api(`/api/runs/${excluded.id}`), r => r.status !== "running");
  const delivered = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.equal(delivered.length, 2); assert.equal(delivered[1].payload.project, project); assert.equal(delivered[1].payload.runId, selected.id);
  assert.doesNotMatch(JSON.stringify(await api("/api/notifications")), /private-fixture-url|private-notification-token|private-path/);
  await audit(); await page.screenshot({ path: join(root, "output/playwright/project-connections.png"), fullPage: true });
});

test("reconnect preserves a working credential after failure, restart restores connections, and disconnect removes bindings", { timeout: 60_000 }, async () => {
  await connectionsPage(); await card("GitLab").getByRole("button", { name: "Reconnect", exact: true }).click(); await wizard().getByLabel("Access token", { exact: true }).fill("invalid-secret-token"); await wizard().getByRole("button", { name: "Continue", exact: true }).click(); await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("alert").filter({ hasText: "HTTP 401" }).waitFor();
  await api(`/api/integration-connections/${connection}/test`, {});
  await wizard().getByRole("button", { name: "Back", exact: true }).click(); await wizard().getByLabel("Access token", { exact: true }).fill(""); await wizard().getByRole("button", { name: "Continue", exact: true }).click(); await wizard().getByRole("button", { name: "Test connection", exact: true }).click(); await wizard().getByRole("status").waitFor(); await wizard().getByRole("button", { name: "Reconnect", exact: true }).click(); await wizard().waitFor({ state: "hidden" });
  await stop(); await start(); await connectionsPage(); await card("GitLab").getByText("Project GitLab", { exact: true }).waitFor(); assert.equal((await api("/api/notifications")).find((t: any) => t.id === webhook).settings.enabled, true);
  await card("GitLab").getByRole("button", { name: "Disconnect", exact: true }).click(); await until(() => api("/api/integration-connections"), data => !data.connections.some((c: any) => c.id === connection));
  const state = await api(`/api/integration-connections/projects/${project}?repository=${encodeURIComponent(repo)}`); assert.ok(!state.bindings.some((b: any) => b.connectionId === connection)); assert.ok(state.connections.some((c: any) => c.id === "admin-source" && c.administratorManaged));
  await api("/api/integrations/admin-source/items?kind=issue");
  assert.deepEqual(errors, []);
});
