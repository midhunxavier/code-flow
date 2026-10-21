// Actual paginated feeds and explicit multi-service startup, with local fixture data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-history-launch-ui-")));
const repo = join(fixture, "repo"); const home = join(fixture, "data"); const worktree = join(fixture, "worktrees", "history-125", "preview");
const records = join(fixture, "agent-records");
const token = "history-launch-ui-token"; const headers = { authorization: `Bearer ${token}` };
const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`;
let server: ChildProcess; let browser: Browser; let page: Page;
before(async () => {
  mkdirSync(join(repo, ".codeflow"), { recursive: true }); mkdirSync(join(home, "runs"), { recursive: true }); mkdirSync(records);
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' service.mjs`;
  for (const id of ["api", "web"]) {
    mkdirSync(join(repo, id));
    writeFileSync(join(repo, id, "service.mjs"), `import {createServer} from 'node:http';\nif(process.env.SERVICE_NAME==='web') { const dependency=await fetch(process.env.API_URL+'/health'); if(!dependency.ok) process.exit(8); }\ncreateServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:process.env.SERVICE_NAME,api:process.env.API_URL}));}).listen(Number(process.env.PORT),process.env.HOST,()=>console.log('ready '+process.env.SERVICE_NAME));\n`);
  }
  writeFileSync(join(repo, ".codeflow", "launch.json"), JSON.stringify({ version: 1, profiles: [{ id: "development", name: "API and web", services: [{ id: "api", command, cwd: "api", health: { path: "/health", timeoutMs: 5000 } }, { id: "web", command, cwd: "web", dependsOn: ["api"], health: { path: "/health", timeoutMs: 5000 } }] }] }));
  mkdirSync(join(repo, "private")); writeFileSync(join(repo, "private", "credentials.txt"), "POLICY_PRIVATE_CONTENT");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); git("add", "."); git("add", "-f", ".codeflow/launch.json"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  mkdirSync(join(fixture, "worktrees", "history-125"), { recursive: true }); git("worktree", "add", "-q", "--detach", worktree, "main");
  const commit = git("rev-parse", "HEAD").toString().trim(); const timestamp = Date.now() - 60000;
  for (let index = 0; index < 126; index++) {
    const id = `history-${String(index).padStart(3, "0")}`;
    const run = { id, task: index === 0 ? "Ancient needle task outside the initial history page" : index === 125 ? "Services fixture result" : `Historical fixture ${index}`, pattern: "solo", repo, baseRef: commit, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(fixture, "worktrees", id), roles: { worker: ["codex"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: index < 2 ? timestamp - 1000 : timestamp, endedAt: timestamp + 100, seen: index !== 1, archived: false, worktrees: index === 125 ? [{ name: "preview", path: worktree, branch: "" }] : [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
    if (index === 0) Object.assign(run, { verdict: "passed", roles: { worker: ["claude"] } });
    if (index === 2) Object.assign(run, { verdict: "passed", checkCantRun: { command: "test", reason: "missing dependency" } });
    writeFileSync(join(home, "runs", `${id}.jsonl`), JSON.stringify({ seq: index + 1, ts: timestamp, runId: id, type: "run", run }) + "\n");
  }
  const transcriptRun = JSON.parse(readFileSync(join(home, "runs/history-124.jsonl"), "utf8")).run;
  const transcriptStep = { id: "paged-step", kind: "agent", title: "Transcript page fixture", role: "worker", agent: "codex", mode: "write", status: "done", worktree: "", startedAt: timestamp, endedAt: timestamp + 100, finalText: "Transcript fixture complete" };
  writeFileSync(join(home, "runs/history-124.jsonl"), [
    JSON.stringify({ seq: 1000, ts: timestamp, runId: transcriptRun.id, type: "run", run: transcriptRun }),
    JSON.stringify({ seq: 1001, ts: timestamp, runId: transcriptRun.id, type: "step", step: transcriptStep }),
    ...Array.from({ length: 1200 }, (_, index) => JSON.stringify({ seq: 1002 + index, ts: timestamp, runId: transcriptRun.id, type: "agent", stepId: transcriptStep.id, event: { kind: "text", text: `TRANSCRIPT_EVENT_${index + 1}` } })),
  ].join("\n") + "\n");
  const cold = JSON.parse(readFileSync(join(home, "runs/history-000.jsonl"), "utf8")).run;
  delete cold.verdict; cold.id = "history-cold"; cold.createdAt = timestamp - 2000; cold.archived = true;
  cold.task = `Archived full detail ${"padding ".repeat(1300)}COLD_TASK_FULL_END`;
  cold.summary = `Detailed archived summary ${"evidence ".repeat(1300)}COLD_SUMMARY_FULL_END`;
  cold.steps = [{ id: "cold-step", kind: "agent", title: "Archived implementation evidence", role: "agent", agent: "claude", mode: "write", status: "done", startedAt: timestamp, endedAt: timestamp + 10, finalText: "COLD_STEP_DETAIL" }];
  writeFileSync(join(home, "runs/history-cold.jsonl"), [JSON.stringify({ seq: 500, ts: timestamp, runId: cold.id, type: "run", run: cold }), JSON.stringify({ seq: 501, ts: timestamp, runId: cold.id, type: "step", step: cold.steps[0] })].join("\n") + "\n");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_RECORD_DIR: records, FAKE_SLEEP_MS: "1000", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let healthy = false; for (let retry = 0; retry < 150; retry++) { healthy = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false); if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(healthy, "fixture server started");
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close(); server?.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
  rmSync(fixture, { recursive: true, force: true });
});

test("HTTP cursor pages preserve timestamp ties and bounded SSE keeps older attention visible", async () => {
  const first = await fetch(`${base}/api/runs?limit=100`, { headers }).then((response) => response.json());
  assert.equal(first.runs.length, 100); assert.equal(first.total, 127); assert.ok(first.nextCursor);
  const second = await fetch(`${base}/api/runs?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`, { headers }).then((response) => response.json());
  assert.equal(second.runs.length, 27); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.runs, ...second.runs].map((run) => run.id)).size, 127, "cursor ties neither skip nor repeat runs");
  assert.equal((await fetch(`${base}/api/runs?limit=100&cursor=bad-cursor`, { headers })).status, 400);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetch(`${base}/api/events?limit=100`, { headers, signal: abort.signal }); const reader = response.body!.getReader(); let source = "";
    while (!source.includes("\n\n")) { const part = await reader.read(); if (part.done) break; source += new TextDecoder().decode(part.value); }
    await reader.cancel();
    const hello = JSON.parse(source.split("\n\n")[0]!.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as { type: string; total: number; nextCursor: string; runs: { id: string }[] };
    assert.equal(hello.type, "hello"); assert.equal(hello.total, 127); assert.ok(hello.nextCursor);
    assert.equal(hello.runs.length, 101); assert.ok(hello.runs.some((run) => run.id === "history-001"), "older unseen result is in attention");
    assert.equal(hello.runs.some((run) => run.id === "history-000"), false, "older ordinary history remains paginated");
  } finally { clearTimeout(timer); abort.abort(); }
});

test("status filters search all history and project reports do not depend on loaded sidebar pages", async () => {
  const get = (path: string) => fetch(`${base}${path}`, { headers }).then(response => response.json());
  const passed = await get("/api/runs?limit=100&status=passed");
  assert.deepEqual(passed.runs.map((run: { id: string }) => run.id), ["history-000"]);
  assert.equal(passed.total, 1);
  const agent = await get("/api/runs?limit=100&agent=claude&status=passed&pattern=solo");
  assert.equal(agent.total, 1);
  assert.equal((await get("/api/runs?limit=100&repo=/missing")).total, 0);
  assert.equal((await fetch(`${base}/api/runs?limit=100&status=invalid`, { headers })).status, 400);
  const projects = await get("/api/projects");
  const project = projects.find((item: { repos: string[] }) => item.repos.includes(repo));
  assert.ok(project);
  const report = await get(`/api/projects/${project.id}/summary`);
  assert.equal(report.week.runs, 127); assert.equal(report.week.passed, 1);
  assert.equal(report.live, 126); assert.equal(report.archived, 1);
  assert.equal(report.sections.results.runs.length, 8);
  const more = await get(`/api/runs?limit=100&project=${project.id}&section=results&cursor=${encodeURIComponent(report.sections.results.nextCursor)}`);
  assert.equal(more.runs.length, 100);
  assert.equal(new Set([...report.sections.results.runs, ...more.runs].map(run => run.id)).size, 108);
  await page.goto(`${base}/#/project/${project.id}`);
  await page.getByText("1 of 127", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show 100 more", exact: true }).click();
  await page.getByText("1 of 127", { exact: true }).waitFor();
  assert.equal((await get(`/api/projects/${project.id}/summary`)).week.runs, 127);
});

test("insights polling waits for a slow request, pauses hidden and refreshes on return", async () => {
  const probeContext = await browser.newContext({ storageState: await page.context().storageState() });
  const probe = await probeContext.newPage();
  // Keep the scope stable: restoring a saved repo/project legitimately replaces the poller.
  await probe.addInitScript(() => { localStorage.removeItem("repo"); localStorage.removeItem("project"); });
  let reads = 0, release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  try {
    await probe.clock.install();
    await probe.route("**/api/stats?*", async route => { reads++; if (reads === 1) { started(); await held; } await route.continue(); });
    await probe.goto(`${base}/#/insights`);
    await firstStarted;
    await probe.clock.fastForward(45_000);
    assert.equal(reads, 1, "slow polls never overlap");
    await probe.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    const completed = probe.waitForResponse(response => new URL(response.url()).pathname === "/api/stats");
    release(); await completed;
    await probe.clock.fastForward(45_000);
    assert.equal(reads, 1, "hidden tabs do not poll");
    const resumed = probe.waitForResponse(response => new URL(response.url()).pathname === "/api/stats");
    await probe.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
    await resumed; assert.equal(reads, 2, "returning to the tab refreshes immediately");
  } finally { release?.(); await probeContext.close(); }
});

test("large transcripts page backwards and return to live history with bounded rendered rows", async () => {
  const response = await fetch(`${base}/api/runs/history-124/transcript?step=paged-step`, { headers });
  const latest = await response.json(); assert.equal(latest.events.length, 500); assert.ok(latest.before);
  await page.goto(`${base}/#/run/history-124`);
  await page.getByRole("button", { name: /^Show work/ }).click();
  const transcript = page.getByRole("group", { name: "Transcript of Transcript page fixture" });
  await transcript.getByText("TRANSCRIPT_EVENT_1200", { exact: true }).waitFor();
  assert.ok(await transcript.locator(".ev").count() <= 200);
  await transcript.getByRole("button", { name: "Earlier events", exact: true }).click();
  await transcript.getByText("Viewing earlier events", { exact: true }).waitFor();
  await transcript.getByText("TRANSCRIPT_EVENT_700", { exact: true }).waitFor();
  assert.equal(await transcript.getByText("TRANSCRIPT_EVENT_1200", { exact: true }).count(), 0);
  await transcript.getByRole("button", { name: "Latest events", exact: true }).click();
  await transcript.getByText("TRANSCRIPT_EVENT_1200", { exact: true }).waitFor();
  assert.ok(await transcript.locator(".ev").count() <= 200);
});

test("sidebar searches beyond loaded pages and loads older history without discarding visible results", async () => {
  await page.goto(base);
  const history = page.getByRole("region", { name: "Run history pages" });
  await history.getByText("101 of 127 runs loaded", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Ancient needle task/ }).count(), 0);
  const search = page.getByRole("searchbox", { name: "Search runs (press / to focus)" });
  const remoteSearch = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && new URL(response.url()).searchParams.get("q") === "Ancient needle");
  await search.fill("Ancient needle"); assert.equal((await remoteSearch).status(), 200);
  await page.getByRole("button", { name: /Ancient needle task/ }).waitFor();
  await history.getByText("1 loaded matches · 1 in history", { exact: true }).waitFor();
  await search.fill("");
  await page.getByRole("button", { name: "Load older runs", exact: true }).click();
  await history.getByText("127 of 127 runs loaded", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Load older runs", exact: true }).count(), 0);
});

test("opening a cold archived run hydrates full task and step evidence through the shared run stream", async () => {
  const found = await fetch(`${base}/api/runs?limit=100&q=COLD_TASK_FULL_END`, { headers }).then((response) => response.json());
  assert.equal(found.total, 1); assert.equal(found.runs[0].cold, true);
  assert.equal(found.runs[0].task.includes("COLD_TASK_FULL_END"), false, "history keeps only a bounded archived preview");
  await page.goto(`${base}/#/run/history-cold`);
  await page.locator(".runview .run-head h2").waitFor();
  await page.waitForFunction(() => document.querySelector(".runview .run-head h2")?.textContent?.includes("COLD_TASK_FULL_END"));
  await page.getByText("COLD_STEP_DETAIL", { exact: true }).waitFor();
  const detail = await fetch(`${base}/api/runs/history-cold`, { headers }).then((response) => response.json());
  assert.ok(detail.summary.includes("COLD_SUMMARY_FULL_END")); assert.equal(detail.steps.length, 1);
});

test("workspace starts, inspects and stops a real two-service launch profile", async () => {
  await page.goto(`${base}/#/settings/workspace`);
  await page.getByLabel("Repository or run worktree", { exact: true }).selectOption(worktree);
  await page.getByRole("button", { name: "Services", exact: true }).click();
  const panel = page.getByRole("region", { name: "Multi-service launch profiles" });
  const idle = await fetch(`${base}/api/runs/history-125/launch-profiles?worktree=preview`, { headers }).then((response) => response.json());
  assert.equal(idle.profiles?.length, 1, JSON.stringify(idle));
  await panel.getByLabel("Launch profile", { exact: true }).waitFor();
  assert.equal(idle.session, null, "viewing the profile executes no commands");
  await panel.getByText("Review 2 service commands", { exact: true }).click();
  assert.match(await panel.innerText(), /Starts after api/);
  await panel.getByRole("button", { name: "Start launch profile", exact: true }).click();
  await panel.getByText("Stack: ready", { exact: true }).waitFor({ timeout: 15000 });
  const webUrl = await panel.getByRole("link", { name: "Open web", exact: true }).getAttribute("href");
  const apiUrl = await panel.getByRole("link", { name: "Open api", exact: true }).getAttribute("href");
  assert.notEqual(webUrl, apiUrl);
  const response = await fetch(webUrl!).then((result) => result.json()); assert.equal(response.api, apiUrl);
  await panel.getByRole("article", { name: "web service" }).getByText(/Logs \(/).click();
  await panel.getByText("ready web", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Stop services", exact: true }).click();
  await panel.getByText("Stack: stopped", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("link", { name: "Open web", exact: true }).count(), 0);
});

test("project conventions save with CAS, restore a previewed version, and explicitly stage guidance for a later commit", async () => {
  await page.goto(`${base}/#/settings`);
  const tab = page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Projects", exact: true }); await tab.focus(); await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Versioned project conventions" }); const draft = panel.getByLabel("Private conventions draft", { exact: true });
  await draft.waitFor(); await draft.focus(); await page.keyboard.press("Tab"); assert.equal(await panel.getByLabel("Revision note", { exact: true }).evaluate((element) => element === document.activeElement), true, "editor labels and keyboard focus follow the document order");
  await draft.fill("Keep shared project interfaces small and tested."); await panel.getByLabel("Revision note", { exact: true }).fill("Initial shared guidance");
  await panel.getByRole("button", { name: "Save private revision", exact: true }).click(); await panel.getByText(/Saved revision 1 ·/).waitFor();
  const projectId = await page.getByLabel("Project", { exact: true }).inputValue();
  const concurrent = await fetch(`${base}/api/projects/${projectId}/conventions`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision: 1, text: "A concurrent saved convention." }) }); assert.equal(concurrent.status, 200);
  await draft.fill("Preserve my browser draft while comparing concurrent edits."); await panel.getByRole("button", { name: "Save private revision", exact: true }).click();
  await panel.getByRole("alert").getByText(/changed to revision 2/).waitFor(); assert.match(await draft.inputValue(), /Preserve my browser/);
  await panel.getByRole("button", { name: "Compare latest revision", exact: true }).click(); await panel.getByRole("heading", { name: "Latest saved revision 2", exact: true }).waitFor();
  await panel.getByRole("button", { name: "Use latest revision as base and keep my draft", exact: true }).click();
  await panel.getByRole("button", { name: "Save private revision", exact: true }).click(); await panel.getByText(/Saved revision 3 ·/).waitFor();
  await panel.getByText("Revision history (3)", { exact: true }).click(); await panel.getByLabel("Saved conventions version", { exact: true }).selectOption("1");
  await panel.getByRole("button", { name: "Preview saved revision", exact: true }).click(); await panel.getByRole("heading", { name: "Preview revision 1", exact: true }).waitFor();
  await panel.getByRole("button", { name: "Restore as new revision", exact: true }).click(); await panel.getByText(/Saved revision 4 ·/).waitFor(); assert.match(await draft.inputValue(), /^Keep shared project interfaces/);
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  await panel.getByRole("button", { name: "Inspect repository file", exact: true }).click(); await panel.getByRole("heading", { name: "Current repository file", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "convention previews fit a phone viewport");
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/conventions-mobile.png") }); }
  await panel.getByRole("button", { name: "Publish and stage file", exact: true }).click(); await panel.getByRole("status").getByText(/Revision 4 was staged/).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "status");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(git("diff", "--cached", "--name-only"), ".codeflow/conventions.md"); assert.match(readFileSync(join(repo, ".codeflow/conventions.md"), "utf8"), /^Keep shared project interfaces/);
  assert.equal(execFileSync("git", ["ls-tree", "HEAD", ".codeflow/conventions.md"], { cwd: repo, encoding: "utf8" }), "", "publication does not silently commit or activate guidance");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "activate reviewed conventions");
});

test("guided onboarding inspects required and optional dependencies through actual read-only probes", async () => {
  await page.goto(base);
  await page.getByRole("button", { name: "Agent workflow mode", exact: true }).waitFor();
  assert.equal(await page.locator(".provider-setup").count(), 0, "connected providers do not show setup in the composer");
  await page.goto(`${base}/#/settings/agents`);
  await page.getByText("Check this computer", { exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Guided dependency discovery" });
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/doctor/dependencies");
  await panel.getByRole("button", { name: "Check all dependencies", exact: true }).focus(); await page.keyboard.press("Enter");
  const result = await response; assert.equal(result.status(), 200); const report = await result.json();
  await panel.getByRole("heading", { name: "Required tools", exact: true }).waitFor();
  await panel.getByRole("heading", { name: "Optional tools", exact: true }).waitFor();
  assert.equal(report.providers.length, 3); assert.equal(report.optional.length, 3);
  for (const dependency of report.optional) await panel.getByText(dependency.name, { exact: false }).first().waitFor();
  assert.match(await panel.innerText(), /Interactive terminal/); assert.match(await panel.innerText(), /Browser snapshots/); assert.match(await panel.innerText(), /Optional Docker isolation/);
  assert.equal(await panel.getByRole("button", { name: "Check dependencies again", exact: true }).isEnabled(), true);
});

test("review inbox controls have distinct labels, keyboard order and a bounded mobile layout", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/#/inbox`);
  await page.getByRole("heading", { name: "Review inbox", exact: true }).waitFor();
  const group = page.getByRole("combobox", { name: "Group review inbox", exact: true }); const filter = page.getByRole("combobox", { name: "Filter review inbox", exact: true }); const search = page.getByRole("textbox", { name: "Search review inbox", exact: true });
  assert.equal(await group.count(), 1); assert.equal(await filter.count(), 1); assert.equal(await search.count(), 1);
  await group.focus(); await page.keyboard.press("Tab"); assert.equal(await filter.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Tab"); assert.equal(await search.evaluate((element) => element === document.activeElement), true);
  await search.fill("fixture"); await group.selectOption("reason"); await filter.selectOption("failed");
  for (const control of [group, filter, search]) { const bounds = await control.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, "review controls fit the phone viewport"); }
  assert.equal(await page.locator(".automations").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "inbox content has no horizontal overflow");
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/review-inbox-mobile.png") }); }
});

test("context directories preview committed sources and explicit budgets block actual provider launch while warnings retain input evidence", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base);
  await page.getByRole("button", { name: "Agent workflow mode", exact: true }).click(); await page.getByLabel("Task", { exact: true }).fill("Exercise the explicit context budget before a provider launch.");
  await page.locator(".taskbox").getByRole("button", { name: "Files", exact: true }).click(); await page.getByRole("button", { name: "Add api to the task", exact: true }).click();
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.locator(".composer-options > summary").click(); await page.locator(".context-inspector > summary").click(); await page.getByRole("button", { name: "Preview selected context", exact: true }).click();
  await page.locator(".context-inspection-results").getByText("api/service.mjs · committed base", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Set an explicit input budget for each provider launch", exact: true }).check();
  await page.getByLabel("Maximum explicit input bytes", { exact: true }).fill("1"); await page.getByLabel("When the explicit input exceeds this budget", { exact: true }).selectOption("block");
  const openLibrary = async () => {
    await page.evaluate(() => { location.hash = "/settings/projects"; });
    await page.getByRole("region", { name: "Project run defaults" }).waitFor();
    if (await page.getByLabel("Library scope").count()) await page.getByLabel("Library scope").selectOption("personal");
    await page.getByText("Advanced library management", { exact: true }).click();
  };
  await openLibrary();
  await page.getByLabel("Workflow name", { exact: true }).fill("Budgeted team");
  await page.getByRole("button", { name: "Save current workflow", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).waitFor();
  await page.evaluate(() => { location.hash = "/"; });
  await page.locator(".composer-options > summary").click(); await page.locator(".context-inspector > summary").click();
  await page.getByLabel("Maximum explicit input bytes", { exact: true }).fill("40000"); await page.getByLabel("When the explicit input exceeds this budget", { exact: true }).selectOption("warn");
  await openLibrary();
  await page.getByLabel("Saved workflow", { exact: true }).selectOption({ label: "Budgeted team · r1" });
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await page.getByLabel("Revision to apply", { exact: true }).selectOption("1"); await page.getByRole("button", { name: "Apply workflow", exact: true }).click();
  await page.evaluate(() => { location.hash = "/"; });
  await page.locator(".composer-options > summary").click(); await page.locator(".context-inspector > summary").click();
  assert.equal(await page.getByLabel("Maximum explicit input bytes", { exact: true }).inputValue(), "1", "applying history restores the captured input ceiling");
  assert.equal(await page.getByLabel("When the explicit input exceeds this budget", { exact: true }).inputValue(), "block");
  await page.getByText("Run details", { exact: true }).click();
  await page.locator(".effective-settings").getByText("Preset Budgeted team r1", { exact: true }).first().waitFor();
  const before = readdirSync(records).length;
  await page.getByRole("button", { name: /^Start run/ }).click(); await page.waitForURL(/#\/run\//);
  const id = decodeURIComponent(page.url().split("#/run/")[1]!);
  const read = (id: string) => fetch(`${base}/api/runs/${id}`, { headers }).then((response) => response.json()) as Promise<Run>;
  let blocked = await read(id); for (let attempt = 0; blocked.status === "running" && attempt < 600; attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); blocked = await read(id); }
  assert.deepEqual(blocked.loop.contextBudget, { maxPromptBytes: 1, policy: "block" }, "the chosen budget reaches persisted run settings");
  const blockedStep = blocked.steps.find((step) => step.contextInput?.policy === "block")!;
  assert.equal(blocked.status, "stopped"); assert.match(blocked.stopReason ?? "", /explicit invocation context budget/);
  assert.equal(blockedStep.status, "stopped"); assert.match(blockedStep.error ?? "", /context exceeds its configured budget/); assert.equal(readdirSync(records).length, before, "blocking context budgets launch no provider CLI");
  assert.equal(blocked.steps.some((step) => step.contextInput?.exceeded && step.contextInput.policy === "block" && !step.invocations), true);
  const sensitive = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ repo, pattern: "solo", task: "Reject credential context", roles: { agent: ["claude"] }, context: { paths: [{ path: ".env" }] } }) });
  assert.equal(sensitive.status, 400); assert.match((await sensitive.json()).error, /credential/);
  const started = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ repo, pattern: "solo", task: "Run with a warning budget and preserve final input-size evidence", roles: { agent: ["claude"] }, loop: { contextBudget: { maxPromptBytes: 1, policy: "warn" } } }) }); assert.equal(started.status, 201);
  const warningId = (await started.json()).id; let warning = await read(warningId); for (let attempt = 0; warning.status === "running" && attempt < 600; attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); warning = await read(warningId); }
  assert.equal(warning.status, "done", warning.error); const step = warning.steps.find((step) => step.contextInput)!; const evidence = step.contextInput!; assert.equal(evidence.policy, "warn"); assert.equal(evidence.exceeded, true); assert.equal(step.invocations, 1);
  const recording = readdirSync(records).filter((file) => file.startsWith("claude-")).map((file) => JSON.parse(readFileSync(join(records, file), "utf8"))).at(-1);
  assert.equal(evidence.promptBytes, Buffer.byteLength(recording.prompt), "size evidence measures the actual assembled text sent to the adapter");
  assert.match(evidence.hash, /^[a-f0-9]{64}$/);
});

test("filesystem policy enforces scoped app reads/writes and globally blocks execution until explicitly removed", async () => {
  const project = (await fetch(`${base}/api/projects`, { headers }).then((response) => response.json()) as { id: string; repos: string[] }[]).find((project) => project.repos.includes(repo)); assert.ok(project);
  const otherRepo = join(fixture, "other-repo"); mkdirSync(otherRepo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepo }); writeFileSync(join(otherRepo, "README.md"), "Other repository\n"); execFileSync("git", ["add", "."], { cwd: otherRepo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: otherRepo });
  await fetch(`${base}/api/projects`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Other repository", repos: [otherRepo] }) });
  const bootReady = Promise.all(["/api/models", "/api/doctor", "/api/doctor/git"].map((path) => page.waitForResponse((response) => new URL(response.url()).pathname === path)));
  await page.goto(`${base}/?policy-check=1#/settings/projects`); await bootReady; await page.getByLabel("Project", { exact: true }).selectOption(project.id); const panel = page.getByRole("region", { name: "Project filesystem policy", exact: true });
  await panel.getByLabel("Read deny paths", { exact: true }).fill("private"); await panel.getByLabel("Write allow paths", { exact: true }).fill("api"); const applying = page.waitForResponse((response) => response.url().endsWith("/filesystem-policy") && response.request().method() === "PUT"); await panel.getByRole("button", { name: "Stop execution and apply policy", exact: true }).click(); const applied = await applying; assert.equal(applied.status(), 200, await applied.text()); await panel.getByRole("status").getByText("Filesystem policy revision 1 applied.", { exact: true }).waitFor();
  const request = (path: string, body?: unknown, method = "POST") => fetch(base + path, { headers: { ...headers, "content-type": "application/json" }, ...(body !== undefined ? { method, body: JSON.stringify(body) } : {}) });
  for (const prefix of ["/api", "/api/v1"]) {
    for (const path of ["/stats", "/memory", "/automations", "/deferred-runs", "/coordinated-changes", "/notifications", "/maintenance"]) assert.equal((await request(prefix + path)).status, 403, `unscoped private data ${path}`);
    assert.equal((await request(`${prefix}/file?repo=${encodeURIComponent(repo)}&path=private/credentials.txt`)).status, 403);
    assert.equal((await request(`${prefix}/repo-config?repo=${encodeURIComponent(join(repo, "api"))}`)).status, 403, "subdirectory aliases cannot bypass repository policy");
    assert.equal((await request(`${prefix}/projects/${project.id}/summary`)).status, 403);
    assert.equal((await request(`${prefix}/runs?limit=100&status=passed`).then(response => response.json())).total, 0, "filtered totals exclude restricted history");
    assert.equal((await request(`${prefix}/runs/history-125/export?transcript=1`)).status, 403); assert.equal((await request(`${prefix}/runs/history-125/events`)).status, 403);
    for (const path of ["/runs", "/readiness", "/verification", "/shells", "/preview", "/snapshot", "/automations", "/deferred-runs", "/coordinated-changes", "/remote-workers/worker/probe", "/code-hosts/source/preview"]) { const response = await request(prefix + path, { repo: otherRepo, pattern: "solo", task: "A different repository cannot read protected host files", roles: { agent: ["claude"] }, trust: "full", execute: true }); assert.equal(response.status, 409, path); }
  }
  assert.equal((await request("/api/health").then((response) => response.json())).interactiveTerminal, false, "health does not launch an interpreter under restrictions");
  const before = readdirSync(records).length;
  const listing = await request(`/api/tree?repo=${encodeURIComponent(repo)}`).then((response) => response.json()); assert.equal(listing.entries.some((entry: { path: string }) => entry.path === "private"), false);
  const search = await request(`/api/workspace/search?repo=${encodeURIComponent(repo)}&q=POLICY_PRIVATE_CONTENT`).then((response) => response.json()); assert.deepEqual(search.hits, []);
  const file = await request(`/api/workspace/file?repo=${encodeURIComponent(repo)}&path=api/service.mjs`).then((response) => response.json()); assert.equal(typeof file.hash, "string"); assert.equal((await request("/api/workspace/file", { repo, path: "api/service.mjs", text: file.text + "\n// reviewed policy edit\n", expectedHash: file.hash })).status, 200);
  const web = await request(`/api/workspace/file?repo=${encodeURIComponent(repo)}&path=web/service.mjs`).then((response) => response.json()); assert.equal((await request("/api/workspace/file", { repo, path: "web/service.mjs", text: "forbidden", expectedHash: web.hash })).status, 403);
  assert.equal(readdirSync(records).length, before, "policy refusal invokes no agent process");
  const runs = await request("/api/runs?limit=100").then((response) => response.json()); assert.equal(runs.runs.some((run: { repo: string }) => run.repo === repo), false, "raw historical content is omitted under the restricted project");
  const saved = await request(`/api/projects/${project.id}/filesystem-policy`).then((response) => response.json()); assert.equal((await request(`/api/projects/${project.id}/filesystem-policy`, { ...saved, revision: 0 }, "PUT")).status, 409);
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/filesystem-policy-desktop.png") }); }
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
  if (process.env.CODEFLOW_UI_SCREENSHOTS) await page.screenshot({ path: join(root, "output/playwright/filesystem-policy-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByLabel("Read deny paths", { exact: true }).fill(""); await panel.getByLabel("Write allow paths", { exact: true }).fill("."); await panel.getByRole("button", { name: "Stop execution and apply policy", exact: true }).click(); await panel.getByRole("status").getByText("Filesystem policy revision 2 applied.", { exact: true }).waitFor();
  const started = await request("/api/runs", { repo: otherRepo, pattern: "solo", task: "Exercise the deliberate policy execution restart", roles: { agent: ["claude"] }, loop: { check: `"${process.execPath}" -e 'setTimeout(()=>{},5000)'` } }); assert.equal(started.status, 201); const id = (await started.json()).id;
  assert.equal((await request(`/api/runs/${id}`).then((response) => response.json())).status, "running", "the activation race exercises an actually live run");
  const busy = await request(`/api/projects/${project.id}/filesystem-policy`, { revision: 2, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }, "PUT"); assert.equal(busy.status, 409, "policy cannot activate while another project's host agent is active");
  let run = await request(`/api/runs/${id}`).then((response) => response.json()); for (let attempt = 0; run.status === "running" && attempt < 600; attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); run = await request(`/api/runs/${id}`).then((response) => response.json()); } assert.equal(run.status, "done", run.error);
});
