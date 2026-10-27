import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

// Templates, saved workflows and a project's remembered team prefill one draft; Settings keeps the
// saved provider models and default workflow. Template dialogs describe what applying restores.
const root = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "qa-composer-presets-global";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const SAVED_MODELS = { claude: { effort: "high" }, codex: { effort: "low" } };
let server: ChildProcess, browser: Browser, base: string, directory: string, repoA: string, repoB: string;
let projectA: string, projectB: string, projectC: string;
const errors: string[] = []; let serverLog = "";
function watch(page: Page): void {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (?:400|403|404|409)/.test(message.text())) errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
}
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
async function finished(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) { const run = await api(`/api/runs/${id}`); if (!["queued", "running"].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Run ${id} did not finish`);
}
before(async () => {
  directory = await realpath(await mkdtemp(join(process.env.QA_SCRATCH_DIR || tmpdir(), "codeflow-qa-presets-")));
  repoA = join(directory, "alpha"); repoB = join(directory, "beta");
  for (const repository of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "main", repository]);
    await writeFile(join(repository, "README.md"), "Presets fixture\n");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
    await mkdir(join(repository, ".codeflow")); await writeFile(join(repository, ".codeflow/config.json"), JSON.stringify({ check: "true", setup: "true", prove: false }));
    execFileSync("git", ["add", "."], { cwd: repository }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repository });
  }
  const port = Number(process.env.QA_COMPOSER_PORT) || await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  assert.ok(port !== 4317 && port !== 4318, "Use an isolated QA port");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CODEFLOW_|FAKE_)/.test(key)));
  Object.assign(env, { HOME: directory, SHELL: "/bin/sh", ENV: "/dev/null", HISTFILE: "/dev/null", ZDOTDIR: directory, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: join(directory, "data"), CODEFLOW_TOKEN: TOKEN, FAKE_GH_STATE: join(directory, "fake-gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { serverLog += chunk.toString(); });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) break; if (attempt === 149) throw new Error("Server did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  projectA = (await api("/api/projects", { name: "Remembers a team", repos: [repoA] })).id;
  projectB = (await api("/api/projects", { name: "Templates", repos: [repoB] })).id;
  projectC = (await api("/api/projects", { name: "Plain project", repos: [repoB] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); } if (process.env.QA_ARTIFACT_DIR) { await mkdir(process.env.QA_ARTIFACT_DIR, { recursive: true }); await writeFile(join(process.env.QA_ARTIFACT_DIR, "presets-global-server.log"), serverLog); } assert.doesNotMatch(serverLog, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); assert.deepEqual(errors, []); if (directory) await rm(directory, { recursive: true, force: true }); });

/** A fresh browser whose Settings hold SAVED_MODELS and the Agent workflow. */
async function freshPage(seed: Record<string, string> = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ models, seed }) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("agentSettings", JSON.stringify(models)); localStorage.setItem("pattern", "solo");
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
  }, { models: SAVED_MODELS, seed });
  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/?token=${TOKEN}`);
  return { context, page };
}
async function newRun(page: Page, project: string) {
  await page.goto(`${base}/#/project/${project}/new`);
  await page.getByLabel("Task", { exact: true }).waitFor({ timeout: 15000 });
  await page.locator(".composer-summary").getByText("Restoring", { exact: false }).waitFor({ state: "detached" }).catch(() => {});
}
async function openAdvanced(page: Page) {
  const options = page.locator(".composer-options");
  if (await options.getAttribute("open") === null) await options.locator(":scope > summary").click();
  const advanced = page.locator(".advanced-controls");
  if (await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click();
}
async function settingsModels(page: Page) {
  await page.goto(`${base}/#/settings/agents`);
  await page.getByLabel("Claude Code effort", { exact: true }).waitFor();
  return { claude: await page.getByLabel("Claude Code effort", { exact: true }).inputValue(), codex: await page.getByLabel("Codex effort", { exact: true }).inputValue(), stored: await page.evaluate(() => JSON.parse(localStorage.getItem("agentSettings") ?? "null")) };
}
async function useTemplate(page: Page, label: string, values: Record<string, string> = {}) {
  await page.locator(".composer").getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Use template…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Template library", exact: true });
  await dialog.getByLabel("Library", { exact: true }).selectOption("personal");
  await dialog.getByLabel("Template", { exact: true }).selectOption({ label });
  for (const [name, value] of Object.entries(values)) await dialog.getByLabel(name, { exact: true }).fill(value);
  const help = await dialog.locator("p.help", { hasText: "Review the settings" }).innerText();
  await dialog.getByRole("button", { name: "Use template", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  return help;
}
async function modelSource(page: Page, row: string) {
  const details = page.locator("details.effective-settings");
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
  return details.locator("tbody tr", { has: page.locator("th", { hasText: row }) }).first().innerText();
}

test("templates and saved workflows set this draft's models without changing Settings > Agents & models", { timeout: 90_000 }, async () => {
  const config = (agentSettings: object) => ({ pattern: "solo", roles: { agent: ["claude"] }, options: {}, agentSettings, roleSettings: {}, trust: "full", limits: { maxMinutes: 9, maxSteps: 4 }, approvePlan: false, toolApprovals: true, check: "true", setup: "" });
  const library = { schemaVersion: 1, presets: [{ id: "workflow", name: "Saved workflow", revision: 1, updatedAt: 1, config: config({}), history: [] }], templates: [
    { id: "plain", name: "Saved with defaults", pattern: "solo", task: "Review {{component}}", criteria: [], config: config({}), runOptions: { verification: "", container: { enabled: true, image: "qa-image:1", authVolume: "" } } },
    { id: "medium", name: "Saved with medium", pattern: "solo", task: "Inspect {{component}}", criteria: [], config: config({ claude: { effort: "medium" } }) },
  ] };
  const { context, page } = await freshPage({ composerLibrary: JSON.stringify(library) });
  try {
    await newRun(page, projectB);
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); await openAdvanced(page);
    await page.getByLabel("Verification gates", { exact: true }).selectOption("lightweight");
    await page.locator("details.agent-isolation > summary").click();
    const permissions = await page.locator(".taskbox").getByRole("button", { name: /^Permissions:/ }).innerText();
    const budget = [await page.locator("#maxMinutes").inputValue(), await page.locator("#maxSteps").inputValue()];
    const help = await useTemplate(page, "Saved with defaults", { component: "README" });
    assert.doesNotMatch(help, /permissions \((safe|standard|trusted|full)\)/, "the dialog doesn't promise to restore the template's permissions");
    assert.match(help, /Permissions, approvals, limits and agent isolation stay as set in this draft/);
    assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Review README");
    assert.equal(await page.locator(".taskbox").getByRole("button", { name: /^Permissions:/ }).innerText(), permissions, "the draft keeps its permissions");
    assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "", "a template saved with the single check restores it");
    assert.equal(await page.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image" }).isChecked(), false, "the draft keeps its isolation");
    assert.deepEqual([await page.locator("#maxMinutes").inputValue(), await page.locator("#maxSteps").inputValue()], budget, "the template does not apply its saved budget");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("agentSettings")!)), SAVED_MODELS, "a template saved with Default models doesn't erase the provider defaults");

    await useTemplate(page, "Saved with medium", { component: "the broker" });
    assert.match(await modelSource(page, "agent · claude"), /medium[\s\S]*Template Saved with medium/, "the template's model applies to this draft");
    const started = page.waitForRequest(request => new URL(request.url()).pathname === "/api/runs" && request.method() === "POST");
    await page.locator(".task-start").click();
    assert.equal((await started).postDataJSON().agentSettings.claude.effort, "medium");
    assert.deepEqual(await settingsModels(page), { claude: "high", codex: "low", stored: SAVED_MODELS });
    await page.reload();
    assert.deepEqual(await settingsModels(page), { claude: "high", codex: "low", stored: SAVED_MODELS }, "provider defaults stay intact after a full reload");

    await page.goto(`${base}/#/settings/projects`);
    await page.waitForLoadState("networkidle");
    await page.locator("#settings-project").selectOption(projectB);
    await page.getByLabel("Library scope").selectOption("personal");
    await page.locator(".composer-library > summary").click();
    await page.getByLabel("Saved workflow", { exact: true }).selectOption({ label: "Saved workflow · r1" });
    assert.match(await page.locator(".composer-library").innerText(), /Saved with full permissions; applying keeps the draft's own/);
    await page.getByRole("button", { name: "Apply workflow", exact: true }).click();
    assert.deepEqual(await settingsModels(page), { claude: "high", codex: "low", stored: SAVED_MODELS });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a project's remembered team prefills only its own draft and Settings says which projects remember one", { timeout: 90_000 }, async () => {
  const run = await api("/api/runs", { repo: repoA, project: projectA, task: "Remember this team", pattern: "pipeline", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["codex"] }, options: {}, trust: "standard", approvals: { plan: false }, agentSettings: { claude: { effort: "low" } }, remember: true, loop: { check: "true", maxSteps: 10, maxMinutes: 5 } });
  await finished(run.id);
  let remembered: any;
  for (let attempt = 0; attempt < 50 && !remembered; attempt++) { remembered = (await api("/api/projects")).find((project: any) => project.id === projectA)?.defaults; if (!remembered) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(remembered?.pattern, "pipeline");
  const { context, page } = await freshPage();
  try {
    await newRun(page, projectA);
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); await openAdvanced(page);
    assert.equal(await page.locator("#workflow-select").inputValue(), "pipeline", "the project's draft starts from its remembered workflow");
    assert.match(await modelSource(page, "Workflow"), /Project defaults/);
    assert.match(await modelSource(page, "planner · claude"), /low[\s\S]*Project defaults/);
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("pattern"), localStorage.getItem("roleSel"), JSON.parse(localStorage.getItem("agentSettings")!)]), ["solo", null, SAVED_MODELS]);

    assert.deepEqual(await settingsModels(page), { claude: "high", codex: "low", stored: SAVED_MODELS }, "Settings > Agents & models keeps the saved choices");
    await page.goto(`${base}/#/settings/runs`);
    assert.equal(await page.getByLabel("Default workflow").inputValue(), "solo", "Settings > Run defaults keeps its default workflow");
    assert.match(await page.locator("#default-workflow-projects").innerText(), /Remembers a team \(Plan → Build → Review\)/);

    await newRun(page, projectC);
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); await openAdvanced(page);
    assert.equal(await page.locator("#workflow-select").inputValue(), "solo", "another project starts from Settings > Run defaults");
    assert.doesNotMatch(await modelSource(page, "Workflow"), /Project defaults/, "another project's label doesn't carry over");
    assert.match(await modelSource(page, "agent · claude"), /high/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("both template save entries refuse a restored verification profile with the same explanation", { timeout: 90_000 }, async () => {
  const run = await api("/api/runs", { repo: repoB, project: projectB, task: "Verify with custom gates", pattern: "pipeline", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, options: {}, trust: "standard", approvals: { plan: false }, loop: { check: "true", maxSteps: 10, maxMinutes: 5, verification: { name: "lightweight", checks: [{ id: "unit", kind: "unit", command: "true", required: true, timeoutMs: 10000 }] } } });
  await finished(run.id);
  const { context, page } = await freshPage();
  try {
    await page.goto(`${base}/#/run/${run.id}`);
    await page.getByRole("button", { name: "More run actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
    await page.waitForURL(url => /^#\/project\/[^/]+\/new$/.test(url.hash));
    await page.getByRole("button", { name: "Edit run options", exact: true }).click(); await openAdvanced(page);
    assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "restored");
    const reason = "Choose a verification preset before saving a template";
    await page.locator(".composer").getByRole("button", { name: "Run actions", exact: true }).click();
    const item = page.getByRole("menuitem", { name: /Save as template/ });
    assert.equal(await item.isDisabled(), true); assert.match(await item.innerText(), new RegExp(reason));
    await page.keyboard.press("Escape");
    const button = page.getByRole("button", { name: "Save task preset", exact: true });
    assert.equal(await button.isDisabled(), true, "the Advanced entry has the same guard");
    assert.equal(await page.locator(`#${await button.getAttribute("aria-describedby")}`).innerText(), `${reason}.`);

    await page.getByLabel("Verification gates", { exact: true }).selectOption("lightweight");
    await button.click();
    const save = page.getByRole("dialog", { name: "Save as template", exact: true });
    assert.doesNotMatch(await save.locator("p.help").innerText(), /permissions, checks and run settings/);
    await save.getByLabel("Template name", { exact: true }).fill("Lightweight after retry");
    await save.getByLabel("Save to").selectOption("personal");
    await save.getByRole("button", { name: "Save template", exact: true }).click();
    await save.waitFor({ state: "detached" });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("composerLibrary")!).templates.find((item: any) => item.name === "Lightweight after retry"));
    assert.equal(stored.runOptions.verification, "lightweight");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
