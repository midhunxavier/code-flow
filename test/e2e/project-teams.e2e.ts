import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const freePort = () => new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
const port = Number(process.env.QA_MISSIONS_PORT) || await freePort(), base = `http://127.0.0.1:${port}`, token = "standing-team-e2e-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-standing-e2e-")), repo = join(home, "repo");
let server: ChildProcess, browser: Browser;
const errors: string[] = [];
const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
async function startServer() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(Number(process.env.QA_MISSIONS_PORT) ? port + 1 : await freePort()), CODEFLOW_HOME: join(home, "data"), CODEFLOW_TOKEN: token, CODEFLOW_SCHEDULER_TICK_MS: "250", FAKE_DISCOVERY_DELAY_MS: process.env.QA_MISSIONS_MODEL_DELAY_MS ?? "0", FAKE_DISCOVERY_MODELS: JSON.stringify(["sonnet", "standing-free"].map(value => ({ value, resolvedModel: value, displayName: value, supportsEffort: true, supportedEffortLevels: ["low", "high"] }))), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.resume();
  server.stderr?.on("data", (data) => errors.push(String(data)));
  let ready = false;
  for (let i = 0; i < 100; i++) { ready = await api("/api/health").then((r) => r.status === 200, () => false); if (ready) break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(ready, true, `fixture server started: ${errors.join("\n")}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); }
  assert.equal(server.exitCode, 0, errors.join("\n"));
}
before(async () => {
  mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "Empty input is valid.\n"); writeFileSync(join(repo, "check.mjs"), "process.exit(0);\n");
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  await startServer();
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  try { await browser?.close(); }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.kill("SIGTERM");
      try { await exited; } finally { clearTimeout(timer); }
      assert.equal(server.exitCode, 0, `fixture server stopped cleanly: ${errors.join("\n")}`);
    }
    // The server may still be cleaning up worktrees until it has exited.
    rmSync(home, { recursive: true, force: true });
  }
});

test("owner creates a standing team, previews, runs, reviews and approves with one shared stream", async () => {
  const project = await api("/api/projects", { name: "Standing product", repos: [repo] }); assert.equal(project.status, 201, JSON.stringify(project));
  const id = project.body.id;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); const pageErrors: string[] = []; page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("agentSettings", JSON.stringify({ claude: { model: "composer-default" } })));
  await page.route("**/api/models", async route => {
    // The fixture intentionally restarts while catalog discovery can still be in flight.
    try {
      const response = await route.fetch(), catalogs = await response.json();
      catalogs.claude.models = [{ id: "standing-free", label: "Standing model (free)", efforts: ["low", "high"] }];
      await route.fulfill({ response, json: catalogs });
    } catch { await route.abort("connectionreset").catch(() => undefined); }
  });
  await page.goto(`${base}/?token=${token}#/project/${id}/automation/missions`);
  assert.equal((await api("/api/project-teams/settings")).body.enabled, false);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create a mission", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).click();
  await page.getByRole("button", { name: "Disable project missions", exact: true }).waitFor();
  assert.equal((await api("/api/project-teams/settings")).body.enabled, true);
  await stopServer(); await startServer();
  // The shared stream also reloads when the restarted server changes its identity.
  // Either navigation may win; the enabled-state assertion below verifies recovery.
  await page.reload().catch(error => { if (!String(error).includes("ERR_ABORTED")) throw error; });
  await page.getByRole("button", { name: "Disable project missions", exact: true }).waitFor();
  assert.equal((await api("/api/project-teams/settings")).body.source, "saved", "feature remains enabled after a server restart without environment flags");
  assert.equal((await api("/api/project-teams/settings", { enabled: false, revision: 0 })).status, 409);
  assert.equal((await api("/api/project-teams/settings", { enabled: "yes", revision: 1 })).status, 400);
  assert.equal((await fetch(base + "/api/project-teams/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, revision: 1 }) })).status, 401);
  await page.getByRole("button", { name: "Create a mission", exact: true }).click();
  await page.getByLabel("Mission", { exact: true }).fill("Improve the documented input contract");
  await page.getByLabel("Intended users").fill("Developers");
  await page.getByLabel("Autonomy").selectOption("build-within-scope");
  await page.getByLabel("Required check command").fill("node check.mjs");
  await page.getByText("Schedule, budget and scope limits", { exact: true }).click();
  await page.getByRole("button", { name: /^Claude Code model:/ }).click();
  await page.getByRole("combobox", { name: "Search Claude Code model", exact: true }).fill("standing");
  await page.getByRole("button", { name: "Free only", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "Standing model (free)" }).click();
  await page.getByLabel("Claude Code effort", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save draft mission" }).click();
  await page.getByRole("button", { name: "Activate", exact: true }).waitFor();
  const draft = (await api(`/api/project-teams?project=${id}`)).body.teams[0];
  assert.deepEqual(draft.mission.agentSettings.claude, { model: "standing-free", effort: "high" });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("agentSettings")!).claude.model), "composer-default", "mission model selection does not change composer defaults");
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.getByRole("button", { name: "Preview next cycle" }).click();
  await page.getByText("Ready to discover", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Run cycle now" }).click();
  await page.getByRole("button", { name: "Approve this commit" }).waitFor({ timeout: 45000 });
  await page.screenshot({ path: join(home, "standing-team-ready.png"), fullPage: true });
  const inventory = await api(`/api/project-teams?project=${id}`), team = inventory.body.teams[0];
  assert.equal(team.cycles[0].launches.length, 2); assert.equal(team.opportunities[0].status, "ready");
  const resultId = team.opportunities[0].result.runId;
  const deletion = await fetch(`${base}/api/runs/${resultId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(deletion.status, 409, "managed result history cannot be deleted out from under its opportunity");
  assert.match((await deletion.json()).error, /awaiting approval or shipping/);
  await page.getByRole("button", { name: "Approve this commit" }).click();
  await page.getByText("Approved. Open the result to publish a PR or merge using the existing review controls.").waitFor();
  const tab = await context.newPage(); await tab.goto(`${base}/#/project/${id}/automation/missions`); await tab.getByRole("button", { name: "Preview next cycle" }).waitFor();
  const health = await api("/api/health"); assert.equal(health.body.streams.streams, 1, "project team subscriptions reuse the shared transport");
  await page.getByRole("button", { name: "Disable project missions", exact: true }).click();
  await tab.getByRole("button", { name: "Enable project missions", exact: true }).waitFor();
  assert.equal(await tab.getByRole("button", { name: "Run cycle now", exact: true }).isEnabled(), false);
  assert.equal((await api(`/api/project-teams/${team.id}/cycle`, { operationId: "disabled-cycle" })).status, 400);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).click();
  await tab.getByRole("button", { name: "Disable project missions", exact: true }).waitFor();
  await tab.goto(`${base}/#/run/${resultId}`);
  await tab.getByRole("main").getByText(/Project mission implementation/).waitFor();
  assert.equal(await tab.getByRole("main").getByRole("button", { name: "Delete…", exact: true }).count(), 0);
  const rail = tab.getByRole("navigation", { name: "Runs", exact: true });
  await rail.getByRole("button", { name: "Select runs", exact: true }).click();
  await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
  assert.equal(await rail.getByRole("button", { name: "Delete…", exact: true }).isEnabled(), true, "the server checks each selected mission run at deletion time");
  assert.equal(await rail.getByRole("button", { name: "Archive", exact: true }).isEnabled(), true);
  const stale = await api(`/api/project-teams/${team.id}`, { operationId: "stale", revision: 1, status: "paused" }); assert.equal(stale.status, 409);
  const injection = await api("/api/runs", { projectTeam: { teamId: team.id }, pattern: "auto-team", repo, task: "bypass" }); assert.equal(injection.status, 400);
  assert.deepEqual(pageErrors, [], errors.join("\n"));
  await context.close();
});

test("reusable teams attach without losing mission history and owner tasks survive a lost admission response", async () => {
  const inventory = (await api("/api/project-teams")).body;
  const previous = inventory.teams[0], projectId = previous.projectId;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage(), pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${base}/?token=${token}#/project/${projectId}/automation/missions`);
  await page.getByText("Reusable agent teams (0)", { exact: true }).click();
  await page.getByRole("button", { name: "Create agent team", exact: true }).click();
  const form = page.getByRole("form", { name: "Create reusable agent team" });
  await form.getByLabel("Agent team name", { exact: true }).fill("Reusable engineering");
  await form.getByLabel("Team coordinator", { exact: true }).selectOption("claude");
  await form.getByRole("button", { name: "Save reusable team", exact: true }).click();
  const libraryTeam = page.locator(".agent-team-library .pt-team").filter({ hasText: "Reusable engineering" });
  await libraryTeam.getByRole("button", { name: "Assign to this project", exact: true }).click();
  const assignment = page.getByRole("region", { name: "Assign agent team to project" });
  await assignment.getByText(/Its mission history and charged usage stay/).waitFor();
  assert.equal(await assignment.getByLabel("Mission", { exact: true }).inputValue(), previous.mission.mission);
  await assignment.getByLabel("Run recurring discovery", { exact: true }).uncheck();
  await assignment.getByRole("button", { name: "Save mission", exact: true }).click();
  await assignment.waitFor({ state: "detached" });
  let team = (await api(`/api/project-teams/${previous.id}`)).body.team;
  assert.equal(team.id, previous.id); assert.deepEqual(team.cycles, previous.cycles);
  assert.deepEqual(team.mission.budget, previous.mission.budget); assert.equal(team.definition.name, "Reusable engineering");
  assert.equal(team.scheduleEnabled, false);
  assert.equal((await api("/api/automations")).status, 200);
  assert.equal((await fetch(base + "/api/project-teams/definitions")).status, 401);
  assert.equal((await fetch(`${base}/api/project-teams/${team.id}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const beforeTask = structuredClone(team);
  let loseResponse = true;
  await page.route(`**/api/project-teams/${team.id}/tasks`, async (route) => {
    if (loseResponse) { loseResponse = false; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Give team a task", exact: true }).click();
  const taskForm = page.getByRole("form", { name: "Give team a task", exact: true });
  await taskForm.getByLabel("Task title", { exact: true }).fill("Document the empty input behavior");
  await taskForm.getByLabel("Task instructions", { exact: true }).fill("Add a short example of valid empty input.");
  await taskForm.getByLabel("Acceptance criteria, one per line", { exact: true }).fill("The example is clear and the required check passes");
  await taskForm.getByRole("button", { name: "Start assigned task", exact: true }).click();
  await taskForm.getByRole("button", { name: "Retry task request", exact: true }).click();
  await taskForm.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor({ timeout: 45000 });
  team = (await api(`/api/project-teams/${team.id}`)).body.team;
  assert.equal(team.cycles.length, beforeTask.cycles.length + 1, "retrying the lost response did not admit a second task");
  assert.deepEqual(team.cycles.at(-1).launches.map((launch: { phase: string }) => launch.phase), ["implementation"]);
  const result = team.opportunities.at(-1); assert.equal(result.origin, "owner"); assert.equal(result.status, "ready");
  assert.equal(team.cycles.at(-1).launches[0].calls, beforeTask.mission.budget.buildCalls);
  await page.getByLabel("Run recurring discovery", { exact: true }).check();
  await page.getByText("Schedule and next times", { exact: true }).click();
  await page.getByLabel("Time", { exact: true }).fill("11:45");
  await page.getByRole("button", { name: "Save schedule", exact: true }).click();
  await page.waitForFunction(async ({ base, id, token }) => {
    const response = await fetch(`${base}/api/project-teams/${id}`, { headers: { authorization: `Bearer ${token}` } });
    return (await response.json()).team.schedule?.at === "11:45";
  }, { base, id: team.id, token });
  let scheduled = (await api(`/api/project-teams/${team.id}`)).body.team;
  assert.equal(scheduled.missionRevision, team.missionRevision); assert.deepEqual(scheduled.opportunities, team.opportunities);
  assert.deepEqual(scheduled.cycles, team.cycles, "schedule edits preserve all prior usage receipts");
  const approvalResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes(`/api/project-teams/${team.id}/opportunities/`));
  await page.getByRole("button", { name: "Approve this commit", exact: true }).click();
  const approved = await approvalResponse;
  assert.equal(approved.ok(), true, await approved.text());
  await page.getByRole("button", { name: "Approve this commit", exact: true }).waitFor({ state: "detached" });
  await stopServer(); await startServer(); await page.reload();
  await page.getByText("Reusable engineering · team version 1", { exact: false }).waitFor();
  scheduled = (await api(`/api/project-teams/${team.id}`)).body.team;
  assert.equal(scheduled.opportunities.at(-1).status, "accepted"); assert.deepEqual(scheduled.cycles, team.cycles);
  assert.equal((await api("/api/project-teams/definitions")).body.definitions.length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const closeMenu = page.getByRole("button", { name: "Close menu", exact: true });
  if (await page.locator(".rail.open").count()) await closeMenu.click();
  await page.locator(".rail").waitFor({ state: "hidden" });
  const teamSection = page.getByRole("region", { name: "Project missions", exact: true });
  await teamSection.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "assignment controls fit a phone viewport");
  const teamCard = page.locator(".standing-teams > .pt-team").first();
  assert.equal(await teamCard.evaluate((element) => element.scrollWidth <= element.clientWidth), true, "repository paths and controls fit within the mobile team card");
  await teamCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  mkdirSync(join(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: join(root, "output/playwright/project-agent-team-phone.png") });
  assert.deepEqual(pageErrors, [], errors.join("\n"));
  await context.close();
});

test("orphaned mission runs offer individual and bulk deletion after project removal", async () => {
  const team = (await api("/api/project-teams")).body.teams[0];
  const ids = team.cycles.flatMap((cycle: { launches: { runId: string }[] }) => cycle.launches.map(launch => launch.runId));
  assert.ok(ids.length >= 2);
  const resultId = team.opportunities[0].result.runId;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${base}/?token=${token}#/run/${resultId}`);
  const main = page.getByRole("main");
  await main.getByText(/Project mission implementation/).waitFor();
  const removed = await fetch(`${base}/api/projects/${team.projectId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(removed.status, 200);
  await page.reload();
  await main.getByRole("button", { name: "More run actions", exact: true }).click();
  await main.getByRole("menuitem", { name: "Delete…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this run?", exact: true });
  await dialog.getByText("The mission's saved records and budget accounting are kept.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await api(`/api/runs/${resultId}`)).status, 200);

  const rail = page.getByRole("navigation", { name: "Runs", exact: true });
  await rail.getByRole("button", { name: "Run actions", exact: true }).first().click();
  const rowDelete = rail.getByRole("menuitem", { name: "Delete…", exact: true });
  assert.equal(await rowDelete.isEnabled(), true);
  await rowDelete.click();
  await page.getByRole("dialog", { name: "Delete this run?", exact: true }).getByRole("button", { name: "Delete run", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal((await Promise.all(ids.map((id: string) => api(`/api/runs/${id}`)))).filter(value => value.status === 404).length, 1);

  await rail.getByRole("button", { name: "Select runs", exact: true }).click();
  await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
  assert.equal(await rail.getByRole("button", { name: "Delete…", exact: true }).isEnabled(), true);
  await rail.getByRole("button", { name: "Delete…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Delete \d+ runs?$|^Delete run$/ }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  for (const id of ids) assert.equal((await api(`/api/runs/${id}`)).status, 404);
  const retained = (await api(`/api/project-teams/${team.id}`)).body.team;
  assert.deepEqual(retained.cycles, team.cycles);
  assert.deepEqual(retained.decisions, team.decisions);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("a stopped, settled mission run is deletable without removing its project", async () => {
  const mission = (await api("/api/project-teams")).body.teams[0].mission;
  const stoppedRepo = join(home, "stopped-repo");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, stoppedRepo]);
  const project = (await api("/api/projects", { name: "Stopped mission project", repos: [stoppedRepo] })).body;
  const created = await api("/api/project-teams", { operationId: "deletable-create", name: "Stopped discovery", projectId: project.id, repo: stoppedRepo, mission });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const draft = created.body;
  const activated = await api(`/api/project-teams/${draft.id}`, { operationId: "deletable-activate", revision: draft.revision, status: "active" });
  assert.equal(activated.status, 200);
  const admitted = (await api(`/api/project-teams/${draft.id}/cycle`, { operationId: "deletable-cycle" })).body;
  const id = admitted.cycles[0].launches[0].runId;
  await api(`/api/runs/${id}/cancel`, {});
  let team;
  for (let i = 0; i < 150; i++) {
    team = (await api(`/api/project-teams/${draft.id}`)).body.team;
    if (team.cycles[0].endedAt && team.cycles[0].launches[0].usage) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(team.cycles[0].status, "blocked");
  assert.ok(team.cycles[0].launches[0].usage);
  const context = await browser.newContext({ viewport: { width: 1115, height: 785 } });
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}#/run/${id}`);
  const row = page.locator(".rail-run-row", { has: page.locator(".run-item.active") });
  await row.getByRole("button", { name: "Run actions", exact: true }).click();
  assert.equal(await row.getByRole("menuitem", { name: "Delete…", exact: true }).isEnabled(), true);
  await row.getByRole("menuitem", { name: "Delete…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this run?", exact: true });
  await dialog.getByText("The mission's saved records and budget accounting are kept.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await api(`/api/runs/${id}`)).status, 200);
  await page.getByRole("main").getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("main").getByRole("menuitem", { name: "Delete…", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete run", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await api(`/api/runs/${id}`)).status, 404);
  assert.ok((await api("/api/projects")).body.some((item: { id: string }) => item.id === project.id));
  assert.deepEqual((await api(`/api/project-teams/${team.id}`)).body.team.cycles, team.cycles);
  await context.close();
});
