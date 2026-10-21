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
const port = await freePort(), base = `http://localhost:${port}`, token = "standing-team-e2e-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-standing-e2e-")), repo = join(home, "repo");
let server: ChildProcess, browser: Browser;
const errors: string[] = [];
const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
async function startServer() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(await freePort()), CODEFLOW_HOME: join(home, "data"), CODEFLOW_TOKEN: token, CODEFLOW_SCHEDULER_TICK_MS: "250", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
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
    const response = await route.fetch(), catalogs = await response.json();
    catalogs.claude.models = [{ id: "standing-free", label: "Standing model (free)", efforts: ["low", "high"] }];
    await route.fulfill({ response, json: catalogs });
  });
  await page.goto(`${base}/?token=${token}#/project/${id}/automation/missions`);
  assert.equal((await api("/api/project-teams/settings")).body.enabled, false);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create a mission", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "Enable project missions", exact: true }).click();
  await page.getByRole("button", { name: "Disable project missions", exact: true }).waitFor();
  assert.equal((await api("/api/project-teams/settings")).body.enabled, true);
  await stopServer(); await startServer(); await page.reload();
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
  await page.getByRole("button", { name: "Claude Code model", exact: true }).click();
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
  assert.match((await deletion.json()).error, /Standing project teams retain/);
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
  await tab.getByRole("main").getByText(/Standing team implementation/).waitFor();
  assert.equal(await tab.getByRole("main").getByRole("button", { name: "Delete…", exact: true }).count(), 0);
  const rail = tab.getByRole("navigation", { name: "Runs", exact: true });
  await rail.getByRole("button", { name: "Select runs", exact: true }).click();
  await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
  assert.equal(await rail.getByRole("button", { name: "Delete…", exact: true }).isEnabled(), false);
  assert.equal(await rail.getByRole("button", { name: "Archive", exact: true }).isEnabled(), true);
  const stale = await api(`/api/project-teams/${team.id}`, { operationId: "stale", revision: 1, status: "paused" }); assert.equal(stale.status, 409);
  const injection = await api("/api/runs", { projectTeam: { teamId: team.id }, pattern: "auto-team", repo, task: "bypass" }); assert.equal(injection.status, 400);
  assert.deepEqual(pageErrors, [], errors.join("\n"));
  await context.close();
});
