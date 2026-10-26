import { reserveQaPorts } from "../qa-port-block.js";
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_FINAL_INTEGRATION_DRAFT_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync("/private/tmp/cf-qa-draft-readiness-");
const home = join(scratch, "data"), repo = join(scratch, "repo"), gh = join(scratch, "gh.json"), fixtureState = join(scratch, "transport.json"), shots = join(root, "output/playwright/qa-final-integration-draft-readiness");
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "draft-readiness-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
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
  writeFileSync(gh, JSON.stringify({ issues: [{ number: 3, title: "GitHub issue", body: "Fixture", url: "https://github.com/fixture/repo/issues/3" }], prs: { 7: { number: 7, title: "GitHub PR", body: "Fixture", url: "https://github.com/fixture/repo/pull/7", headRefName: "feature", baseRefName: "main", state: "OPEN", isCrossRepository: false, failOn: "all" } }, comments: [], reviews: [] })); writeFileSync(fixtureState, JSON.stringify({ count: 1 }));
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

async function savedDraft() {
  return page.evaluate(id => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open("codeflow-project-drafts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction("drafts", "readonly");
      const read = transaction.objectStore("drafts").get(`project-draft-v1:${id}`);
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
      transaction.oncomplete = () => database.close();
    };
  }), project);
}

for (const mode of ["GitLab", "Linear", "Jira", "PR", "CI"] as const) test(`${mode} handoff waits for draft initialization and applies its selection once without stale restoration`, { timeout: 45000 }, async () => {
  const marker = `Saved draft before ${mode}`;
  await page.goto(`${base}/?token=${token}#/project/${project}/new`);
  await page.getByLabel("Task", { exact: true }).fill(marker);
  await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  const acceptance = page.locator(".acceptance-editor");
  if (!await acceptance.evaluate(el => (el as HTMLDetailsElement).open)) await acceptance.locator(":scope > summary").click();
  await page.getByLabel("One requirement per line", { exact: true }).fill("Previous draft criterion");
  const before = await until(savedDraft, value => value?.task === marker && value.acceptance?.[0] === "Previous draft criterion");

  let release!: () => void, held = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  // boot awaits refreshRuns before initializeProjectDrafts, while project services can render.
  // Hold the actual dependency rather than slowing every request or relying on timing luck.
  const match = `${base}/api/runs?*`;
  await page.route(match, async route => { held++; await gate; await route.continue(); });
  let preview: ReturnType<Page["getByRole"]>;
  const action = mode === "PR" ? "Review pull request" : mode === "CI" ? "Fix failing checks" : "Start task from issue";
  try {
    await open(); await until(async () => held, value => value > 0);
    const work = await actions(mode === "PR" || mode === "CI" ? "GitHub" : mode);
    if (mode === "PR" || mode === "CI") {
      await work.getByRole("button", { name: "Review pull request", exact: true }).click();
      await work.getByRole("button", { name: "Load PR preview", exact: true }).click();
    } else await work.getByRole("button", { name: "Choose issue", exact: true }).click();
    preview = work.getByRole("article", { name: "Source preview" }); await preview.waitFor();
    const handoff = preview.getByRole("button", { name: action, exact: true });
    assert.equal(await handoff.isDisabled(), true, "draft handoff must be disabled until initialization finishes");
    if (mode === "PR" || mode === "CI") for (const name of ["Review pull request", "Fix failing checks"]) assert.equal(await preview.getByRole("button", { name, exact: true }).isDisabled(), true);
    const restoring = preview.getByRole("status").filter({ hasText: "Restoring your project draft…" });
    await restoring.scrollIntoViewIfNeeded();
    const restoringBox = await restoring.boundingBox(); assert.ok(restoringBox && restoringBox.y >= 0 && restoringBox.y + restoringBox.height <= 768);
    await handoff.evaluate((button: HTMLButtonElement) => button.click());
    assert.ok(page.url().includes(`/project/${project}/connections`));
    assert.deepEqual(await savedDraft(), before, "the disabled handoff cannot replace the stored draft");
    await page.screenshot({ animations: "disabled", path: join(shots, `${mode}-restoring.png`), fullPage: true });
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  const handoff = preview!.getByRole("button", { name: action, exact: true });
  await until(() => handoff.isEnabled(), Boolean);
  await handoff.click();
  await page.getByLabel("Task", { exact: true }).waitFor();
  const currentTask = await page.getByLabel("Task", { exact: true }).inputValue(); assert.notEqual(currentTask, marker);
  const expectedPattern = mode === "PR" ? "council" : "fix-review";
  const saved = await until(savedDraft, value => value?.task === currentTask && value.pattern === expectedPattern && value.acceptance?.length === 0);
  if (mode === "PR" || mode === "CI") { assert.equal(saved.source.number, 7); assert.equal(saved.source.ciLogs, mode === "CI"); assert.equal(saved.externalSource, null); }
  else { assert.equal(saved.externalSource.provider, mode.toLowerCase()); assert.equal(saved.source, null); }
  await page.reload(); await page.getByLabel("Task", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), currentTask, "late restore/reload must not overwrite the selected issue or PR");
  const restored = await savedDraft(); assert.equal(restored.pattern, expectedPattern); assert.deepEqual(restored.acceptance, []);
  assert.equal(await page.getByRole("alert").filter({ hasText: "draft is still loading" }).count(), 0);
});

test("readiness replay has no unexpected browser or server failures", () => {
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs.join(""), /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/);
  const entries = (existsSync(join(home, "server.log")) ? readFileSync(join(home, "server.log"), "utf8") : "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(entries.filter(entry => entry.level === "error"), []);
});
