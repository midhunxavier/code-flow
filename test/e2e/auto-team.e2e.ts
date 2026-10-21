// The default dynamic Auto experience, using actual server orchestration and deterministic CLIs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = await new Promise<number>((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});
const base = `http://localhost:${port}`;
const token = "auto-team-e2e-token";
const headers = { authorization: `Bearer ${token}` };
let server: ChildProcess;
let browser: Browser;
let page: Page;
let repo: string;

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-auto-ui-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "auto-ui", private: true, scripts: { test: "node check.mjs" } }));
  writeFileSync(join(repo, "check.mjs"), 'import { readdirSync } from "node:fs"; process.exit(readdirSync(".").some((name) => name.startsWith("claude-") && name.endsWith(".txt")) ? 0 : 1);\n');
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-auto-ui-home-")), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: process.env.E2E_DEBUG ? "inherit" : "ignore",
  });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    healthy = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false);
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, "test server started");
  const project = await fetch(`${base}/api/projects`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Auto team", repos: [repo] }) });
  assert.equal(project.status, 201);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.addInitScript((path) => {
    localStorage.setItem("repo", path);
    localStorage.setItem("sideOpen", "0");
  }, repo);
});

after(async () => { await browser?.close(); server?.kill("SIGTERM"); });

test("Auto is the fresh default, Solo is direct, and Advanced templates survive reload and version edits", { timeout: 45_000 }, async () => {
  const context = await browser.newContext();
  const fresh = await context.newPage();
  try {
    await fresh.goto(`${base}/?token=${token}`);
    const auto = fresh.getByRole("button", { name: "Auto", exact: true });
    const solo = fresh.getByRole("button", { name: "Solo", exact: true });
    await auto.waitFor();
    assert.equal(await auto.getAttribute("aria-pressed"), "true");
    assert.equal(await fresh.getByLabel("Workflow", { exact: true }).isVisible(), false);
    await solo.click();
    await fresh.reload();
    assert.equal(await solo.getAttribute("aria-pressed"), "true", "explicit mode survives reload");
    await auto.click();
    await fresh.getByRole("button", { name: "Advanced", exact: true }).click();
    const modelPanel = fresh.getByRole("region", { name: "Automatic worker models" });
    await modelPanel.getByRole("button", { name: "Refresh model catalog" }).waitFor();
    await modelPanel.getByRole("button", { name: "Refresh model catalog" }).click();
    await modelPanel.getByText(/claude · current/).waitFor();
    const catalog = await fetch(`${base}/api/model-catalog`, { headers }).then(r=>r.json()) as any;
    assert.equal(catalog.allowResearch, false);
    assert.ok(catalog.providers.find((p:any)=>p.provider==="codex").catalog.models.some((m:any)=>m.id==="gpt-a"));
    assert.match(catalog.providers.find((p:any)=>p.provider==="agy").blockedReason,/native-delegation/);
    assert.equal((await fetch(`${base}/api/model-catalog`, {method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({permissions:"full"})})).status,400);
    const library = fresh.getByRole("region", { name: "Reusable team templates" });
    await library.getByRole("button", { name: "Design a template", exact: true }).click();
    await library.getByLabel("Name", { exact: true }).fill("Reusable sample strategy");
    await library.getByRole("checkbox", { name: "Allow Auto to reuse this strategy" }).check();
    const definition = JSON.parse(await library.getByLabel("Template definition").inputValue());
    // Keep the catalog local to this fixture so the following run tests stay deterministic.
    await library.getByRole("checkbox", { name: "Allow Auto to reuse this strategy" }).uncheck();
    await library.getByRole("button", { name: "Publish template version" }).click();
    await fresh.getByText("Saved Reusable sample strategy v1", { exact: true }).waitFor();
    await library.getByRole("button", { name: "Close editor" }).click();
    await library.getByLabel("task", { exact: true }).fill("Implement sample behavior");
    await library.getByRole("button", { name: "Use this template" }).click();
    await fresh.reload();
    const pinned = await fresh.evaluate(() => JSON.parse(localStorage.getItem("selectedTeamTemplate") || "null"));
    assert.equal(pinned.template.id, definition.id);
    assert.equal(pinned.template.version, 1);
    assert.equal(pinned.inputs.task, "Implement sample behavior");
    assert.equal(await auto.getAttribute("aria-pressed"), "true");
    await fresh.getByRole("button", { name: "Advanced", exact: true }).click();
    await library.getByLabel("Saved templates").selectOption(definition.id);
    await library.getByRole("button", { name: "Edit new version" }).click();
    await library.getByLabel("Name", { exact: true }).fill("Revised strategy");
    await library.getByRole("button", { name: "Publish template version" }).click();
    await fresh.getByText("Saved Revised strategy v2", { exact: true }).waitFor();
    const versions = await fetch(`${base}/api/team-templates?history=1`, { headers }).then(r => r.json());
    assert.deepEqual(versions.templates.filter((t: any) => t.id === definition.id).map((t: any) => t.version), [1, 2]);
    assert.equal(await fresh.evaluate(() => JSON.parse(localStorage.getItem("selectedTeamTemplate")!).template.version), 1, "editing the library cannot silently update a selected run template");
    await solo.click();
    assert.equal(await fresh.evaluate(() => localStorage.getItem("selectedTeamTemplate")), null);
  } finally { await context.close(); }
});

test("Auto team approval, addressed question, distinct members, and verified coverage work in the UI", { timeout: 120_000 }, async () => {
  await page.goto(`${base}/?token=${token}`);
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await page.locator(".composer-options > summary").click();
  const approval = page.getByRole("checkbox", { name: /Let me approve the team and plan/ });
  assert.equal(await approval.isChecked(), true, "Auto plans start with approval enabled");
  await page.getByLabel("Task", { exact: true }).fill("AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample");
  // Wait for repository autodetection to settle before editing its controlled input. Filling
  // while the asynchronous default arrives can append input to the newly inserted value.
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#checkCmd")?.value === "npm test");
  await page.locator("#checkCmd").fill("npm test");
  assert.equal(await page.locator("#checkCmd").inputValue(), "npm test");
  await page.getByRole("button", { name: /^Start run/ }).click();
  await page.waitForURL(/#\/run\//);
  const runId = page.url().split("#/run/")[1]!;
  const read = () => fetch(`${base}/api/runs/${runId}`, { headers }).then((response) => response.json()) as Promise<Run>;
  await page.locator(".awaiting-card").getByText("Approve Auto team", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".auto-team .at-member").count(), 4);
  assert.match(await page.getByLabel("Coordination usage").innerText(), /1 coordinator calls \(lifetime\)/);
  await page.getByPlaceholder(/What should change/).fill("Keep the implementation and test assignments separate.");
  await page.getByRole("button", { name: "Ask for changes" }).click();
  await page.locator(".awaiting-card").getByText("Approve Auto team revision 1", { exact: true }).waitFor({ timeout: 30_000 });
  const beforeEdit = await read();
  const editedTask = beforeEdit.team!.tasks.find((task) => task.kind === "implementation")!;
  await page.getByRole("button", { name: "Edit pending plan", exact: true }).click();
  await page.getByLabel(`Title for ${editedTask.id}`, { exact: true }).fill("Human-edited implementation assignment");
  await page.getByLabel(`Instructions for ${editedTask.id}`, { exact: true }).fill(`${editedTask.instructions}\nPreserve the requested behavior and add focused tests.`);
  await page.getByRole("button", { name: "Save plan changes", exact: true }).click();
  await page.locator("dialog.team-plan-editor").waitFor({ state: "detached" });
  await page.locator(".awaiting-card").getByText(/Human-edited implementation assignment/).waitFor();
  const afterEdit = await read();
  assert.equal(afterEdit.team!.revision, beforeEdit.team!.revision + 1);
  assert.equal(afterEdit.team!.tasks.find((task) => task.id === editedTask.id)!.title, "Human-edited implementation assignment");
  assert.equal(afterEdit.team!.status, "awaiting_approval", "saving a user edit preserves the approval gate");
  await page.getByText(/Workflow graph and timing/).click();
  await page.getByRole("img", { name: /Workflow dependencies/ }).waitFor();
  await page.locator("main .convo select").selectOption("member:builder-two");
  await page.locator("main .convo textarea").fill("Use the accepted alpha contract in the dependent component.");
  await page.locator("main .convo textarea").press("Enter");
  await page.locator(".note-chip", { hasText: "Queued for builder-two" }).waitFor();
  await page.getByRole("button", { name: "✓ Approve", exact: true }).click();
  await page.getByPlaceholder("Your answer…").waitFor({ timeout: 30_000 });
  // Start typing before the scheduler moves the question into the attention card.
  await page.getByPlaceholder("Your answer…").fill("Empty input is valid; add a test.");
  await page.locator(".rail .run-item.active").getByText("Waiting for you").first().waitFor({ state: "attached", timeout: 30_000 });
  await page.locator("#run-question textarea").waitFor();
  assert.equal(await page.locator("#run-question textarea").inputValue(), "Empty input is valid; add a test.", "moving the question preserves the answer draft");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page.locator(".auto-team .at-head .badge").getByText("Finished", { exact: true }).waitFor({ timeout: 40_000 }).catch(async (error: Error) => { const run = await read(); throw new Error(`${error.message}\n${JSON.stringify({ status: run.status, error: run.error, gaps: run.team?.gaps, verification: run.team?.verification })}`); });
  // Team verification finishes before the engine records its artifacts and ends the run.
  await page.getByRole("button", { name: "More run actions", exact: true }).waitFor({ timeout: 30_000 });
  const run = await read();
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.verification?.approved, true, JSON.stringify(run.team?.gaps));
  const workers = run.team!.members.filter((member) => member.role === "worker");
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.provider, workers[1]!.provider);
  assert.notEqual(workers[0]!.id, workers[1]!.id);
  const directed = run.notes.find((note) => note.memberId === "builder-two");
  assert.equal(directed?.status, "delivered");
  assert.equal(run.steps.find((step) => step.id === directed?.deliveredTo?.stepId)?.memberId, "builder-two", "same-provider steering reaches only the named member");
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("main .convo select")?.value === "team");
  assert.equal(await page.locator(".at-coverage .badge.ok").count(), run.team!.requirements.length);
  assert.equal(run.team!.messages.find((message) => message.recipient === "user")?.status, "answered");
  await page.getByLabel("Member inbox", { exact: true }).selectOption("user");
  assert.equal(await page.locator(".at-message").count(), 1);
  await page.getByLabel("Member inbox", { exact: true }).selectOption("all");
  await page.getByText("Coordination and recovery measurements", { exact: true }).click();
  await page.getByText(/Peer questions:/).waitFor();
  await page.getByText("Agent collaboration capabilities", { exact: true }).click();
  await page.locator(".auto-team .ins-table").getByText("Member tools", { exact: true }).waitFor();

  // The inspector is usable from the completed result, including explicit project guidance.
  await page.locator(".project-memory > summary").click();
  await page.getByRole("button", { name: "Add project knowledge", exact: true }).click();
  await page.getByLabel("Memory title", { exact: true }).fill("Testing convention");
  await page.getByLabel("Memory knowledge", { exact: true }).fill("Run npm test before accepting implementation work.");
  await page.getByLabel("Where memory applies", { exact: true }).selectOption("branch");
  await page.getByLabel("Memory branch", { exact: true }).fill("feature");
  await page.getByRole("button", { name: "Save knowledge", exact: true }).click();
  const memory = page.locator(".memory-card", { hasText: "Testing convention" });
  await memory.getByText("Accepted", { exact: true }).waitFor();
  await memory.getByText("Origin and evidence", { exact: true }).click();
  assert.match(await memory.innerText(), /User-authored/);
  await memory.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await memory.getByLabel("Where memory applies", { exact: true }).inputValue(), "branch", "editing preserves branch applicability");
  await memory.getByLabel("Where memory applies", { exact: true }).selectOption("repository");
  await memory.getByLabel("Memory knowledge", { exact: true }).fill("Run npm test and inspect the final diff.");
  await memory.getByRole("button", { name: "Save knowledge", exact: true }).click();
  await memory.getByText("Run npm test and inspect the final diff.", { exact: true }).waitFor();
  assert.match(await memory.innerText(), /This repository/);
  await memory.getByText("Rate this knowledge", { exact: true }).click();
  await memory.getByLabel(/Memory usefulness/).selectOption("stale");
  await memory.getByLabel(/Memory feedback/).fill("The repository now uses another check.");
  await memory.getByRole("button", { name: "Save memory feedback", exact: true }).click();
  await memory.getByText(/Feedback on this revision: stale/).waitFor();
  // Deletion is irreversible, so it takes a second, inline confirmation.
  await memory.getByRole("button", { name: "Delete…", exact: true }).click();
  await memory.getByRole("button", { name: "Delete", exact: true }).click();
  await memory.waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "team and memory cards fit a narrow screen");
  if (process.env.E2E_SCREENSHOT) {
    await page.locator(".auto-team").evaluate((element) => { const scroller = element.closest(".run-scroll")!; scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top; });
    await page.screenshot({ path: process.env.E2E_SCREENSHOT });
  }
  await page.setViewportSize({ width: 1280, height: 960 });

  // A new team allocation keeps the verified result and exposes its actual launch budget.
  await page.locator(".followup-budget > summary").click();
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("1");
  await page.getByLabel("Reply", { exact: true }).fill("Keep the completed behavior and add documentation.");
  assert.equal(await page.locator("main .convo").getByRole("button", { name: "Send", exact: true }).isDisabled(), true, "a rebuilt Auto team reserves planning and review calls");
  const directTarget = await page.locator("main .convo select option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value.includes("@")));
  assert.ok(directTarget, "the completed worker can receive a direct reply");
  await page.locator("main .convo select").selectOption(directTarget);
  assert.equal(await page.locator("main .convo").getByRole("button", { name: "Send", exact: true }).isDisabled(), false, "a direct reply permits one call");
  await page.locator("main .convo select").selectOption("team");
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("12");
  await page.getByLabel("Follow-up maximum minutes", { exact: true }).fill("3");
  await page.locator("main .convo").getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL((url) => url.hash.startsWith("#/run/") && !url.hash.endsWith(runId));
  const followupId = page.url().split("#/run/")[1]!;
  const followup = await fetch(`${base}/api/runs/${followupId}`, { headers }).then((response) => response.json()) as Run;
  assert.equal(followup.parentRunId, runId);
  assert.equal(followup.loop.maxSteps, 12);
  assert.equal(followup.loop.maxInvocations, 12);
  assert.equal(followup.loop.maxMinutes, 3);
  assert.equal(followup.baseRef, run.team!.verification!.head);
  await fetch(`${base}/api/runs/${followupId}/cancel`, { method: "POST", headers });

  await page.goto(`${base}/?token=${token}`);
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await page.locator(".composer-options > summary").click();
  await page.getByRole("checkbox", { name: /Let me approve the team and plan/ }).uncheck();
  await page.reload();
  await page.locator(".composer-options > summary").click();
  assert.equal(await page.getByRole("checkbox", { name: /Let me approve the team and plan/ }).isChecked(), false, "explicit approval preference persists");
});

test("evaluation UI records an explicit experimental decision and cannot promote missing evidence", { timeout: 30_000 }, async () => {
  await page.goto(`${base}/#/settings/insights`);
  const evaluations = page.getByLabel("Team evaluations", { exact: true });
  await evaluations.getByText("Rollout decision and requirements", { exact: true }).click();
  await evaluations.getByLabel("Auto team rollout stage", { exact: true }).selectOption("default");
  await evaluations.getByLabel("Rollout rationale", { exact: true }).fill("Checking the evidence guard.");
  await evaluations.getByRole("button", { name: "Record rollout decision", exact: true }).click();
  await evaluations.getByRole("alert").filter({ hasText: /not supported|20 real/ }).waitFor();
  await evaluations.getByLabel("Auto team rollout stage", { exact: true }).selectOption("experimental");
  await evaluations.getByRole("button", { name: "Record rollout decision", exact: true }).click();
  await evaluations.getByText(/Last decision:.*Checking the evidence guard/).waitFor();
  const rollout = await fetch(`${base}/api/team-rollout`, { headers }).then((response) => response.json());
  assert.equal(rollout.stage, "experimental");
});

test("changing a running goal stops its team and creates an approved child plan with an explicit budget", { timeout: 60_000 }, async () => {
  const started = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ repo, pattern: "auto-team", task: "AUTO-USER-QUESTION Implement the initial behavior", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, approvals: { plan: true }, loop: { check: "npm test", maxSteps: 20, maxInvocations: 20, maxMinutes: 3 } }) });
  assert.equal(started.status, 201, await started.clone().text());
  const { id: originalId } = await started.json() as { id: string };
  await page.goto(`${base}/#/run/${originalId}`);
  await page.locator(".awaiting-card").getByText("Approve Auto team", { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "✓ Approve", exact: true }).click();
  await page.getByPlaceholder("Your answer…").waitFor({ timeout: 20_000 });
  await page.locator(".followup-budget > summary").click();
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("12");
  await page.getByLabel("Follow-up maximum minutes", { exact: true }).fill("2");
  await page.getByLabel("Message the team", { exact: true }).fill("Change the goal: reject empty input and document the new behavior.");
  await page.getByRole("button", { name: "Revise goal", exact: true }).click();
  await page.waitForURL((url) => url.hash.startsWith("#/run/") && !url.hash.endsWith(originalId));
  const revisedId = page.url().split("#/run/")[1]!;
  await page.locator(".awaiting-card").getByText("Approve Auto team", { exact: true }).waitFor({ timeout: 20_000 });
  const [original, revised] = await Promise.all([originalId, revisedId].map((id) => fetch(`${base}/api/runs/${id}`, { headers }).then((response) => response.json()) as Promise<Run>));
  assert.equal(original!.status, "cancelled");
  assert.ok(!original!.steps.some((step) => step.status === "running"));
  assert.equal(revised!.parentRunId, originalId);
  assert.match(revised!.task, /Change the goal: reject empty input/);
  assert.equal(revised!.loop.maxInvocations, 12);
  assert.equal(revised!.loop.maxMinutes, 2);
  assert.equal(revised!.awaiting?.kind, "plan");
  assert.equal(revised!.steps.filter((step) => step.mode === "write").length, 0, "revised work is not dispatched before approval");
  await fetch(`${base}/api/runs/${revisedId}/cancel`, { method: "POST", headers });
});
