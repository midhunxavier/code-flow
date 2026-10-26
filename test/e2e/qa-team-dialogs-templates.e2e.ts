import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-team52-"))), home = join(dir, "home"), repo = join(dir, "repo");
const token = "qa-team52", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let port: number, base: string, server: ChildProcess, browser: Browser, page: Page | undefined, project: string, logs = "";
const errors: string[] = [];
const team = { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: { claude: { model: "sonnet" }, codex: { model: "gpt-a" } }, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false };
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60000;
  for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, JSON.stringify(value).slice(0, 1500)); await new Promise(resolve => setTimeout(resolve, 70)); }
}
const done = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running" && !!run.endedAt);
const start = (extra: Record<string, unknown> = {}) => api("/api/runs", { repo, project, pattern: "solo", task: "AUTO-MINIMAL implement the fixture", roles: { agent: ["claude"] }, agentSettings: { claude: { model: "sonnet" }, codex: { model: "gpt-a" } }, approvals: { tools: false, plan: false }, loop: { check: "true", maxSteps: 30 }, ...extra });
async function shot(name: string) { if (evidence && page) await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); }
async function audit(selector: string, name: string) {
  await page!.addScriptTag({ content: axe.source });
  const result = await page!.evaluate(async selector => (window as any).axe.run(selector, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }), selector);
  if (evidence) writeFileSync(join(evidence, name + ".json"), JSON.stringify(result, null, 2));
  assert.deepEqual(result.violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })), []);
}
async function stopServer() { if (server && server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await exited; } }
async function launch(enabled = true) {
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_AUTO_TEAM_ENABLED: String(enabled), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => logs += String(value));
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
}
async function open(hash: string, init: Record<string, string> = {}, doctor = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(({ repo, init }) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); for (const [key, value] of Object.entries(init)) localStorage.setItem(key, value); }, { repo, init });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  if (doctor) await page.route("**/api/doctor", async route => { const response = await route.fetch(); const value = await response.json(); await route.fulfill({ response, json: value.map((entry: any) => entry.id === "agy" ? { ...entry, installed: true, compatible: true, signedIn: true, managedCompatible: true } : entry) }); });
  await page.goto(`${base}/?token=${token}#/${hash}`); await page.locator("#main-content").waitFor(); return page;
}
before(async () => {
  for (const path of [home, repo]) mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "QA team fixture\n"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "fixture"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  port = await new Promise(resolve => { const listener = createServer().listen(0, "127.0.0.1", () => { const value = (listener.address() as AddressInfo).port; listener.close(() => resolve(value)); }); });
  assert.ok(port !== 4317 && port !== 4318); base = `http://127.0.0.1:${port}`; await launch();
  project = (await api("/api/projects", { name: "Dialog QA", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); if (evidence) mkdirSync(evidence, { recursive: true });
});
afterEach(async context => { if (page) { if (evidence) await page.screenshot({ path: join(evidence, context.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 100) + ".png"), animations: "disabled" }); await page.context().close(); page = undefined; } });
after(async () => { await browser?.close(); await stopServer(); if (evidence) { writeFileSync(join(evidence, "server.log"), logs); writeFileSync(join(evidence, "page-errors.json"), JSON.stringify(errors)); } rmSync(dir, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.doesNotMatch(logs, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); });

test("template prefill keeps pool model and coordinator effort and explains same-field conflicts", async () => {
  const template = { schemaVersion: 1, id: "qa-prefill", version: 1, name: "Pool and coordinator", description: "QA", scope: "personal", autoEnabled: false, parameters: ["task"], roles: [], tasks: [], contracts: [], workflow: "auto-team", task: "{{task}}", criteria: [], preferences: { roles: { coordinator: ["codex"], pool: ["codex", "claude"] }, options: { maxMembers: 9 }, agentSettings: {}, roleSettings: { pool: { codex: { model: "gpt-b" } }, coordinator: { codex: { effort: "low" } } } } };
  await api("/api/team-templates", { template, expectedVersion: 0 });
  await api("/api/team-templates", { template: { ...template, id: "qa-overlap", name: "Overlapping models", preferences: { ...template.preferences, roleSettings: { ...template.preferences.roleSettings, coordinator: { codex: { model: "gpt-a", effort: "low" } } } } }, expectedVersion: 0 });
  const p = await open(`project/${project}/new`); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.getByRole("button", { name: "Advanced", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "AI team setup" }); await dialog.getByLabel("Team template", { exact: true }).selectOption("saved:qa-prefill");
  const codex = dialog.locator(".task-team-member").filter({ hasText: "Codex" }); await codex.getByRole("button", { name: /^Model: GPT-B/ }).waitFor(); await codex.getByRole("button", { name: /^Effort: low/ }).waitFor();
  await dialog.getByRole("button", { name: "Apply team settings" }).click(); await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem("taskTeamPreferences")!).settings.codex), { model: "gpt-b", effort: "low" });
  await p.getByRole("button", { name: "Advanced", exact: true }).click(); await dialog.getByLabel("Team template", { exact: true }).selectOption("saved:qa-overlap"); await dialog.getByRole("status").filter({ hasText: "codex model" }).waitFor();
  await codex.getByRole("button", { name: /^Model: GPT-A/ }).waitFor(); await audit(".task-team-dialog", "team-setup");
});

test("lead quick picker excludes Antigravity with approvals and permits it after an explicit permission change", async () => {
  const p = await open(`project/${project}/new`, {}, true); const toggle = p.getByRole("switch", { name: "AI team", exact: true }); await toggle.click();
  await p.getByRole("button", { name: /^Lead model:/ }).click(); assert.equal(await p.getByRole("option", { name: /Antigravity/ }).count(), 0); await p.keyboard.press("Escape");
  await toggle.click(); await p.getByRole("button", { name: /^Permissions:/ }).click(); await p.getByRole("menuitem", { name: /^Approve for me/ }).click(); await toggle.click();
  await p.getByRole("button", { name: /^Lead model:/ }).click(); await p.getByRole("option", { name: /Antigravity.*Default model/ }).click();
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem("taskTeamPreferences")!).coordinator), "agy");
});

test("conflict refresh and choice toggles preserve typed edits while changed versions require a new choice", async () => {
  const started = await start({ taskTeam: { ...team, approvePlan: true } });
  const parent = await until(() => api(`/api/runs/${started.id}`), value => !!value.teamTurns?.length);
  const execution = parent.teamTurns[0].executionId; const child = await until(() => api(`/api/runs/${execution}`), value => !!value.awaiting || value.status === "failed"); if (evidence) writeFileSync(join(evidence, "conflict-child.json"), JSON.stringify(child, null, 2)); assert.ok(child.awaiting, child.error);
  const tree = parent.worktrees.find((value: any) => value.name === "solo"); writeFileSync(join(tree.path, "claude-alpha.txt"), "My concurrent edit\n");
  const p = await open(`run/${started.id}`); await p.getByRole("button", { name: "Approve plan", exact: true }).click(); await done(started.id);
  const activity = p.getByRole("region", { name: "Team activity" }); await activity.locator("summary").first().click(); await activity.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Resolve team changes" }), edit = dialog.getByRole("textbox", { name: "Resolved file contents", exact: true });
  await dialog.getByRole("button", { name: "Edit result", exact: true }).click(); await edit.fill("My combined resolution\n");
  await dialog.getByRole("button", { name: "Keep yours", exact: true }).click(); await dialog.getByRole("button", { name: "Edit result", exact: true }).click(); assert.equal(await edit.inputValue(), "My combined resolution\n");
  await dialog.getByRole("button", { name: "Refresh comparison" }).click(); await until(() => dialog.getByRole("button", { name: "Refresh comparison" }).isEnabled(), Boolean); assert.equal(await edit.inputValue(), "My combined resolution\n");
  writeFileSync(join(tree.path, "unrelated.txt"), "Unrelated workspace edit\n"); await dialog.getByRole("button", { name: "Apply and check" }).click(); await dialog.getByRole("alert").filter({ hasText: "changed since" }).waitFor();
  await dialog.getByRole("button", { name: "Refresh comparison" }).click(); await until(() => dialog.getByRole("button", { name: "Refresh comparison" }).isEnabled(), Boolean); assert.equal(await edit.inputValue(), "My combined resolution\n");
  writeFileSync(join(tree.path, "claude-alpha.txt"), "Changed conflict version\n"); await dialog.getByRole("button", { name: "Refresh comparison" }).click(); await dialog.getByRole("status").filter({ hasText: "Choices were cleared" }).waitFor(); assert.equal(await dialog.getByRole("button", { name: "Apply and check" }).isDisabled(), true);
  await dialog.getByText("Previous edit for claude-alpha.txt", { exact: true }).click(); assert.equal(await dialog.getByRole("textbox", { name: "Previous edit for claude-alpha.txt" }).inputValue(), "My combined resolution\n");
  await shot("changed-conflict-preserved-edit"); await audit(".task-conflict-dialog", "conflict-dialog");
  await dialog.getByRole("button", { name: "Edit result", exact: true }).click(); assert.equal(await edit.inputValue(), "My combined resolution\n"); await dialog.getByRole("button", { name: "Apply and check" }).click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(readFileSync(join(tree.path, "claude-alpha.txt"), "utf8"), "My combined resolution\n"); assert.equal(readFileSync(join(tree.path, "unrelated.txt"), "utf8"), "Unrelated workspace edit\n");
});

test("turning AI team off disables preserved-work resume and turning it on restores the action", async () => {
  const started = await start({ task: "AUTO-FAILURE Implement the sample", taskTeam: team }); await done(started.id);
  const p = await open(`run/${started.id}`); const resume = p.getByRole("button", { name: "Resume team", exact: true }); await resume.waitFor();
  const toggle = p.locator("main").getByRole("switch", { name: "AI team", exact: true }); await toggle.click(); await p.getByText("Turn on AI team to resume its preserved work.", { exact: true }).waitFor(); assert.equal(await resume.isDisabled(), true);
  await toggle.click(); await until(() => resume.isEnabled(), Boolean); assert.equal(await p.locator(".task-team-recovery [role=alert]").count(), 0);
  const response = p.waitForResponse(response => response.url().endsWith("/team-resume") && response.request().method() === "POST"); await resume.click(); assert.ok((await response).ok()); await done(started.id);
});

test("browser library import displays server notes for both scopes and retains originals", async () => {
  const library = (name: string) => ({ schemaVersion: 1, templates: [], presets: [{ id: name, name, config: { pattern: "race", roles: { contestants: ["claude", "codex"] }, check: "npm test", setup: "npm ci" }, runOptions: { verification: "thorough", container: { enabled: true, image: "qa/image" } } }] });
  const personal = JSON.stringify(library("Personal checks")), scoped = JSON.stringify(library("Project checks"));
  const p = await open(`project/${project}/new`, { composerLibrary: personal, [`composerLibrary:${project}`]: scoped, composerAdvanced: "0" });
  await p.locator(".composer-options > summary").click(); await p.locator(".advanced-controls > summary").click();
  const region = p.getByRole("region", { name: "Reusable team templates" }); await region.getByRole("button", { name: "Import browser library" }).click();
  const notice = region.getByRole("status"); await notice.getByText(/Personal checks:.*verification command.*thorough verification profile.*Docker isolation/).waitFor(); await notice.getByText(/Project checks:.*verification command.*thorough verification profile.*Docker isolation/).waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem("composerLibrary")), personal); assert.equal(await p.evaluate(key => localStorage.getItem(key), `composerLibrary:${project}`), scoped);
});

test("save-from-run is a focused editor and publishes the run strategy without composer actions", async () => {
  const started = await start({ pattern: "auto-team", task: "AUTO-SAME-PROVIDER implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] } }); const finished = await done(started.id); assert.equal(finished.status, "done", finished.error);
  const p = await open(`run/${started.id}`); await p.getByRole("button", { name: "More run actions", exact: true }).click(); await p.getByRole("menuitem", { name: "Save as team template…" }).click();
  const dialog = p.getByRole("dialog", { name: "Save reusable team strategy" }); await dialog.getByLabel("Template definition").waitFor();
  assert.equal(await dialog.getByLabel("Saved templates").count(), 0);
  for (const name of ["Design a template", "Save current workflow as template", "Import template", "Import browser library", "Close editor"]) assert.equal(await dialog.getByRole("button", { name, exact: true }).count(), 0, name);
  const definition = JSON.parse(await dialog.getByLabel("Template definition").inputValue()); assert.ok(definition.tasks.length > 0); await dialog.getByLabel("Name", { exact: true }).fill("Captured QA strategy"); await shot("focused-save-from-run"); await audit("dialog[open]", "save-from-run");
  await dialog.getByRole("button", { name: "Publish template version" }).click(); await dialog.waitFor({ state: "hidden" });
  const saved = (await api(`/api/team-templates?project=${project}`)).templates.find((entry: any) => entry.id === definition.id); assert.equal(saved.name, "Captured QA strategy"); assert.deepEqual(saved.tasks, definition.tasks);
});

test("the reusable-team version limit reaches the UI with a recovery instruction and unchanged history", async () => {
  const configuration = { coordinator: "claude", pool: ["claude"], agentSettings: {}, roleSettings: {} };
  let definition = await api("/api/project-teams/definitions", { operationId: "qa-limit-1", name: "Bounded team", configuration });
  definition = definition.definition ?? definition;
  for (let revision = 2; revision <= 100; revision++) { const value = await api(`/api/project-teams/definitions/${definition.id}`, { operationId: `qa-limit-${revision}`, revision: revision - 1, name: "Bounded team", configuration }); definition = value.definition ?? value; }
  const p = await open(`project/${project}/automation/missions`); await p.getByText("Reusable agent teams (1)", { exact: true }).click(); await p.getByRole("button", { name: "Edit reusable team", exact: true }).click();
  const form = p.getByRole("form", { name: "Edit reusable agent team" }); await form.getByLabel("Agent team name").fill("More changes"); const response = p.waitForResponse(response => response.url().endsWith(`/definitions/${definition.id}`) && response.request().method() === "POST"); await form.getByRole("button", { name: "Save new team version" }).click(); assert.equal((await response).status(), 409); await form.getByRole("alert").filter({ hasText: /100-version limit.*Create a new/ }).waitFor();
});

test("server rollout disables new team toggles while existing enabled teams can be turned off", async () => {
  const existing = await start({ task: "Answer directly", taskTeam: team }); await done(existing.id);
  const p = await open(`project/${project}/new`); const toggle = p.getByRole("switch", { name: "AI team", exact: true }); await toggle.click();
  await p.locator(".taskbox textarea").fill("Saved team draft"); await p.reload(); await until(() => toggle.getAttribute("aria-checked"), value => value === "true");
  await stopServer(); await launch(false); assert.equal((await api("/api/team-rollout")).enabled, false);
  await p.reload(); await p.getByText("Team is disabled on this server. Turn AI team off to continue with one agent.", { exact: true }).waitFor(); assert.equal(await p.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  await toggle.click(); await until(() => toggle.isDisabled(), Boolean); assert.match(await toggle.getAttribute("title") ?? "", /Team is disabled/);
  await p.goto(`${base}/#/run/${existing.id}`); const existingToggle = p.locator("main").getByRole("switch", { name: "AI team", exact: true }); await until(() => existingToggle.getAttribute("aria-checked"), value => value === "true"); assert.equal(await existingToggle.isEnabled(), true); await existingToggle.click(); await until(() => api(`/api/runs/${existing.id}`), value => value.taskTeam?.enabled === false); assert.equal(await existingToggle.isDisabled(), true);
  const solo = await start({ task: "Single agent still works" }); await done(solo.id);
});
