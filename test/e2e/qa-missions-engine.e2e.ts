import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_MISSIONS_ENGINE_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url));
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-missions-engine-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-engine-")), data = join(home, "data");
const shots = join(root, "output/playwright/qa-missions-engine");
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
async function start(extra: Record<string, string> = {}) {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, CODEFLOW_PROJECT_TEAMS_ENABLED: "true", CODEFLOW_SCHEDULER_TICK_MS: "250", FAKE_GH_STATE: join(home, "gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
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
  const project = await api("/api/projects", { name: "QA missions engine", repos: [repository("repo")] });
  assert.equal(project.status, 201); projectId = project.body.id;
});
after(async () => {
  try { await browser?.close(); } finally { await stop(); writeFileSync(join(shots, "server.log"), serverLog.join("")); writeFileSync(join(shots, "browser.log"), JSON.stringify(browserErrors, null, 2)); rmSync(home, { recursive: true, force: true }); }
});

const mission = (extra = {}) => ({ mission: "Improve the documented input contract", users: "Developers", baseBranch: "main", mode: "build-within-scope", check: "node check.mjs", coordinator: "claude", pool: ["claude", "codex"], schedule: { every: 5 }, ...extra });

test("draft/paused/disabled previews have no upcoming runs and missing branches fail clearly", async () => {
  const project = (await api("/api/projects")).body.find((p: any) => p.id === projectId);
  const draft = await api("/api/project-teams", { operationId: "create", projectId, repo: project.repos[0], name: "Engine QA mission", mission: mission() });
  assert.equal(draft.status, 201, JSON.stringify(draft)); teamId = draft.body.id;
  const idle = await api(`/api/project-teams/${teamId}/stop`, { operationId: "idle", revision: draft.body.revision });
  assert.equal(idle.status, 409); assert.equal((await team()).revision, draft.body.revision);
  await open(); await page.getByRole("button", { name: "Preview next cycle", exact: true }).click();
  await page.getByText("No runs are scheduled until you activate this mission.", { exact: true }).waitFor();
  assert.deepEqual((await api(`/api/project-teams/${teamId}/preview`)).body.nextTimes, []);
  await page.getByRole("button", { name: "Edit mission", exact: true }).click();
  await page.getByLabel("Base branch", { exact: true }).fill("missing");
  const refused = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/api/project-teams/${teamId}`));
  await page.getByRole("button", { name: "Save mission", exact: true }).click(); assert.equal((await refused).status(), 400);
  await page.getByRole("alert").filter({ hasText: /Base branch "missing" doesn.t exist/ }).waitFor();
  await page.getByLabel("Base branch", { exact: true }).fill("main"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Activate", exact: true }).click(); await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).click(); await page.getByRole("button", { name: "Preview next cycle", exact: true }).click();
  await page.getByText("No runs are scheduled while this mission is paused.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Activate", exact: true }).click(); await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.getByRole("button", { name: "Disable project missions", exact: true }).click(); await page.getByRole("button", { name: "Enable project missions", exact: true }).waitFor();
  const trigger = (await api("/api/automations")).body.find((t: any) => t.target?.teamId === teamId);
  assert.equal(trigger.enabled, false); assert.equal(trigger.nextAt, undefined);
  assert.deepEqual((await api(`/api/project-teams/${teamId}/preview`)).body.nextTimes, []);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).click(); await page.getByRole("button", { name: "Disable project missions", exact: true }).waitFor();
  const enabled = (await api("/api/automations")).body.find((t: any) => t.target?.teamId === teamId);
  assert.equal(enabled.enabled, true); assert.ok(enabled.nextAt > Date.now());
});

test("a readable managed task routes back to its mission and remains approvable after archive cleanup", async () => {
  await page.getByRole("button", { name: "Give team a task", exact: true }).click();
  const form = page.getByRole("form", { name: "Give team a task", exact: true });
  await form.getByLabel("Task title", { exact: true }).fill("Document valid empty input");
  await form.getByLabel("Task instructions", { exact: true }).fill("Write a short example of valid empty input.");
  await form.getByLabel("Acceptance criteria, one per line", { exact: true }).fill("The example is clear and checks pass");
  await form.getByRole("button", { name: "Start assigned task", exact: true }).click();
  await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor({ timeout: 45000 });
  let t = await team(), o = t.opportunities[0]; assert.equal(o.status, "ready");
  await page.getByRole("button", { name: "Review diff and checks", exact: true }).click();
  await page.getByRole("link", { name: "Open the mission", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open the mission", exact: true }).getAttribute("href"), `#/project/${projectId}/automation/missions`);
  const bubble = page.locator(".msg-you .run-task"); await bubble.getByText("Write a short example of valid empty input.", { exact: true }).waitFor();
  assert.doesNotMatch(await bubble.innerText(), /Owner mission and constraints:|project_evidence/);
  assert.equal(await page.getByPlaceholder("Tell the team what to change…").count(), 0);
  await page.screenshot({ path: join(shots, "readable-mission-result.png"), fullPage: true });
  await page.getByRole("main").getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive…", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("checkbox", { name: /Remove its/ }).check();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  await open(); await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor();
  t = await team(); o = t.opportunities[0]; assert.equal(o.status, "ready", o.reason);
  const run = (await api(`/api/runs/${o.result.runId}`)).body;
  assert.equal(run.archived, true);
  await page.getByRole("button", { name: "Approve this commit", exact: true }).click();
  await page.getByText("Approved. Open the result to publish a PR or merge using the existing review controls.", { exact: true }).waitFor();
  assert.equal((await team()).opportunities[0].status, "accepted");
});

test("a blocked owner task shows its actual no-change cause and links to the evidence", async () => {
  const t = await team();
  assert.equal((await api(`/api/project-teams/${teamId}/tasks`, { operationId: "no-change", revision: t.revision, title: "No-change task", instructions: "AUTO-NO-CHANGE", acceptance: ["Existing checks pass"], category: "docs" })).status, 201);
  const completed = await readyTeam(); assert.match(completed.opportunities.at(-1).reason, /produced no changes/);
  await open(); const card = page.locator(".pt-opportunity").filter({ hasText: "No-change task" });
  await card.getByText(/produced no changes/).waitFor(); assert.equal(await card.getByRole("button", { name: "Open team run", exact: true }).isVisible(), true);
});

test("project deletion warns about its mission, archives it and lets the repository start a new mission", async () => {
  const old = await team();
  await page.getByRole("button", { name: "Project actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit project", exact: true }).click();
  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this project?", exact: true });
  await dialog.getByText(/Engine QA mission.*will be archived/).waitFor();
  await dialog.getByRole("button", { name: "Delete project", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  for (let i = 0; i < 50 && (await team()).status !== "archived"; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await team()).status, "archived"); assert.deepEqual((await team()).opportunities, old.opportunities);
  const replacement = await api("/api/projects", { name: "Replacement project", repos: [old.repo] }); assert.equal(replacement.status, 201); projectId = replacement.body.id;
  await open(); assert.equal(await page.getByRole("button", { name: "Create a mission", exact: true }).isEnabled(), true);
  const draft = await api("/api/project-teams", { operationId: "replacement", name: "Replacement mission", projectId, repo: old.repo, mission: mission({ mode: "propose" }) }); assert.equal(draft.status, 201, JSON.stringify(draft)); teamId = draft.body.id;
  assert.equal((await api(`/api/project-teams/${teamId}`, { operationId: "activate", revision: draft.body.revision, status: "active" })).status, 200);
});

test("a restart settles interrupted discovery without a resume dead end and preserves its budget after deletion", async () => {
  await page.goto("about:blank"); await stop(); await start({ FAKE_SLEEP_MS: "3000" }); await open();
  await page.getByRole("button", { name: "Run cycle now", exact: true }).click();
  let t = await team();
  for (let i = 0; i < 100 && !t.cycles.at(-1)?.launches[0]?.runId; i++) { await new Promise(r => setTimeout(r, 50)); t = await team(); }
  const runId = t.cycles.at(-1).launches[0].runId;
  for (let i = 0; i < 100; i++) { const run = (await api(`/api/runs/${runId}`)).body; if (run.steps.some((s: any) => s.kind === "agent" && s.status === "running")) break; await new Promise(r => setTimeout(r, 50)); }
  await page.goto("about:blank"); await stop(); await start(); await open();
  t = await readyTeam(); assert.match(t.cycles.at(-1).reason, /interrupted because Code Flow stopped/);
  await page.getByText(/Cycle history \(1\)/, { exact: true }).click();
  await page.getByText(/interrupted because Code Flow stopped/).first().waitFor();
  await page.goto(`${base}/#/run/${runId}`); await page.getByRole("link", { name: "Open the mission", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Resume work", exact: true }).count(), 0);
  const launch = t.cycles.at(-1).launches[0]; assert.equal(launch.usedCalls, launch.calls);
  const removed = await fetch(`${base}/api/runs/${runId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, origin: base } }); assert.equal(removed.status, 200, await removed.text());
  assert.deepEqual((await team()).cycles, t.cycles);
});

test("legacy transient errors clear from the API and mission card across restart", async () => {
  await page.goto("about:blank"); await stop();
  const file = join(data, "project-teams", `${teamId}.json`), saved = JSON.parse(readFileSync(file, "utf8"));
  saved.error = "Auto team execution is disabled by this host’s configuration"; writeFileSync(file, JSON.stringify(saved));
  await start(); await open();
  for (let i = 0; i < 100 && (await team()).error; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await team()).error, undefined);
  assert.equal(await page.getByRole("alert").filter({ hasText: /Auto team execution is disabled/ }).count(), 0);
  // One 400 above intentionally verifies that invalid edits are rejected; all other console output must be clean.
  assert.deepEqual(browserErrors, ["Failed to load resource: the server responded with a status of 400 (Bad Request)"], serverLog.join("\n"));
});
