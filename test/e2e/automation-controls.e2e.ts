import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AutomationEvent, Trigger } from "../../src/automation.js";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "automation-controls-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, repo: string;
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
before(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-automation-controls-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Automation controls fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const ghState = join(repo, "github-fixture.json");
  await writeFile(ghState, JSON.stringify({ issues: [21, 22].map(number => ({ number, title: `Fixture issue ${number}`, body: "A controlled sweep source.", url: `https://github.com/fixture/repo/issues/${number}`, author: { login: "me" }, authorAssociation: "OWNER" })), prs: {}, comments: [], reviews: [] }));
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: await mkdtemp(join(tmpdir(), "codeflow-automation-controls-home-")), CODEFLOW_TOKEN: token, FAKE_GH_STATE: ghState, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 99 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage();
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close(); if (!server || server.exitCode !== null) return; server.kill("SIGTERM");
  await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); });
});

test("automation time zones, dry-run settings, failed events and explicit retry work in the browser", { timeout: 45_000 }, async () => {
  const run = { repo, pattern: "solo", task: "Automation controls task", baseRef: "missing-for-event-qa", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } };
  const trigger = await api<Trigger>("/api/automations", { name: "Automation QA", enabled: true, webhook: true, isolate: false, schedule: { at: "02:30", timezone: "Europe/Stockholm" }, run });
  const accepted = await fetch(`${base}/hooks/${trigger.id}`, { method: "POST", headers: { authorization: `Bearer ${trigger.token}`, "content-type": "application/json" }, body: JSON.stringify({ details: "Preserve this event on retry" }) });
  assert.equal(accepted.status, 202);
  await until(() => api<AutomationEvent[]>(`/api/automations/${trigger.id}/events`), (events) => events.some((event) => event.state === "failed"));
  await page.goto(base + "/#/settings/automations");
  const row = page.locator(".auto-row", { hasText: "Automation QA" });
  await row.getByText("Schedule and next times", { exact: true }).click();
  await row.getByLabel("Time zone", { exact: true }).fill("America/New_York");
  await row.getByRole("button", { name: "Save schedule", exact: true }).click();
  await until(() => api<Trigger[]>("/api/automations"), (triggers) => { const schedule = triggers.find((t) => t.id === trigger.id)?.schedule; return !!schedule && "at" in schedule && schedule.timezone === "America/New_York"; });
  await row.getByLabel("Next scheduled times", { exact: true }).getByText(/Next runs in America\/New_York/).waitFor();
  await row.getByRole("button", { name: "Preview and events", exact: true }).click();
  const inspector = page.getByLabel("Preview and events for Automation QA", { exact: true });
  await inspector.getByText("Dry run", { exact: true }).waitFor();
  await inspector.getByText(/Permissions: standard/).waitFor();
  await inspector.getByRole("cell", { name: "failed", exact: true }).waitFor();
  assert.match(await inspector.innerText(), /Preserve this event on retry/);
  // Repair the original failure externally, then replay the exact saved event/configuration.
  execFileSync("git", ["branch", "missing-for-event-qa", "main"], { cwd: repo });
  await inspector.getByRole("button", { name: "Retry event", exact: true }).click();
  const events = await until(() => api<AutomationEvent[]>(`/api/automations/${trigger.id}/events`), (history) => history.some((event) => event.state === "started" && event.retries === 1));
  assert.match(events[0]!.input.details!, /Preserve this event/);
  await inspector.getByText("started (1 retry)", { exact: true }).waitFor();
  assert.equal(await inspector.getByRole("button", { name: "Retry event", exact: true }).count(), 0);
});

test("a sweep configures single agents, team patterns and saved templates without losing selected PRs", { timeout: 60_000 }, async () => {
  const project = await api<{ id: string }>("/api/projects", { name: "Sweep controls", repos: [repo] });
  const template = await api<any>("/api/team-templates", { expectedVersion: 0, template: {
    schemaVersion: 1, id: "sweep-solo", version: 1, name: "Focused dependency fix", description: "A small fix with the selected review focus.", scope: "project", project: project.id, autoEnabled: false,
    workflow: "solo", parameters: ["task", "focus"], roles: [], tasks: [], contracts: [], task: "{{task}} Focus on {{focus}}.", criteria: ["Keep the tests passing."],
    preferences: { roles: { agent: ["codex"] }, options: {}, agentSettings: { codex: { model: "template-model" } }, roleSettings: { agent: { codex: { effort: "high" } } } },
  } });
  await api("/api/team-templates", { expectedVersion: 0, template: {
    schemaVersion: 1, id: "sweep-team", version: 1, name: "Dependency team", description: "Implement and verify each dependency update.", scope: "project", project: project.id, autoEnabled: false,
    parameters: ["task"], roles: ["builder"], contracts: [], task: "{{task}}", criteria: ["Keep the tests passing."],
    tasks: [{ id: "implement", title: "Repair the dependency update", role: "builder", kind: "implementation", instructions: "{{task}}", dependsOn: [], paths: ["*"], acceptance: ["CI passes."] }],
    preferences: { roles: { coordinator: ["codex"], pool: ["claude", "codex"] }, options: { maxMembers: 3 }, agentSettings: {}, roleSettings: {} },
  } });
  const context = await browser.newContext({ viewport: { width: 1414, height: 785 }, timezoneId: "America/New_York" });
  const sweepPage = await context.newPage();
  const submissions: any[] = [], errors: string[] = [];
  sweepPage.on("pageerror", error => errors.push(error.message));
  await sweepPage.addInitScript(() => {
    localStorage.setItem("sideOpen", "0");
    localStorage.setItem("roleSel", JSON.stringify({ pipeline: { planner: ["acp:opencode"], builder: ["acp:cline"], reviewer: ["acp:cline"] } }));
  });
  await sweepPage.route("**/api/agents", route => route.fulfill({ json: [
    { id: "claude", displayName: "Claude", binary: "claude", available: true },
    { id: "codex", displayName: "Codex", binary: "codex", available: true },
    { id: "acp:opencode", displayName: "OpenCode", binary: "opencode", available: true },
    { id: "acp:cline", displayName: "Cline", binary: "cline", available: true },
  ] }));
  await sweepPage.route("**/api/github/sweep?*", route => route.fulfill({ json: { kind: "dependabot", notices: [], items: [
    { key: "pr#254", ref: "#254", title: "Bump a dependency with failing CI", detail: "CI failing · dependabot/update", url: "https://github.com/example/fixture/pull/254", selected: true, task: "Make CI pass on Dependabot's pull request #254.", source: { kind: "pr", number: 254, ciLogs: true } },
    { key: "pr#253", ref: "#253", title: "Bump a dependency with green CI", detail: "CI green · dependabot/green", note: "CI passes — no repair needed", blockedReason: "CI passes — no repair needed", url: "https://github.com/example/fixture/pull/253", selected: false, task: "Make CI pass on Dependabot's pull request #253.", source: { kind: "pr", number: 253, ciLogs: true } },
  ] } }));
  await sweepPage.route("**/api/sweeps", async route => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: { started: [{ key: "pr#254", id: "sweep-test-run" }], skipped: [], failed: [] } });
  });
  try {
    await sweepPage.goto(`${base}/?token=${token}#/project/${project.id}/automation/backlog`);
    await sweepPage.getByRole("button", { name: "Fix Dependabot PRs", exact: true }).click();
    const dialog = sweepPage.getByRole("dialog", { name: "Fix Dependabot PRs", exact: true });
    const failing = dialog.getByRole("checkbox", { name: /#254/ }), green = dialog.getByRole("checkbox", { name: /#253/ });
    await failing.waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Run with", exact: true }).inputValue(), "fix-review");
    assert.equal(await dialog.getByRole("combobox", { name: "Planner", exact: true }).count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), true);
    await dialog.getByRole("button", { name: "All 2", exact: true }).click();
    assert.equal(await failing.isChecked(), true); assert.equal(await green.isChecked(), false);
    assert.equal(await green.isDisabled(), true);
    await dialog.getByRole("button", { name: "Select shown", exact: true }).click();
    assert.equal(await green.isChecked(), false, "select all never repairs a green PR");
    await dialog.getByRole("combobox", { name: "Run with", exact: true }).selectOption("pipeline");
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), false);
    await dialog.getByRole("button", { name: "Change the team", exact: true }).click();
    assert.equal(await dialog.isVisible(), true, "editing the team keeps the sweep open");
    assert.equal(await dialog.getByRole("combobox", { name: "Planner", exact: true }).inputValue(), "acp:opencode");
    for (const [role, provider] of [["Planner", "claude"], ["Builder", "codex"], ["Reviewer", "claude"]]) await dialog.getByRole("combobox", { name: role, exact: true }).selectOption(provider!);
    await dialog.getByRole("textbox", { name: "Done when", exact: true }).fill("true");
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), true);
    assert.equal(await failing.isChecked(), true, "PR selections survive team edits");
    assert.equal(await green.isChecked(), false, "green PRs stay unselected");
    const workflow = dialog.getByRole("combobox", { name: "Run with", exact: true });
    await workflow.selectOption("solo");
    await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
    assert.equal(await dialog.getByRole("combobox", { name: "Planner", exact: true }).count(), 0);
    assert.equal(await failing.isChecked(), true);
    await workflow.selectOption("race");
    const contestants = dialog.getByRole("group", { name: "Contestants providers", exact: true });
    for (const name of ["Claude", "Codex"]) { const choice = contestants.getByRole("button", { name, exact: true }); if (await choice.getAttribute("aria-pressed") !== "true") await choice.click(); }
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), true);
    await contestants.getByRole("button", { name: "Codex", exact: true }).click();
    await dialog.getByRole("status").filter({ hasText: "at least two contestants" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), false);
    await workflow.selectOption("pipeline");
    await mkdir(join(root, "output/playwright"), { recursive: true });
    for (const width of [1414, 390]) {
      await sweepPage.setViewportSize({ width, height: 785 });
      await dialog.getByRole("combobox", { name: "Planner", exact: true }).scrollIntoViewIfNeeded();
      await sweepPage.addScriptTag({ content: axe.source });
      const violations = await sweepPage.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }).then(result => result.violations));
      assert.deepEqual(violations, []);
      const start = await dialog.getByRole("button", { name: "Start 1 run", exact: true }).boundingBox();
      assert.ok(start && start.y >= 0 && start.y + start.height <= 785, "Start remains in the visible footer");
      assert.equal(await sweepPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, "the dialog fits without clipping its text");
      await sweepPage.screenshot({ path: join(root, `output/playwright/sweep-setup-${width}.png`) });
    }
    await failing.uncheck();
    await dialog.getByRole("status").filter({ hasText: "No PRs selected" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Start 0 runs", exact: true }).isEnabled(), false);
    await failing.check();
    await dialog.getByRole("button", { name: "Start 1 run", exact: true }).click();
    await sweepPage.waitForURL(/#\/inbox$/);
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].run.roles, { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(submissions[0].run.project, project.id); assert.equal(submissions[0].run.repo, repo);
    assert.equal(submissions[0].run.loop.check, "true"); assert.equal(submissions[0].run.trust, "standard");
    assert.deepEqual(submissions[0].items.map((item: { key: string }) => item.key), ["pr#254"]);
    assert.equal(submissions[0].schedule, undefined); assert.deepEqual(errors, []);
    await sweepPage.setViewportSize({ width: 1414, height: 785 });
    for (const selection of ["solo", "template:sweep-solo", "template:sweep-team"]) {
      await sweepPage.goto(`${base}/#/project/${project.id}/automation/backlog`);
      await sweepPage.getByRole("button", { name: "Fix Dependabot PRs", exact: true }).click();
      await failing.waitFor();
      await dialog.getByRole("button", { name: "All 2", exact: true }).click();
      await dialog.locator("summary").filter({ hasText: "Configure agents and checks" }).click();
      if (selection.startsWith("template:")) await workflow.locator(`option[value="${selection}"]`).waitFor({ state: "attached" });
      await workflow.selectOption(selection);
      await dialog.getByRole("textbox", { name: "Done when", exact: true }).fill("true");
      if (selection === "solo") await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
      if (selection === "template:sweep-solo") {
        assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), false, "required template inputs block start");
        await dialog.getByRole("textbox", { name: "focus", exact: true }).fill("API compatibility");
        assert.equal(await dialog.getByRole("combobox", { name: "Agent", exact: true }).inputValue(), "codex");
        await dialog.getByRole("checkbox", { name: /Also check every day/ }).check();
        await dialog.getByLabel("Time of day", { exact: true }).fill("08:30");
      }
      if (selection === "template:sweep-team") {
        assert.equal(await dialog.getByRole("combobox", { name: "Coordinator", exact: true }).inputValue(), "codex");
        await dialog.getByRole("group", { name: "Available providers providers", exact: true }).waitFor();
      }
      assert.equal(await failing.isChecked(), true); assert.equal(await green.isChecked(), false);
      assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isEnabled(), true);
      await workflow.scrollIntoViewIfNeeded();
      await sweepPage.screenshot({ path: join(root, `output/playwright/sweep-workflow-${selection.replace(":", "-")}.png`) });
      await dialog.getByRole("button", { name: "Start 1 run", exact: true }).click(); await sweepPage.waitForURL(/#\/inbox$/);
      const submitted = submissions.at(-1);
      assert.equal(submitted.run.pattern, selection === "template:sweep-team" ? "auto-team" : "solo");
      assert.equal(submitted.run.project, project.id); assert.equal(submitted.run.repo, repo); assert.equal(submitted.run.trust, "standard");
      assert.deepEqual(submitted.items.map((item: { key: string }) => item.key), ["pr#254"]);
      if (selection === "solo") { assert.deepEqual(submitted.run.roles, { agent: ["codex"] }); assert.equal(submitted.run.templateRef, undefined); }
      if (selection === "template:sweep-solo") {
        assert.equal(submitted.run.templateRef.id, template.id); assert.equal(submitted.run.templateRef.version, template.version);
        assert.equal(submitted.run.templateRef.inputs.focus, "API compatibility"); assert.match(submitted.run.templateRef.inputs.task, /Dependabot pull request/);
        assert.equal(submitted.run.agentSettings.codex.model, "template-model"); assert.equal(submitted.run.roleSettings.agent.codex.effort, "high");
        assert.deepEqual(submitted.schedule, { at: "08:30", timezone: "America/New_York" }, "the daily time is in the browser's zone, as the dialog says");
      }
      if (selection === "template:sweep-team") { assert.equal(submitted.run.templateRef.id, "sweep-team"); assert.deepEqual(submitted.run.roles.pool, ["claude", "codex"]); assert.equal(submitted.run.options.maxMembers, 3); }
    }
    assert.equal(submissions.length, 4); assert.deepEqual(errors, []);
    // Exercise the real sweep endpoint with fake providers, including its saved recurring run.
    const runSetup = submissions[2].run;
    const outcome = await api<any>("/api/sweeps", { kind: "issues", name: "Templated fixture sweep", run: { ...runSetup, loop: { ...runSetup.loop, setup: "true", prove: false, maxSteps: 4, maxMinutes: 1 } }, schedule: { at: "08:30" }, items: [21, 22].map(number => ({ key: `issue#${number}`, task: `Fix fixture issue ${number}.`, source: { kind: "issue", number } })) });
    assert.equal(outcome.failed.length, 0, JSON.stringify(outcome)); assert.equal(outcome.started.length, 2);
    for (const started of outcome.started) {
      const run = await api<any>(`/api/runs/${started.id}`);
      assert.equal(run.pattern, "solo"); assert.equal(run.project, project.id); assert.deepEqual(run.roles.agent, ["codex"]);
      assert.equal(run.teamTemplate.template.id, template.id); assert.equal(run.teamTemplate.template.version, template.version);
      assert.equal(run.teamTemplate.inputs.focus, "API compatibility");
      assert.match(run.task, new RegExp(`Fix fixture issue ${run.source.number}`)); assert.match(run.task, /Selected template: Focused dependency fix/);
    }
    const recurring = (await api<any[]>("/api/automations")).find(entry => entry.id === outcome.automation);
    assert.equal(recurring.run.pattern, "solo"); assert.deepEqual(recurring.run.templateRef, runSetup.templateRef);
  } finally { await context.close(); }
});


test("issue repairs use the focused workflow and keep partial failures visible for retry", { timeout: 45_000 }, async () => {
  const project = await api<any>("/api/projects", { name: "Issue repair UX", repos: [repo] });
  const context = await browser.newContext({ viewport: { width: 1414, height: 823 }, recordVideo: { dir: join(root, "output/playwright/github-repair-recordings"), size: { width: 1414, height: 823 } } });
  const repairPage = await context.newPage();
  const submitted: any[] = [];
  await repairPage.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
  await repairPage.route("**/api/github/sweep?*", route => route.fulfill({ json: { kind: "issues", notices: [], items: [
    ...[21, 22].map(number => ({ key: `issue#${number}`, ref: `#${number}`, title: `Repair issue ${number}`, detail: "bug", url: `https://github.com/fixture/repo/issues/${number}`, selected: true, task: `Fix issue #${number}.`, source: { kind: "issue", number } })),
    { key: "issue#23", ref: "#23", title: "Needs more detail", detail: "question", url: "https://github.com/fixture/repo/issues/23", selected: false, note: "Labelled question", task: "Investigate issue #23.", source: { kind: "issue", number: 23 } },
    { key: "issue#24", ref: "#24", title: "Already being fixed", detail: "bug", url: "https://github.com/fixture/repo/issues/24", selected: false, note: "A run is working on it", blockedReason: "A run is working on it", existingRun: "existing-issue-run", task: "Fix issue #24.", source: { kind: "issue", number: 24 } },
  ] } }));
  await repairPage.route("**/api/sweeps", async route => {
    submitted.push(route.request().postDataJSON());
    await route.fulfill({ json: submitted.length === 1 ? { started: [{ key: "issue#21", id: "repair-21" }], failed: [{ key: "issue#22", error: "Provider unavailable" }], skipped: [] } : { started: [{ key: "issue#22", id: "repair-22" }], failed: [], skipped: [] } });
  });
  try {
    await repairPage.goto(`${base}/?token=${token}#/project/${project.id}/automation/backlog`);
    await repairPage.getByRole("button", { name: "Fix open issues", exact: true }).click();
    const dialog = repairPage.getByRole("dialog", { name: "Fix open issues", exact: true });
    await dialog.getByRole("button", { name: "Needs work 2", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Run with", exact: true }).inputValue(), "fix-review");
    assert.equal(await dialog.locator(".sweep-config").evaluate(element => (element as HTMLDetailsElement).open), false);
    assert.equal(await dialog.getByRole("checkbox", { name: /#23/ }).count(), 0, "questions do not clutter the default repair queue");
    await dialog.getByRole("button", { name: "All 4", exact: true }).click();
    assert.equal(await dialog.getByRole("checkbox", { name: /#24/ }).isDisabled(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: /#23/ }).isChecked(), false);
    await dialog.getByRole("button", { name: "Needs work 2", exact: true }).click();
    for (const width of [1414, 390]) {
      await repairPage.setViewportSize({ width, height: 823 });
      await repairPage.addScriptTag({ content: axe.source });
      const violations = await repairPage.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }).then(result => result.violations));
      assert.deepEqual(violations, []);
      const button = await dialog.getByRole("button", { name: "Start 2 runs", exact: true }).boundingBox();
      assert.ok(button && button.y >= 0 && button.y + button.height <= 823);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await repairPage.screenshot({ path: join(root, `output/playwright/github-repair-${width}.png`) });
    }
    await dialog.getByRole("button", { name: "Start 2 runs", exact: true }).click();
    await dialog.getByText("issue#22: Provider unavailable", { exact: true }).waitFor();
    assert.equal(submitted[0].run.pattern, "fix-review");
    assert.deepEqual(Object.keys(submitted[0].run.roles).sort(), ["builder", "reviewer"]);
    assert.equal(await dialog.getByRole("checkbox", { name: /#21/ }).isDisabled(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: /#22/ }).isChecked(), true);
    await dialog.getByRole("button", { name: "Retry 1 run", exact: true }).click();
    await repairPage.waitForURL(/#\/inbox$/);
    assert.deepEqual(submitted[1].items.map((item: any) => item.key), ["issue#22"]);
    assert.equal(submitted.length, 2);
  } finally { await context.close(); await repairPage.video()?.saveAs(join(root, "output/playwright/github-issue-repair.webm")); }
});
