import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const live = process.env.CODEFLOW_TEST_LIVE_AGENTS === "1";
const port = await new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const p = (server.address() as { port: number }).port; server.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`, token = "task-team-e2e";
const home = mkdtempSync(join(tmpdir(), "cf-task-team-e2e-")), repo = join(home, "repo");
let server: ChildProcess, browser: Browser, page: Page;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence: unknown[] = [];
async function api(path: string, body?: unknown) { const r = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await r.json() as any; assert.ok(r.ok, JSON.stringify(value)); return value; }
async function done(id: string) { const end = Date.now() + (live ? 540000 : 90000); while (Date.now() < end) { const run = await api(`/api/runs/${id}`); if (run.status !== "running") { assert.equal(run.status, "done", run.error); return run; } await new Promise(r => setTimeout(r, 250)); } throw new Error(`Timed out: ${id}`); }
before(async () => {
  console.log("Evidence:", home);
  mkdirSync(repo); const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Disposable team transition fixture\n"); writeFileSync(join(repo, "result.txt"), "pending\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "Fixture");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, ...(live ? {} : { PATH: `${root}/test/fake-bin:${process.env.PATH}`, FAKE_ANSWER_RECOVERED: join(home, "answer-recovered") }) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; server.stdout?.on("data", c => { logs += c; writeFileSync(join(home, "server.log"), logs); }); server.stderr?.on("data", c => { logs += c; writeFileSync(join(home, "server.log"), logs); });
  for (let i = 0; i < 150; i++) { if (await fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  await page.addInitScript(() => { localStorage.setItem("pattern", "solo"); localStorage.setItem("sideOpen", "0"); });
});
after(async () => { writeFileSync(join(home, "evidence.json"), JSON.stringify(evidence, null, 2)); await browser?.close(); server?.kill("SIGTERM"); });

for (const [lead, worker] of (live ? [["claude", "codex"], ["codex", "agy"], ["agy", "claude"]] : [["claude", "codex"]]).filter(([lead]) => !process.env.CODEFLOW_TEST_TEAM_LEAD || lead === process.env.CODEFLOW_TEST_TEAM_LEAD)) test(`${lead} Agent → Team with ${worker} → Agent in the same task`, { timeout: live ? 660000 : 120000 }, async () => {
  const settings = live ? { claude: { model: "haiku" }, codex: { model: "gpt-6-luna", effort: "medium" }, agy: { model: "gemini-3.8-flash-high" } } : {};
  const first = await api("/api/runs", { repo, pattern: "solo", task: "Remember cobalt-731 for this conversation. Reply Ready cobalt-731. Do not use tools or change files.", roles: { agent: [lead] }, options: {}, trust: "standard", agentSettings: settings, loop: { maxSteps: 12, maxMinutes: 9, check: live ? `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'team cobalt-731\\n')"` : "node -e \"require('node:fs').accessSync('claude-alpha.txt')\"" } });
  await page.goto(`${base}/?token=${token}#/run/${first.id}`);
  let run = await done(first.id); const session = run.steps.find((s: any) => s.kind === "agent").sessionId, tree = run.worktrees[0];
  console.log(lead, "initial Agent reply complete", first.id);
  writeFileSync(join(tree.path, "draft.txt"), "Preserve this uncommitted draft\n");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree.path }).toString().trim();
  const main = page.locator(".runview");
  if (!live) await api("/api/team-templates", { expectedVersion: 0, template: { schemaVersion: 1, id: "saved-transition-team", version: 1, name: "Saved mixed-provider team", description: "A reusable team for this fixture", scope: "personal", autoEnabled: false, parameters: ["task"], roles: [], tasks: [], contracts: [], workflow: "auto-team", task: "{{task}}", criteria: [], preferences: { roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { maxMembers: 3 }, agentSettings: {}, roleSettings: {} } } });
  await main.getByRole("switch", { name: "AI team", exact: true }).click();
  await main.getByRole("button", { name: "Advanced", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI team setup" });
  await dialog.getByRole("switch", { name: "Enable AI team" }).check();
  await dialog.getByLabel("Team template", { exact: true }).selectOption("build-review");
  if (!live) await dialog.getByLabel("Team template", { exact: true }).selectOption("saved:saved-transition-team");
  await dialog.getByLabel("Team lead", { exact: true }).selectOption(lead!);
  for (const [id, name] of [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity CLI"]]) {
    const checkbox = dialog.getByRole("checkbox", { name: `Use ${name}`, exact: true });
    if (await checkbox.isEnabled()) await checkbox.setChecked(id === worker);
  }
  await page.screenshot({ path: join(root, `output/playwright/task-team-setup-${lead}.png`) });
  await dialog.getByRole("button", { name: "Apply team settings" }).click(); await dialog.waitFor({ state: "hidden" });
  // Model pins use the same API as the panel; no credentials or provider stubs in live runs.
  run = await api(`/api/runs/${first.id}`);
  await api(`/api/runs/${first.id}/task-team`, { ...run.taskTeam, providers: live ? [worker] : ["claude", "codex"], settings, maxCalls: 16, maxMinutes: 8 });
  await page.reload(); assert.equal(await main.getByRole("switch", { name: "AI team", exact: true }).getAttribute("aria-checked"), "true");
  await main.getByRole("textbox", { name: "Message agent", exact: true }).fill(live ? "Change result.txt to contain exactly team cobalt-731 followed by a newline. Preserve draft.txt byte for byte. This is a tiny plain text edit: one implementation worker and an independent reviewer suffice. No packages, external services or publishing. The configured node check verifies the content. Keep the other files unchanged." : "AUTO-MINIMAL implement the requested result");
  await main.getByRole("button", { name: "Send", exact: true }).click(); await page.getByRole("region", { name: "Team activity" }).waitFor();
  run = await done(first.id);
  const turn = run.teamTurns[0], child = await api(`/api/runs/${turn.executionId}`);
  writeFileSync(join(home, `${lead}-parent.json`), JSON.stringify(run, null, 2)); writeFileSync(join(home, `${lead}-team.json`), JSON.stringify(child, null, 2));
  assert.equal(child.status, "done", child.error); assert.equal(turn.state, "applied");
  assert.ok(child.steps.some((s: any) => s.kind === "agent" && s.agent === worker), "selected teammate ran");
  assert.equal(run.worktrees[0].path, tree.path); assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree.path }).toString().trim(), head);
  assert.equal(readFileSync(join(tree.path, "draft.txt"), "utf8"), "Preserve this uncommitted draft\n");
  if (live) { assert.equal(readFileSync(join(tree.path, "result.txt"), "utf8"), "team cobalt-731\n"); assert.equal(child.lastCheck?.ok, true); if (lead !== "agy") assert.equal(run.steps.filter((s: any) => s.kind === "agent").at(-1).mode, "read"); }
  assert.ok(page.url().endsWith(first.id));
  console.log(lead, "team completed with", worker, child.id);
  const activity = page.getByRole("region", { name: "Team activity" });
  assert.equal(await activity.locator("details[open]").count(), 0, "team internals stay collapsed by default");
  const workMessage = main.getByText(live ? "Change result.txt to contain exactly team cobalt-731 followed by a newline. Preserve draft.txt byte for byte. This is a tiny plain text edit: one implementation worker and an independent reviewer suffice. No packages, external services or publishing. The configured node check verifies the content. Keep the other files unchanged." : "AUTO-MINIMAL implement the requested result", { exact: true });
  assert.ok(await activity.evaluate((element, message) => !!(message.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING), await workMessage.elementHandle()), "progress belongs after the request that launched the team");
  await main.getByRole("textbox", { name: "Message agent", exact: true }).fill("What changed?");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await main.getByText("What changed?", { exact: true }).waitFor();
  run = await done(first.id); assert.equal(run.teamTurns.length, 1); assert.equal(run.taskTeam.enabled, true);
  await page.screenshot({ path: join(root, `output/playwright/team-ux-clean-${lead}.png`) });

  await main.getByRole("switch", { name: "AI team", exact: true }).click();
  await main.getByRole("textbox", { name: "Message agent", exact: true }).fill("What token did I give you? Read result.txt and draft.txt and report their contents. Answer directly without changing any files."); await main.getByRole("button", { name: "Send", exact: true }).click();
  await main.getByText("What token did I give you? Read result.txt and draft.txt and report their contents. Answer directly without changing any files.", { exact: true }).waitFor();
  run = await done(first.id); assert.equal(run.teamTurns.length, 1); assert.equal(run.taskTeam.enabled, false); if (live) assert.match(run.summary, /cobalt-731/);
  await page.screenshot({ path: join(root, `output/playwright/task-team-${lead}${live ? "-live" : ""}.png`), fullPage: true });
  evidence.push({ lead, worker, task: first.id, execution: child.id, teamStatus: child.status, check: child.lastCheck, sameWorkspace: true, unchangedHead: true, draftPreserved: true, singleAgain: true });
  const rail = page.getByRole("navigation", { name: "Runs", exact: true }); assert.equal(await rail.locator(".run-item").count(), evidence.length);
});


test("main-chat corrections update an awaiting team without exposing its execution details", { skip: live, timeout: 120000 }, async () => {
  const configuration = { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: true };
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-MINIMAL implement the fixture", roles: { agent: ["claude"] }, options: {}, trust: "standard", taskTeam: configuration });
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const awaitPlan = async (previous?: string) => {
    for (let n = 0; n < 600; n++) {
      const parent = await api(`/api/runs/${run.id}`), id = parent.teamTurns?.[0]?.executionId;
      if (id && id !== previous) { const execution = await api(`/api/runs/${id}`); if (execution.awaiting) return { parent, execution }; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Team never reached plan approval");
  };
  const before = await awaitPlan();
  const correction = "Keep the current API unchanged. Adjust the team plan accordingly.";
  const main = page.locator(".runview");
  await main.getByRole("textbox", { name: "Message agent", exact: true }).fill(correction);
  await main.getByRole("button", { name: "Send", exact: true }).click();
  const after = await awaitPlan(before.execution.id);
  assert.equal(after.parent.teamTurns.length, 1);
  assert.equal((await api(`/api/runs/${before.execution.id}`)).status, "cancelled");
  assert.match(after.execution.task, /Keep the current API unchanged/);
  await main.getByText(correction, { exact: true }).waitFor();
  await main.getByText("Added to the team request", { exact: true }).waitFor();
  assert.equal(await main.locator(".task-team-disclosure[open]").count(), 0);
  assert.equal(await main.getByText("Starting…", { exact: true }).count(), 0, "an awaiting team does not show a second starting agent");
  await page.screenshot({ path: join(root, "output/playwright/team-ux-correction.png") });
  await api(`/api/runs/${run.id}/task-team`, { ...configuration, enabled: false }); await done(run.id);
});

test("conflicting user edits open a three-way resolution dialog and verify the combined workspace", { skip: live, timeout: 120000 }, async () => {
  const configuration = { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: true };
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-MINIMAL implement the fixture", roles: { agent: ["claude"] }, options: {}, trust: "standard", taskTeam: configuration, loop: { check: "node -e \"require('node:fs').accessSync('claude-alpha.txt')\"" } });
  let parent: any, execution: any;
  for (let i = 0; i < 600; i++) { parent = await api(`/api/runs/${run.id}`); if (parent.teamTurns?.length) { execution = await api(`/api/runs/${parent.teamTurns[0].executionId}`); if (execution.awaiting) break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(execution.awaiting);
  const tree = parent.worktrees.find((tree: any) => tree.name === "solo");
  writeFileSync(join(tree.path, "claude-alpha.txt"), "My concurrent edit\n");
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  parent = await done(run.id);
  assert.deepEqual(parent.teamTurns[0].reconciliation.conflicts, ["claude-alpha.txt"]);
  assert.equal(readFileSync(join(tree.path, "claude-alpha.txt"), "utf8"), "My concurrent edit\n");
  const activity = page.getByRole("region", { name: "Team activity" }); await activity.locator("summary").click();
  await activity.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve team changes" });
  await dialog.getByText("My concurrent edit", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Edit result", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Resolved file contents" }).fill("My edit and team implementation\n");
  writeFileSync(join(tree.path, "later.txt"), "A later user edit\n");
  await dialog.getByRole("button", { name: "Apply and check", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "changed since" }).waitFor();
  await dialog.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit result", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Resolved file contents" }).fill("My edit and team implementation\n");
  await page.screenshot({ path: join(root, "output/playwright/team-conflict-resolution.png") });
  await dialog.getByRole("button", { name: "Apply and check", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  parent = await api(`/api/runs/${run.id}`);
  assert.equal(parent.teamTurns[0].state, "applied"); assert.equal(parent.teamTurns[0].resolutionCheck.ok, true);
  assert.equal(readFileSync(join(tree.path, "claude-alpha.txt"), "utf8"), "My edit and team implementation\n");
  assert.equal(readFileSync(join(tree.path, "later.txt"), "utf8"), "A later user edit\n");
});

test("inline Team answers retain the question and reply in the main chat", { skip: live, timeout: 120000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-USER-QUESTION Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 24, maxMinutes: 5, approvePlan: false } });
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const card = page.getByRole("region", { name: "The team needs your answer" }); await card.waitFor();
  assert.equal(await card.locator("textarea").count(), 1);
  await card.getByRole("textbox", { name: "Your answer" }).fill("Empty input is valid");
  const question = await card.locator(".aw-body").innerText();
  await card.getByRole("button", { name: "Send answer" }).click();
  const parent = await done(run.id), child = await api(`/api/runs/${parent.teamTurns[0].executionId}`);
  assert.equal(child.status, "done", child.error); assert.ok(parent.notes.some((note: any) => note.requestId && note.text === "Empty input is valid" && note.question?.body));
  await page.reload();
  await page.locator(".team-question-history").getByText(question, { exact: true }).waitFor();
  await page.locator(".team-question-history").getByText("Empty input is valid", { exact: true }).waitFor();
});

test("Retry reply recovers in place and shows one answer with provider failures collapsed", { skip: live, timeout: 120000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-MINIMAL AUTO-ANSWER-OUTAGE Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false } });
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  await page.getByRole("button", { name: "Retry reply", exact: true }).waitFor();
  const failed = await api(`/api/runs/${run.id}`), child = await api(`/api/runs/${failed.teamTurns[0].executionId}`);
  assert.equal(child.status, "done", child.error);
  writeFileSync(join(home, "answer-recovered"), "available");
  const resuming = page.waitForResponse(response => response.url().endsWith(`/api/runs/${run.id}/resume`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Retry reply", exact: true }).click(); assert.equal((await resuming).status(), 200); await done(run.id);
  const recovered = await api(`/api/runs/${run.id}`), after = await api(`/api/runs/${child.id}`);
  assert.equal(recovered.teamTurns.length, 1); assert.equal(after.steps.length, child.steps.length);
  await page.waitForFunction(() => !document.querySelector(".chat-recovery"));
  assert.equal(await page.locator("main .fu-answer").count(), 1);
  assert.equal(await page.locator(".task-team-activity details[open]").count(), 0);
  assert.equal(await page.locator("main .ev.error:visible").count(), 0);
  await page.screenshot({ path: join(root, "output/playwright/team-recovery-clean.png") });
});


test("new tasks expose a clear Team toggle, lead-only controls and searchable branches", { skip: live, timeout: 60000 }, async () => {
  execFileSync("git", ["branch", "feature/searchable-branch"], { cwd: repo });
  const project = await api("/api/projects", { name: "Composer fixture", repos: [repo] });
  await page.goto(`${base}/?token=${token}#/project/${project.id}/new`);
  const composer = page.locator(".composer");
  await composer.getByRole("button", { name: "Start from branch", exact: true }).click();
  const search = composer.getByRole("combobox", { name: "Search Start from branch", exact: true });
  await search.fill("searchable");
  await composer.getByRole("listbox", { name: "Start from branch", exact: true }).getByRole("option").waitFor();
  assert.equal(await composer.getByRole("listbox", { name: "Start from branch", exact: true }).getByRole("option").count(), 1);
  await search.press("Enter");
  assert.match(await composer.getByRole("button", { name: "Start from branch", exact: true }).innerText(), /feature\/searchable-branch/);
  const toggle = composer.getByRole("switch", { name: "AI team", exact: true });
  await toggle.click(); assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(await composer.locator(".task-controls .chat-controls").count(), 0);
  await composer.getByRole("button", { name: "Lead model", exact: true }).waitFor();
  await composer.getByRole("button", { name: "Advanced", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "AI team setup" });
  assert.equal(await setup.getByRole("switch", { name: "Enable AI team" }).isChecked(), true);
  await setup.getByRole("group", { name: "Team providers" }).waitFor();
  await setup.getByRole("button", { name: "Apply team settings" }).click();
  await page.screenshot({ path: join(root, "output/playwright/composer-team-clean.png") });
  await toggle.click(); assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await composer.getByRole("button", { name: "Provider", exact: true }).waitFor();
});
