// Composer drafts and repository configuration in the browser: a saved draft follows the
// repository's .codeflow/config.json (check, setup, limits, models) and the chosen start branch,
// keeps only what was typed for it and says so in Run details; a deleted start branch isn't
// restored; Edit & run again asks before replacing unsent work, and its pins end with the retry.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-composer-draft-config";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string, project: string;
const errors: string[] = []; let serverLog = "";
function watch(page: Page): void {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (?:400|403|404|409)/.test(message.text())) errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
}
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd: repo, encoding: "utf8" }).trim();
async function commitConfig(config: unknown) {
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify(config));
  git("commit", "-qam", "config");
}
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}

before(async () => {
  directory = await realpath(await mkdtemp(join(process.env.QA_SCRATCH_DIR || tmpdir(), "codeflow-qa-draft-config-")));
  repo = join(directory, "alpha");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Draft fixture\n");
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "echo ALT", setup: "echo ALT-SETUP", limits: { maxSteps: 33 }, prove: false }));
  git("add", "."); git("commit", "-qm", "alt config");
  git("branch", "qa-alt");
  git("branch", "qa-gone");
  await commitConfig({ check: "echo A", setup: "echo SA", limits: { maxMinutes: 15, maxSteps: 12 }, models: { claude: { model: "haiku", effort: "low" } }, prove: false });
  const port = Number(process.env.QA_COMPOSER_PORT) || await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  assert.ok(port !== 4317 && port !== 4318, "Use an isolated QA port");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CODEFLOW_|FAKE_)/.test(key)));
  Object.assign(env, { HOME: directory, SHELL: "/bin/sh", ENV: "/dev/null", HISTFILE: "/dev/null", ZDOTDIR: directory, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: join(directory, "data"), CODEFLOW_TOKEN: token, FAKE_GH_STATE: join(directory, "fake-gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { serverLog += chunk.toString(); });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) break; if (attempt === 149) throw new Error("Server did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  project = (await api("/api/projects", { name: "Alpha", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  watch(page);
  await page.goto(`${base}/?token=${token}`);
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); } if (process.env.QA_ARTIFACT_DIR) { await mkdir(process.env.QA_ARTIFACT_DIR, { recursive: true }); await writeFile(join(process.env.QA_ARTIFACT_DIR, "draft-config-server.log"), serverLog); } assert.doesNotMatch(serverLog, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); assert.deepEqual(errors, []); if (directory) await rm(directory, { recursive: true, force: true }); });

const row = (name: string) => page.locator(".effective-settings tr", { has: page.getByRole("rowheader", { name, exact: true }) });
async function until(read: () => Promise<string>, expected: string | RegExp, what: string) {
  let value = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await read().catch(() => "");
    if (typeof expected === "string" ? value === expected : expected.test(value)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`${what}: ${value}`);
}
/** The project's New run with Run options and Run details open, once the repository's config is in. */
async function newRun(check: string) {
  await page.goto(`${base}/#/project/${project}/new`);
  await page.getByLabel("Task", { exact: true }).waitFor();
  if (!await page.locator("#checkCmd").isVisible()) await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  await until(() => page.locator("#checkCmd").inputValue({ timeout: 1000 }), check, "check command");
  if (await page.locator(".effective-settings").getAttribute("open") === null) await page.locator(".effective-settings > summary").click();
}
async function send(task: string) {
  await page.getByLabel("Task", { exact: true }).fill(task);
  const posted = page.waitForRequest((request: Request) => new URL(request.url()).pathname === "/api/runs" && request.method() === "POST");
  await page.getByRole("button", { name: /^(Send|Start run)$/ }).click();
  const body = (await posted).postDataJSON();
  await page.waitForURL(url => url.hash.startsWith("#/run/"));
  return body;
}

test("a saved draft follows the repository's config, and keeps only what was typed for it", { timeout: 60_000 }, async () => {
  await newRun("echo A");
  assert.equal(await page.locator("#setupCmd").inputValue(), "echo SA");
  assert.match(await page.getByLabel("Run configuration summary").innerText(), /12 calls · 15 minutes/);
  assert.match(await row("Limits").innerText(), /15 minutes · 12 steps\s+\.codeflow\/config\.json/);
  assert.match(await row("agent · claude").innerText(), /haiku · low\s+\.codeflow\/config\.json/);
  const first = await send("Use the configured limits");
  assert.deepEqual([first.loop.check, first.loop.setup, first.loop.maxMinutes, first.loop.maxSteps], ["echo A", "echo SA", 15, 12]);

  await commitConfig({ check: "echo B", setup: "echo SB", prove: false });
  await newRun("echo B");
  assert.equal(await page.locator("#setupCmd").inputValue(), "echo SB", "a run's start doesn't freeze the old config into the draft");
  await page.reload();
  await newRun("echo B");
  assert.equal(await page.locator("#setupCmd").inputValue(), "echo SB");
  assert.match(await row("Limits").innerText(), /720 minutes · 500 steps\s+Application defaults/);

  await page.locator("#setupCmd").fill("echo TYPED");
  await until(() => row("Worktree setup").innerText({ timeout: 1000 }), /echo TYPED\s+This run override/, "typed setup source");
  await commitConfig({ check: "echo C", setup: "echo SC", prove: false });
  await page.reload();
  await newRun("echo C");
  assert.equal(await page.locator("#setupCmd").inputValue(), "echo TYPED", "an override typed for this draft survives a reload");
  assert.match(await row("Worktree setup").innerText(), /This run override/);
  assert.match(await row("Verification command").innerText(), /echo C\s+\.codeflow\/config\.json/);
  assert.match(await page.locator(".config-note").innerText(), /setup “echo SC” \(overridden\)/);
  const second = await send("Use the typed setup");
  assert.deepEqual([second.loop.check, second.loop.setup], ["echo C", "echo TYPED"]);
  await commitConfig({ check: "echo C", prove: false });
  await newRun("echo C");
  assert.equal(await page.locator("#setupCmd").inputValue(), "", "removing setup from the config clears the next draft without a reload");
  assert.match(await row("Worktree setup").innerText(), /None\s+Not configured/);
  assert.deepEqual(errors, []);
});

test("choosing a start branch brings the defaults committed there", { timeout: 45_000 }, async () => {
  await newRun("echo C");
  await page.getByRole("button", { name: /Start from branch/ }).click();
  await page.getByRole("option", { name: /^qa-alt/ }).click();
  await until(() => page.locator("#checkCmd").inputValue({ timeout: 1000 }), "echo ALT", "branch check");
  assert.equal(await page.locator("#setupCmd").inputValue(), "echo ALT-SETUP");
  assert.match(await page.locator(".config-note").innerText(), /config\.json from qa-alt/);
  assert.match(await row("Verification command").innerText(), /\.codeflow\/config\.json at qa-alt/);
  const body = await send("Start from the alternative branch");
  assert.deepEqual([body.baseRef, body.loop.check, body.loop.maxSteps], ["qa-alt", "echo ALT", 33]);
  assert.deepEqual(errors, []);
});

test("a deleted start branch isn't restored with the draft", { timeout: 45_000 }, async () => {
  await newRun("echo ALT");
  await page.getByRole("button", { name: /Start from branch/ }).click();
  await page.getByRole("option", { name: /^qa-gone/ }).click();
  await page.getByLabel("Task", { exact: true }).fill("Start from a branch that goes away");
  await until(() => page.getByLabel("Run configuration summary").innerText({ timeout: 1000 }), /· qa-gone/, "picked branch");
  git("branch", "-D", "qa-gone");
  await page.reload();
  await newRun("echo C");
  await page.getByRole("status").filter({ hasText: "Branch “qa-gone” no longer exists, so this draft starts from the current branch." }).waitFor();
  assert.match(await page.getByRole("button", { name: /Start from branch/ }).innerText(), /Current branch · main/);
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Start from a branch that goes away", "the rest of the draft stays");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await page.getByText("no longer exists").count(), 0);
  assert.deepEqual(errors, []);
});

test("Edit & run again asks before replacing unsent work, and its pins end with the retry", { timeout: 60_000 }, async () => {
  const original = await api("/api/runs", { repo, project, task: "Original run task", pattern: "solo", roles: { agent: ["claude"] }, options: {}, checkpointOnFinish: true, trust: "full", loop: { maxMinutes: 33, maxSteps: 44 } });
  let saved: { status: string; baseRef: string } = original;
  for (let attempt = 0; attempt < 200 && (saved.status === "running" || !saved.status); attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); saved = await api(`/api/runs/${original.id}`); }
  await newRun("echo C");
  await page.getByLabel("Task", { exact: true }).fill("MY UNSENT DRAFT");
  const rerun = async () => {
    await page.goto(`${base}/#/run/${original.id}`);
    await page.getByRole("button", { name: "More run actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
  };
  await rerun();
  const dialog = page.getByRole("dialog", { name: "Replace your unsent draft?" });
  await dialog.getByText(/“MY UNSENT DRAFT” will be replaced/).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(new URL(page.url()).hash, `#/run/${original.id}`, "cancelling stays on the run");
  await newRun("echo C");
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "MY UNSENT DRAFT");

  await rerun();
  await dialog.getByRole("button", { name: "Replace draft", exact: true }).click();
  await page.waitForURL(url => url.hash === `#/project/${project}/new`);
  await until(() => page.getByLabel("Task", { exact: true }).inputValue({ timeout: 1000 }), "Original run task", "restored task");
  const retried = await send("Unrelated new task");
  assert.deepEqual([retried.parentRunId, retried.baseRef, retried.trust, retried.loop.maxMinutes, retried.loop.maxSteps], [original.id, saved.baseRef, "full", 33, 44]);

  git("commit", "--allow-empty", "-qm", "main moves on");
  await page.reload();
  await newRun("echo C");
  assert.match(await page.getByRole("button", { name: /Start from branch/ }).innerText(), /Current branch · main/, "the retry's commit isn't the next draft's base");
  const stored = await page.evaluate(() => ({ baseRef: localStorage.getItem("baseRef"), trust: localStorage.getItem("trust"), limits: localStorage.getItem("limits") }));
  assert.deepEqual(stored, { baseRef: "", trust: null, limits: null }, "nothing from the retry is remembered for later drafts");
  const later = await send("Later unrelated run");
  assert.deepEqual([later.parentRunId, later.baseRef, later.trust, later.loop.maxMinutes, later.loop.maxSteps], [undefined, "", "standard", 720, 500]);
  assert.deepEqual(errors, []);
});

test("context added to an otherwise untouched retry draft is protected before another retry replaces it", { timeout: 60_000 }, async () => {
  await writeFile(join(repo, "notes.md"), "Unsent context selection\n"); git("add", "notes.md"); git("commit", "-qm", "extra context");
  const original = await api("/api/runs", { repo, project, task: "Retry with selected context", pattern: "solo", checkpointOnFinish: true, roles: { agent: ["claude"] }, options: {}, trust: "standard", context: { paths: [{ path: "README.md", type: "file" }] }, loop: { check: "true", maxMinutes: 2, maxSteps: 4 } });
  for (let n = 0; n < 200; n++) { if ((await api(`/api/runs/${original.id}`)).status !== "running") break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const reopenRetry = async () => {
    await page.goto(`${base}/#/run/${original.id}`); await page.getByRole("button", { name: "More run actions", exact: true }).click(); await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
  };
  await reopenRetry(); await page.waitForURL(url => url.hash === `#/project/${project}/new`);
  await page.locator(".taskbox").getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Add notes.md to the task", exact: true }).click();
  await page.locator(".chip-ctx").getByText("notes.md", { exact: true }).waitFor();
  await reopenRetry();
  const dialog = page.getByRole("dialog", { name: "Replace your unsent draft?" }); await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`${base}/#/project/${project}/new`);
  await page.locator(".chip-ctx").getByText("notes.md", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});


test("project defaults refresh saved drafts for both an inactive and the current project", { timeout: 60_000 }, async () => {
  const previous = page, context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage(); watch(page);
  try {
    await page.goto(`${base}/?token=${token}`);
    await newRun("echo C");
    await page.getByLabel("Task", { exact: true }).fill("Keep this unsent text while defaults change");
    const otherRepo = join(directory, "other-repo"); execFileSync("git", ["clone", "-q", repo, otherRepo], { cwd: directory });
    const other = (await api("/api/projects", { name: "Other composer", repos: [otherRepo] })).id;
    await page.goto(`${base}/#/project/${other}/new`); await page.getByLabel("Task", { exact: true }).waitFor();
    const defaults = async (check: string, setup: string, verification: string) => {
      await page.goto(`${base}/#/settings/projects`); await page.locator("#settings-project").selectOption(project);
      await page.getByLabel("Default check command", { exact: true }).fill(check);
      await page.getByLabel("Worktree setup command", { exact: true }).fill(setup);
      await page.getByLabel("Default verification profile", { exact: true }).selectOption(verification);
      await page.getByRole("button", { name: "Save project defaults", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Project defaults saved." }).waitFor();
    };
    await defaults("echo PROJECT", "echo PROJECT-SETUP", "lightweight");
    await newRun("echo PROJECT");
    assert.equal(await page.locator("#setupCmd").inputValue(), "echo PROJECT-SETUP");
    assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "lightweight");
    assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Keep this unsent text while defaults change");
    await defaults("echo CURRENT", "", "standard");
    await newRun("echo CURRENT");
    assert.equal(await page.locator("#setupCmd").inputValue(), "");
    assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "standard");
    await page.reload(); await newRun("echo CURRENT");
    assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "standard");
    assert.match(await row("Verification command").innerText(), /Project Settings/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); page = previous; }
});
