import { tmpdir } from "node:os";
import { reserveQaPorts } from "../qa-port-block.js";
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_INTEGRATION_CONNECTIONS_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync(join(realpathSync(tmpdir()), "cf-qa-connections-ui-"));
const home = join(scratch, "data"), repo = join(scratch, "repo"), gh = join(scratch, "gh.json"), fixtureState = join(scratch, "transport.json"), shots = join(root, "output/playwright/qa-integration-connections");
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "connections50-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
let server: ChildProcess, browser: Browser, page: Page, project: string, other: string, connection: string, github: string;
let sourceConfig: string, notificationConfig = "[]";
const errors: string[] = [], expected: string[] = [], logs: string[] = [], expectedUrls = new Set<string>();
const shutdowns: { start: number; end: number }[] = [], restartDiagnostics: unknown[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") { const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 30000) { const end = Date.now() + timeout; for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await pause(100); } }
async function start() {
  await qaPorts.release();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "./test/qa-integration-connections-transport.mjs", "--import", "tsx", "src/server.ts"], { cwd: root, env: { ...inherited, HOME: join(scratch, "os-home"), SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_GH_STATE: gh, FAKE_CONNECTIONS_STATE: fixtureState, SOURCE_IMPORT_KEY: "fixture-source-secret", QA_USERNAME: "fixture@example.test", CODEFLOW_INTEGRATIONS_JSON: sourceConfig, CODEFLOW_NOTIFICATIONS_JSON: notificationConfig, FAKE_NO_APP_SERVER: "1", CODEFLOW_CODEX_TRANSPORT: "exec" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", data => logs.push(String(data))); server.stderr?.on("data", data => logs.push(String(data)));
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; const window = { start: Date.now(), end: Infinity }; shutdowns.push(window); const ended = new Promise<void>(resolve => server.once("exit", () => resolve())); const timeout = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await ended; window.end = Date.now(); clearTimeout(timeout); }
const card = (name: string) => page.getByRole("article", { name: `${name} connections`, exact: true });
async function open(projectId = project) { await page.goto(`${base}/?token=${token}#/project/${projectId}/connections`); await card("GitLab").getByText("Managed GitLab", { exact: true }).waitFor(); }
async function actions(provider = "GitLab") { await card(provider).getByRole("button", { name: provider === "Linear" || provider === "Jira" ? "Choose issue" : "Choose issue or PR", exact: true }).click(); return page.getByRole("region", { name: "Connected project actions", exact: true }); }
before(async () => {
  mkdirSync(shots, { recursive: true }); mkdirSync(repo); mkdirSync(join(scratch, "os-home")); writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  git("init", "-qb", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); writeFileSync(join(repo, "sum.mjs"), "export function sum(a,b) { return a-b; }\n"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), '{"check":"true","prove":false}'); git("add", "."); git("commit", "-qm", "fixture"); git("branch", "feature"); git("clone", "--bare", "-q", repo, join(scratch, "origin.git")); git("remote", "add", "origin", join(scratch, "origin.git")); git("fetch", "origin");
  writeFileSync(gh, JSON.stringify({ issues: [{ number: 3, title: "GitHub issue", body: "Fixture", url: "https://github.com/fixture/repo/issues/3" }], prs: { 7: { number: 7, title: "GitHub PR", body: "Fixture", url: "https://github.com/fixture/repo/pull/7", headRefName: "feature", baseRefName: "main", state: "OPEN", isCrossRepository: false } }, comments: [], reviews: [] })); writeFileSync(fixtureState, JSON.stringify({ count: 1 }));
  sourceConfig = JSON.stringify([{ id: "linear-fixture", name: "Fixture Linear", provider: "linear", project: "ENG", credentialEnv: "SOURCE_IMPORT_KEY", baseUrl: "https://linear-fixture.invalid/" }, { id: "jira-fixture", name: "Fixture Jira", provider: "jira", project: "APP", credentialEnv: "SOURCE_IMPORT_KEY", usernameEnv: "QA_USERNAME", baseUrl: "https://jira-fixture.invalid/" }, { id: "missing-private-id", name: "Missing Jira credentials", provider: "jira", project: "APP", credentialEnv: "QA_MISSING_TOKEN", usernameEnv: "QA_USERNAME", baseUrl: "https://jira-fixture.invalid/" }]);
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(scratch, "build-home") } }); await start(); project = (await api("/api/projects", { name: "Alpha fixture", repos: [repo] })).id; other = (await api("/api/projects", { name: "Beta fixture", repos: [repo] })).id;
  const checked = await api("/api/integration-connections/test", { provider: "gitlab", name: "Managed GitLab", scope: "org/repo", credential: "fixture-source-secret", baseUrl: "https://source-fixture.invalid/api/v4/" }); connection = (await api("/api/integration-connections/connect", { testId: checked.testId, projectId: project, repository: repo })).id;
  for (const id of ["linear-fixture", "jira-fixture"]) await api(`/api/integration-connections/projects/${project}`, { connectionId: id, repository: repo }, "PUT");
  const checkedGh = await api("/api/integration-connections/test", { provider: "github", name: "Fixture GitHub", scope: "fixture/repo", projectId: project, repository: repo }); github = (await api("/api/integration-connections/connect", { testId: checkedGh.testId, projectId: project, repository: repo })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.setDefaultTimeout(15000); await page.addInitScript(() => { if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem("sideOpen", "0"); });
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") { const value = `${message.text()} [${message.location().url}]`; (expectedUrls.has(message.location().url) && /status of 400|net::ERR_FAILED/.test(message.text()) ? expected : errors).push(value); } });
});
afterEach(async t => { if ((t as { error?: unknown }).error) { await page.screenshot({ animations: "disabled", path: join(shots, `failed-${t.name.slice(0, 35).replace(/[^a-z0-9]/gi, "-")}.png`), fullPage: true }); writeFileSync(join(shots, "failed-page.txt"), await page.locator("body").innerText()); } });
after(async () => { await browser?.close(); await stop(); writeFileSync(join(shots, "browser.json"), JSON.stringify({ errors, expected, restartDiagnostics }, null, 2)); writeFileSync(join(shots, "server.log"), logs.join("")); if (existsSync(join(home, "server.log"))) writeFileSync(join(shots, "application.log"), readFileSync(join(home, "server.log"))); rmSync(scratch, { recursive: true, force: true }); });

test("disconnect previews every project and Cancel preserves the encrypted connection", async () => {
  await api(`/api/integration-connections/projects/${other}`, { connectionId: connection, repository: repo }, "PUT"); await open(other);
  const before = readFileSync(join(home, "integration-secrets/connections.enc"));
  await card("GitLab").getByRole("button", { name: "Manage Managed GitLab connection" }).click(); await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect Managed GitLab?" }); await dialog.waitFor(); assert.match(await dialog.innerText(), /Alpha fixture/); assert.match(await dialog.innerText(), /Beta fixture/); assert.match(await dialog.innerText(), /credential/); await page.screenshot({ animations: "disabled", path: join(shots, "disconnect-impact.png"), fullPage: true }); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); assert.deepEqual(readFileSync(join(home, "integration-secrets/connections.enc")), before);
  await page.screenshot({ animations: "disabled", path: join(shots, "cancelled-disconnect.png"), fullPage: true });
});
test("connection test errors stay on their card and Retry repeats the same test", async () => {
  await page.goto(`${base}/?token=${token}#/settings/integrations`); const row = card("Jira").locator(".integration-connection").filter({ hasText: "Missing Jira credentials" }); await row.scrollIntoViewIfNeeded(); expectedUrls.add(base + "/api/integration-connections/missing-private-id/test"); let posts = 0; page.on("request", r => { if (r.method() === "POST" && r.url() === base + "/api/integration-connections/missing-private-id/test") posts++; });
  await row.getByRole("button", { name: "Manage Missing Jira credentials connection" }).click(); await page.getByRole("menuitem", { name: "Test connection", exact: true }).click(); await row.getByRole("alert").waitFor(); assert.doesNotMatch(await row.getByRole("alert").innerText(), /missing-private-id/); assert.match(await row.getByRole("alert").innerText(), /Missing Jira credentials/); const box = await row.getByRole("alert").boundingBox(); assert.ok(box && box.y >= 0 && box.y < 768); await row.getByRole("button", { name: "Retry", exact: true }).click(); await until(async () => posts, n => n === 2); await until(() => row.getByRole("button", { name: "Retry", exact: true }).isEnabled(), Boolean); await row.getByRole("alert").waitFor();
  await page.screenshot({ animations: "disabled", path: join(shots, "card-test-failure.png"), fullPage: true });
});
test("external issue drafts replace a previous council workflow and criteria for every provider", async () => {
  for (const provider of ["GitLab", "Linear", "Jira"]) {
    await open(); let work = await actions("GitHub"); await work.getByRole("button", { name: "Review pull request", exact: true }).click(); await work.getByRole("button", { name: "Load PR preview", exact: true }).click(); await work.getByRole("article", { name: "Source preview" }).getByRole("button", { name: "Review pull request", exact: true }).click(); await page.getByLabel("Task", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); await page.locator(".acceptance-editor > summary").click(); await page.getByLabel("One requirement per line", { exact: true }).fill("Stale PR criterion");
    await open(); work = await actions(provider); await work.getByRole("button", { name: "Choose issue", exact: true }).click(); await work.getByRole("article", { name: "Source preview" }).getByRole("button", { name: "Start task from issue", exact: true }).click(); await page.getByLabel("Task", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); const advanced = page.locator("details.advanced-controls"); if (!await advanced.evaluate(el => (el as HTMLDetailsElement).open)) await advanced.locator(":scope > summary").click(); assert.equal(await page.getByLabel("Workflow", { exact: true }).inputValue(), "fix-review"); assert.equal(await page.getByLabel("One requirement per line", { exact: true }).inputValue(), "");
  }
});
test("an offline connection test keeps its failure beside the account and recovers on Retry", async () => {
  await open(); const url = base + `/api/integration-connections/${connection}/test`; expectedUrls.add(url);
  await page.route(url, route => route.abort("failed")); const row = card("GitLab").locator(".integration-connection").filter({ hasText: "Managed GitLab" });
  await row.getByRole("button", { name: "Manage Managed GitLab connection" }).click(); await page.getByRole("menuitem", { name: "Test connection", exact: true }).click(); await row.getByRole("alert").waitFor(); await page.unroute(url);
  const response = page.waitForResponse(r => r.url() === url && r.request().method() === "POST"); await row.getByRole("button", { name: "Retry", exact: true }).click(); assert.equal((await response).status(), 200); await row.getByRole("alert").waitFor({ state: "hidden" }); assert.equal((await api("/api/integration-connections")).connections.find((value: any) => value.id === connection).name, "Managed GitLab");
});
test("a slow issue list cannot block switching to PRs or overwrite the newer listing", async () => {
  await open(); let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let continued!: () => void; const finished = new Promise<void>(resolve => continued = resolve); let held = false;
  await page.route("**/items?**", async route => { if (route.request().url().includes("kind=issue") && !held) { held = true; await gate; await route.continue(); continued(); return; } await route.continue(); });
  const work = await actions(); await until(async () => held, Boolean); await work.getByRole("button", { name: "Review pull request", exact: true }).click(); await work.getByRole("button", { name: "Load PR preview", exact: true }).waitFor(); release(); await finished; await page.unroute("**/items?**"); await pause(250); assert.equal(await work.getByRole("button", { name: "Review pull request", exact: true }).getAttribute("aria-pressed"), "true"); assert.equal(await work.getByRole("button", { name: "Choose issue", exact: true }).count(), 0);
});
test("the provider cap is visible at 1000 issues and resets after refresh", async () => {
  writeFileSync(fixtureState, JSON.stringify({ count: 1040 })); await open(); const work = await actions(); await until(() => work.locator(".connection-item").count(), n => n === 50);
  for (let n = 2; n <= 20; n++) { await work.getByRole("button", { name: "Load more", exact: true }).click(); await until(() => work.locator(".connection-item").count(), value => value === n * 50); }
  assert.equal(await work.getByRole("button", { name: "Load more", exact: true }).count(), 0); await work.getByRole("status").filter({ hasText: "Showing 1,000 issues" }).waitFor(); await page.screenshot({ animations: "disabled", path: join(shots, "truncated-issues.png"), fullPage: false }); writeFileSync(fixtureState, JSON.stringify({ count: 1 })); await work.getByRole("button", { name: "Refresh list", exact: true }).click(); await until(() => work.locator(".connection-item").count(), n => n === 1); assert.equal(await work.getByText(/listing reached its limit/).count(), 0);
});
test("a late issue import cannot replace the preview after switching to pull requests", async () => {
  await open(); const work = await actions(), url = base + `/api/integration-connections/projects/${project}/${connection}/import`;
  let release!: () => void, continued!: () => void; const gate = new Promise<void>(resolve => release = resolve), finished = new Promise<void>(resolve => continued = resolve);
  await page.route(url, async route => { await gate; await route.continue(); continued(); });
  const requested = page.waitForRequest(url); await work.getByRole("button", { name: "Choose issue", exact: true }).click(); await requested;
  await work.getByRole("button", { name: "Review pull request", exact: true }).click(); await work.getByRole("button", { name: "Load PR preview", exact: true }).waitFor();
  const response = page.waitForResponse(url); release(); await finished; await response; await page.unroute(url); await pause(100);
  assert.equal(await work.getByRole("article", { name: "Source preview" }).count(), 0); assert.equal(await work.getByRole("button", { name: "Review pull request", exact: true }).getAttribute("aria-pressed"), "true");
});
test("completed GitHub work opens the selected branch with PR controls without publishing", async () => {
  const created = await api("/api/runs", { project, repo, pattern: "fix-review", task: "Fix the fixture sum", roles: { builder: ["claude"], reviewer: ["codex"] }, loop: { check: "true", prove: false } }); const run = await until(() => api(`/api/runs/${created.id}`), value => value.status !== "running", 60000); assert.equal(run.status, "done", run.error); const artifact = run.artifacts[0]; assert.ok(artifact);
  const before = readFileSync(gh, "utf8"), refs = git("ls-remote", "origin"); let posts = 0; page.on("request", r => { if (r.method() === "POST" && /\/pr$/.test(r.url())) posts++; }); await open(); const work = await actions("GitHub"); await work.getByRole("button", { name: "Create pull request from completed work", exact: true }).click(); await work.getByLabel("Completed result").selectOption(`${run.id}:${artifact.branch}`); await work.getByRole("button", { name: "Review result and create PR", exact: true }).click(); await page.getByRole("button", { name: "Push & open PR", exact: true }).waitFor(); await until(() => page.getByRole("button", { name: "Push & open PR", exact: true }).isEnabled(), Boolean); assert.equal(await page.getByLabel("Pull request into", { exact: true }).inputValue(), "main"); assert.ok(decodeURIComponent(page.url()).includes(`#/review/${run.id}/${artifact.branch}`)); assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Create pull request"); assert.equal(posts, 0); assert.equal(readFileSync(gh, "utf8"), before); assert.equal(git("ls-remote", "origin"), refs); await page.screenshot({ animations: "disabled", path: join(shots, "review-pr-handoff.png"), fullPage: false }); await page.reload(); assert.equal(await page.locator("details.review-delivery").evaluate(el => (el as HTMLDetailsElement).open), false);
});
test("Jira validation and issue-only actions use visible labels and Settings has one heading", async () => {
  await open(); for (const provider of ["Linear", "Jira"]) { await card(provider).getByRole("button", { name: "Choose issue", exact: true }).waitFor(); assert.equal(await card(provider).getByRole("button", { name: "Choose issue or PR", exact: true }).count(), 0); }
  await card("Jira").getByRole("button", { name: "Connect another", exact: true }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Username or email", { exact: true }).fill("fixture@example.test"); await dialog.getByLabel("Access token", { exact: true }).fill("fixture"); await dialog.getByRole("button", { name: "Continue", exact: true }).click(); await dialog.getByLabel("Jira project key", { exact: true }).fill("APP"); expectedUrls.add(base + "/api/integration-connections/test"); await dialog.getByRole("button", { name: "Test connection", exact: true }).click(); await dialog.getByRole("alert").filter({ hasText: "Jira site URL" }).waitFor(); await page.keyboard.press("Escape"); await page.goto(base + "/#/settings/integrations"); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor(); assert.equal(await page.getByRole("heading", { name: "Integrations", exact: true }).count(), 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.setViewportSize({ width: 1366, height: 768 });
});
test("invalid administrator JSON does not hide saved connections across restart", async () => {
  const goodSources = sourceConfig;
  for (const kind of ["source", "notification"] as const) {
    await page.goto("about:blank"); await stop(); sourceConfig = kind === "source" ? "[{bad" : goodSources; notificationConfig = kind === "notification" ? "[{bad" : "[]"; await start(); await open(); await page.getByRole("status").filter({ hasText: kind === "source" ? "Administrator integration configuration" : "Administrator notification configuration" }).waitFor(); await api(`/api/integration-connections/${connection}/test`, {}); assert.ok((await api("/api/integration-connections")).connections.some((c: any) => c.id === github));
  }
  await page.goto("about:blank"); await stop(); sourceConfig = goodSources; notificationConfig = "[]"; await start(); await open(); assert.equal(await page.getByText(/Administrator .* configuration .*invalid/).count(), 0);
});
test("confirmed disconnect removes both bindings and leaves unrelated services", async () => {
  await open(other); await card("GitLab").getByRole("button", { name: "Manage Managed GitLab connection" }).click(); await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click(); await page.getByRole("dialog", { name: "Disconnect Managed GitLab?" }).getByRole("button", { name: "Disconnect", exact: true }).click(); await until(() => api("/api/integration-connections"), data => !data.connections.some((c: any) => c.id === connection));
  for (const id of [project, other]) assert.ok(!(await api(`/api/integration-connections/projects/${id}?repository=${encodeURIComponent(repo)}`)).bindings.some((b: any) => b.connectionId === connection)); assert.ok((await api("/api/integration-connections")).connections.some((c: any) => c.id === github)); await api("/api/integrations/linear-fixture/items?kind=issue");
});
test("browser and process logs contain only explicit injected failures", () => {
  assert.deepEqual(errors, []); assert.doesNotMatch(logs.join(""), /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/);
  const entries = readFileSync(join(home, "server.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const badConfig = entries.filter(entry => entry.level === "error" && entry.message === "Administrator external sources disabled: invalid integration configuration" && entry.error === "Integration configuration is not valid JSON");
  assert.equal(badConfig.length, 1);
  const restart = entries.filter(entry => entry.level === "error" && ["GET /api/health failed", "GET /api/workspace-projects failed"].includes(entry.message) && entry.error === "The backend is stopping" && shutdowns.some(window => Date.parse(entry.at) >= window.start && Date.parse(entry.at) <= window.end));
  restartDiagnostics.push(...restart);
  assert.deepEqual(entries.filter(entry => entry.level === "error" && !badConfig.includes(entry) && !restart.includes(entry)), []);
});
