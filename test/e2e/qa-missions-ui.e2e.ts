import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { PROJECT_TEAM_BUDGET_RANGES } from "../../src/project-team-budget.js";
const qaPorts = await reserveQaPorts(2, process.env.QA_MISSIONS_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url));
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-missions-ui-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-ui-")), data = join(home, "data");
const shots = join(root, "output/playwright/qa-missions-ui");
let server: ChildProcess, browser: Browser, page: Page, projectId: string, teamId: string;
const browserErrors: string[] = [], serverLog: string[] = [];
const api = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base }, ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
const team = async () => (await api(`/api/project-teams/${teamId}`)).body.team;
async function readyTeam(id = teamId) {
  for (let i = 0; i < 200; i++) {
    const t = (await api(`/api/project-teams/${id}`)).body.team;
    if (t.cycles.at(-1)?.endedAt) return t;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Mission cycle did not settle");
}
function repository(name: string) {
  const repo = join(home, name); mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  writeFileSync(join(repo, "check.mjs"), "process.exit(0);\n");
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}
async function start() {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, CODEFLOW_PROJECT_TEAMS_ENABLED: "true", CODEFLOW_SCHEDULER_TICK_MS: "250", FAKE_GH_STATE: join(home, "gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", value => serverLog.push(String(value))); server.stderr?.on("data", value => serverLog.push(String(value)));
  for (let i = 0; i < 100; i++) { if (await api("/api/health").then(r => r.status === 200, () => false)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(serverLog.join("\n"));
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => server.once("exit", () => resolve()));
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM");
  await stopped; clearTimeout(timer);
}
async function open(project = projectId) {
  await page.goto(`${base}/?token=${token}#/project/${project}/automation/missions`);
  await page.getByRole("heading", { name: "Project missions", exact: true }).waitFor();
}
before(async () => {
  mkdirSync(shots, { recursive: true }); writeFileSync(join(home, "gh.json"), '{"issues":[],"prs":{}}');
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  await start(); browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 500) browserErrors.push(`${response.status()} ${response.url()}`); });
  const project = await api("/api/projects", { name: "QA missions UI", repos: [repository("repo")] });
  assert.equal(project.status, 201); projectId = project.body.id;
});
after(async () => {
  try { await browser?.close(); } finally { await stop(); writeFileSync(join(shots, "server.log"), serverLog.join("")); writeFileSync(join(shots, "browser.log"), JSON.stringify(browserErrors, null, 2)); rmSync(home, { recursive: true, force: true }); }
});

test("mission creation validates all six budgets before sending and detects an existing assignment", async () => {
  await open(); await page.getByRole("button", { name: "Create a mission", exact: true }).click();
  const form = page.locator("form.pt-form");
  await form.getByLabel("Mission name", { exact: true }).fill("QA mission");
  await form.getByLabel("Mission", { exact: true }).fill("Improve the documented input contract");
  await form.getByLabel("Intended users").fill("Developers");
  await form.getByLabel("Required check command").fill("node check.mjs");
  await form.getByText("Schedule, budget and scope limits", { exact: true }).click();
  const labels = ["Calls per discovery", "Minutes per discovery", "Calls per implementation", "Minutes per implementation", "Calls per rolling week", "Minutes per rolling week"];
  for (const [index, range] of Object.values(PROJECT_TEAM_BUDGET_RANGES).entries()) {
    const input = form.getByLabel(new RegExp(`^${labels[index]}`));
    assert.equal(await input.getAttribute("min"), String(range.min)); assert.equal(await input.getAttribute("max"), String(range.max));
    await input.fill(String(range.min - 1)); assert.equal(await input.evaluate((el: HTMLInputElement) => el.checkValidity()), false);
    await input.fill(String(range.max + 1)); assert.equal(await input.evaluate((el: HTMLInputElement) => el.checkValidity()), false);
    await input.fill(String(range.default));
  }
  await form.getByLabel(/^Calls per discovery/).fill("3");
  let requests = 0; const count = (r: import("playwright-core").Request) => { if (r.method() === "POST" && r.url() === base + "/api/project-teams") requests++; }; page.on("request", count);
  await form.getByRole("button", { name: "Save draft mission", exact: true }).click();
  assert.equal(requests, 0); assert.equal((await api(`/api/project-teams?project=${projectId}`)).body.teams.length, 0);
  await form.getByLabel(/^Calls per discovery/).fill("8"); await form.getByRole("button", { name: "Save draft mission", exact: true }).click();
  await page.getByRole("button", { name: "Activate", exact: true }).waitFor(); page.off("request", count);
  teamId = (await api(`/api/project-teams?project=${projectId}`)).body.teams[0].id;
  assert.equal(await page.getByRole("button", { name: "Create a mission", exact: true }).isEnabled(), false);
  await page.getByText(/Every repository here already has a mission/).waitFor();
  await page.getByRole("button", { name: "Activate", exact: true }).click(); await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
});

test("a streamed edit cannot overwrite an open form and reloading adopts the latest values", async () => {
  await open(); await page.getByRole("button", { name: "Edit mission", exact: true }).click();
  const other = await browser.newPage(); await other.goto(`${base}/?token=${token}#/project/${projectId}/automation/missions`);
  await other.getByRole("button", { name: "Edit mission", exact: true }).click();
  const otherForm = other.locator("form.pt-form"); await otherForm.getByText("Schedule, budget and scope limits", { exact: true }).click();
  await otherForm.getByLabel("Maximum changed lines", { exact: true }).fill("401"); await otherForm.getByRole("button", { name: "Save mission", exact: true }).click();
  await otherForm.waitFor({ state: "detached" });
  await page.getByText(/This mission was changed elsewhere/).waitFor();
  const form = page.locator("form.pt-form"); await form.getByLabel("Mission name", { exact: true }).fill("Stale name");
  assert.equal(await form.getByRole("button", { name: "Save mission", exact: true }).isEnabled(), false);
  assert.equal((await team()).mission.maxLines, 401); assert.equal((await team()).name, "QA mission");
  await page.screenshot({ path: join(shots, "stale-form.png"), fullPage: true });
  await form.getByRole("button", { name: "Reload form", exact: true }).click();
  assert.equal(await form.getByLabel("Maximum changed lines", { exact: true }).inputValue(), "401");
  assert.equal(await form.getByLabel("Mission name", { exact: true }).inputValue(), "QA mission");
  await form.getByRole("button", { name: "Cancel", exact: true }).click(); await other.close();
});

test("verified results require confirmation for rejection and archive, and cancellation preserves them", async () => {
  await page.getByRole("button", { name: "Run cycle now", exact: true }).click();
  await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor({ timeout: 45000 });
  let t = await team(); assert.equal(t.opportunities[0].status, "ready");
  await page.getByRole("button", { name: "Reject draft…", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Reject this verified draft?", exact: true });
  await dialog.getByText(/can no longer be approved/).waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await team()).opportunities[0].status, "ready");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Reject this result?", exact: true }); await dialog.waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await team()).opportunities[0].status, "ready");
  await page.getByRole("button", { name: "Archive mission", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Archive this mission?", exact: true }); await dialog.getByText(/Archiving can’t be undone/).waitFor();
  await dialog.getByText(/1 result awaiting approval or shipping/).waitFor(); await page.screenshot({ path: join(shots, "archive-confirmation.png") });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal((await team()).status, "active");
  await page.getByRole("button", { name: "Reject draft…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject draft", exact: true }).click();
  await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor({ state: "detached" }); assert.equal((await team()).opportunities[0].status, "rejected");
});

test("blocked-only inbox summaries and admission rules explain unavailable task actions", async () => {
  let t = await team();
  const task = await api(`/api/project-teams/${teamId}/tasks`, { operationId: "blocked", revision: t.revision, title: "AUTO-FAILURE", instructions: "AUTO-FAILURE", acceptance: ["Checks pass"], category: "docs" });
  assert.equal(task.status, 201, JSON.stringify(task)); t = await readyTeam(); assert.equal(t.opportunities.at(-1).status, "blocked");
  await page.goto(`${base}/#/project/${projectId}`); await page.getByText("1 needs attention", { exact: true }).waitFor();
  await open();
  t = await team(); const update = await api(`/api/project-teams/${teamId}`, { operationId: "no-check", revision: t.revision, mission: { ...t.mission, mode: "propose", check: "", verification: undefined } });
  assert.equal(update.status, 200, JSON.stringify(update)); await open();
  assert.equal(await page.getByRole("button", { name: "Give team a task", exact: true }).isEnabled(), false);
  await page.getByText(/Give team a task: Configure a required verification check/).waitFor();
  t = await team();
  assert.equal((await api(`/api/project-teams/${teamId}`, { operationId: "restore-check", revision: t.revision, mission: { ...t.mission, mode: "build-within-scope", check: "node check.mjs" } })).status, 200);
  for (const title of ["First reviewed task", "Second reviewed task"]) {
    t = await team();
    assert.equal((await api(`/api/project-teams/${teamId}/tasks`, { operationId: title, revision: t.revision, title, instructions: "Document empty input", acceptance: ["Checks pass"], category: "docs" })).status, 201);
    t = await readyTeam(); assert.equal(t.opportunities.at(-1).status, "ready");
  }
  await open();
  assert.equal(await page.getByRole("button", { name: "Give team a task", exact: true }).isEnabled(), false);
  await page.getByText(/Give team a task: Review pending work/).waitFor();
  const riskRepo = repository("risky");
  const riskProject = (await api("/api/projects", { name: "Risk policy", repos: [riskRepo] })).body;
  const draft = (await api("/api/project-teams", { operationId: "risky", projectId: riskProject.id, repo: riskRepo, name: "Risk policy", mission: { ...t.mission, mission: "PT-HIGH-RISK Improve documentation" } })).body;
  assert.equal((await api(`/api/project-teams/${draft.id}`, { operationId: "activate", revision: draft.revision, status: "active" })).status, 200);
  assert.equal((await api(`/api/project-teams/${draft.id}/cycle`, { operationId: "risk-cycle" })).status, 200);
  const risk = await readyTeam(draft.id); assert.equal(risk.opportunities[0].risk, "high");
  await open(riskProject.id);
  assert.equal(await page.getByRole("button", { name: "Build proposal", exact: true }).isEnabled(), false);
  await page.getByText(/Build proposal: Needs an owner decision about risk/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Give as a task", exact: true }).isEnabled(), true);
  await open();
});

test("new reusable assignments have one repository picker and archived cards are read-only", async () => {
  await page.getByRole("button", { name: "Save as reusable team", exact: true }).click();
  await page.getByRole("button", { name: "Save team configuration", exact: true }).click();
  await page.getByRole("button", { name: "Save team configuration", exact: true }).waitFor({ state: "detached" });
  const project = await api("/api/projects", { name: "Other assignment", repos: [repository("other")] }); assert.equal(project.status, 201);
  await open(project.body.id); await page.getByText("Reusable agent teams (1)", { exact: true }).click();
  await page.getByRole("button", { name: "Assign to this project", exact: true }).click();
  const assignment = page.getByRole("region", { name: "Assign agent team to project", exact: true });
  assert.equal(await assignment.getByRole("combobox", { name: /^Repository/ }).count(), 1);
  await open(); await page.getByRole("button", { name: "Archive mission", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive mission", exact: true }).click();
  await page.getByText(/Archived · read-only history/).waitFor(); assert.equal((await team()).status, "archived");
  assert.equal(await page.getByText(/Recurring discovery enabled/).count(), 0);
  // The archived card streams before the ownership inventory finishes reloading.
  // Exercise the newly available action once that authoritative refresh settles.
  await page.getByRole("button", { name: "Create a mission", exact: true }).click();
  await page.getByLabel("Mission name", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("damaged records name their files and block creation; damaged settings are unavailable", async () => {
  await page.goto("about:blank"); await stop();
  const file = join(data, "project-teams", `${teamId}.json`), original = readFileSync(file, "utf8"); writeFileSync(file, "{broken");
  await start(); await open();
  await page.getByRole("alert").filter({ hasText: file }).waitFor();
  await page.getByRole("alert").filter({ hasText: /Restore .* from a backup/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create a mission", exact: true }).isEnabled(), false);
  await page.goto("about:blank"); await stop(); writeFileSync(file, original); writeFileSync(join(data, "project-teams", "settings.json"), "{broken"); await start(); await open();
  await page.getByText("Unavailable · the saved setting can’t be read", { exact: true }).waitFor();
  await page.getByRole("alert").filter({ hasText: join(data, "project-teams", "settings.json") }).waitFor();
  await page.screenshot({ path: join(shots, "storage-unavailable.png"), fullPage: true });
  assert.deepEqual(browserErrors, [], serverLog.join("\n"));
});
