import { tmpdir } from "node:os";
import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_START_INPUT_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync(join(realpathSync(tmpdir()), "cf-qa-start-ui-"));
const data = join(scratch, "data"), records = join(scratch, "records"), shots = join(root, "output/playwright/qa-start-input-validation");
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-start-input-validation-token";
let server: ChildProcess, browser: Browser, restart = false, offlineCompare = false;
const logs: string[] = [], errors: string[] = [], expected: string[] = [], expectedOffline: string[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; }
async function ok(path: string, body?: unknown) { const r = await api(path, body); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
async function until<T>(get: () => Promise<T>, valid: (value: T) => boolean, timeout = 30000) { const end = Date.now() + timeout; let value: T; do { value = await get(); if (valid(value)) return value; await pause(100); } while (Date.now() < end); throw new Error(`Timed out: ${JSON.stringify(value)}`); }
const allRuns = async () => { const list = await ok("/api/runs"); return Array.isArray(list) ? list : list.runs; };
async function start() {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", FAKE_RECORD_DIR: records, FAKE_NO_APP_SERVER: "1", PATH: `${join(scratch, "bin")}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => logs.push(String(value)));
  for (let n = 0; n < 250; n++) { if (await api("/api/health").then(r => r.status === 200, () => false)) return; await pause(100); } throw new Error(logs.join(""));
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; const ended = new Promise<void>(resolve => server.once("exit", () => resolve())); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await ended; clearTimeout(timer); }
async function page(hash: string, initial: Record<string, string> = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(initial => { if (!sessionStorage.getItem("fixture-initialized")) { for (const [k, v] of Object.entries({ sideOpen: "0", ...initial })) localStorage.setItem(k, v); sessionStorage.setItem("fixture-initialized", "1"); } }, initial);
  const p = await context.newPage(); p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message));
  p.on("console", message => { if (message.type() !== "error") return; const url = message.location().url, text = message.text(); const isRestart = restart && url.startsWith(base + "/api/") && /net::ERR_(?:CONNECTION_REFUSED|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/.test(text); (isRestart ? expected : offlineCompare && url === base + "/api/compare" && /net::ERR_FAILED/.test(text) ? expectedOffline : errors).push(`${text} [${url}]`); });
  await p.goto(`${base}/?token=${token}${hash}`); return p;
}
async function fixture() {
  const repo = mkdtempSync(join(scratch, "repo-")); git(repo, "init", "-q", "-b", "main"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}'); writeFileSync(join(repo, "README.md"), "QA start fixture\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "fixture"); const project = await ok("/api/projects", { name: `Start fixture ${readdirSync(scratch).length}`, repos: [repo] });
  const run = { repo, project: project.id, projectSelection: "explicit", pattern: "solo", task: "Document fixture", roles: { agent: ["claude"] }, options: {}, trust: "standard" };
  return { repo, project, run };
}
async function composer(p: Page) { await p.getByRole("textbox", { name: "Task", exact: true }).fill("Document fixture"); await until(() => p.locator(".task-start").isEnabled(), Boolean); }
async function limits(p: Page) { await p.getByRole("button", { name: "Edit run options", exact: true }).click(); const advanced = p.locator("details.advanced-controls"); if (!await advanced.evaluate(el => (el as HTMLDetailsElement).open)) await advanced.locator(":scope > summary").click(); await p.locator("details.settings > summary").filter({ hasText: "Branches and limits" }).click(); }
before(async () => {
  mkdirSync(shots, { recursive: true }); mkdirSync(records); mkdirSync(join(scratch, "bin"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(scratch, "bin/git"), `#!${process.execPath}
const {execFileSync,spawnSync}=require("node:child_process"); const fs=require("node:fs"); const args=process.argv.slice(2); const target=args.find(a=>new RegExp("^refs/heads/qa-late-prefix/g[^/]+/[0-9]+-[0-9]+$").test(a)); if(args.includes("show-ref") && target){const file=${JSON.stringify(join(scratch, "prefix-counter"))}; const count=Number(fs.existsSync(file)?fs.readFileSync(file,"utf8"):0)+1; fs.writeFileSync(file,String(count)); if(count===4)execFileSync(${JSON.stringify(realGit)},["branch",target.slice("refs/heads/".length)],{cwd:process.cwd()});}const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exit(r.status??1);
`, { mode: 0o755 }); writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: data } }); await start(); browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async t => { if ((t as { error?: unknown }).error) for (const context of browser.contexts()) for (const p of context.pages()) { await p.screenshot({ path: join(shots, `failed-${t.name.slice(0, 35).replace(/[^a-z0-9]/gi, "-")}.png`), fullPage: true }).catch(() => {}); writeFileSync(join(shots, `failed-${t.name.slice(0, 35).replace(/[^a-z0-9]/gi, "-")}.txt`), await p.locator("body").innerText()); } for (const context of browser.contexts()) await context.close(); for (const run of await allRuns()) if (run.status === "running") await ok(`/api/runs/${run.id}/cancel`, {}); await until(allRuns, rows => rows.every((row: any) => row.status !== "running")); });
after(async () => { await browser?.close(); await stop(); writeFileSync(join(shots, "server.log"), logs.join("")); writeFileSync(join(shots, "browser.json"), JSON.stringify({ errors, expectedRestartErrors: expected, expectedOfflineErrors: expectedOffline }, null, 2)); rmSync(scratch, { recursive: true, force: true }); });

test("malformed admission is 400, exact numeric limits are retained, no invalid run records", async () => {
  const { run, repo } = await fixture(), before = (await allRuns()).length;
  for (const bad of [{ taskTeam: "bad" }, { permissionRequirements: "bad" }, { antigravityExecution: "bad" }, { trust: "bogus" }, { agentSettings: "bad" }, { roleSettings: [] }, { loop: { contextBudget: { maxPromptBytes: -1 } } }, { loop: { maxMinutes: 999 } }, { loop: { maxSteps: 500 } }, { loop: { maxSteps: 0.5 } }, { loop: { maxMinutes: "5" } }, { loop: { maxTokens: -1 } }, { loop: { maxCostUsd: null } }, { loop: [] }]) {
    const response = await api("/api/runs", { ...run, ...bad }); assert.equal(response.status, 400, JSON.stringify({ bad, response })); assert.ok(response.body.error);
  }
  for (const endpoint of ["/api/runs", "/api/deferred-runs"]) { const input = { ...run, repo: join(repo, "missing"), project: undefined, projectSelection: undefined }; const response = await api(endpoint, endpoint.includes("deferred") ? { run: input } : input); assert.equal(response.status, 400); assert.match(response.body.error, /no longer exists/); assert.doesNotMatch(response.body.error, /ENOENT|spawn git/); }
  assert.equal((await allRuns()).length, before);
  const created = await ok("/api/runs", { ...run, loop: { maxMinutes: 45, maxSteps: 12, maxTokens: 12345, maxCostUsd: 0.25 } }); const valid = await ok(`/api/runs/${created.id}`); assert.equal(valid.loop.maxMinutes, 45); assert.equal(valid.loop.maxSteps, 12); assert.equal(valid.loop.maxTokens, 12345); assert.equal(valid.loop.maxCostUsd, 0.25);
});

test("numeric drafts can be cleared and typed; invalid values block start and never alter summaries", async () => {
  const { project } = await fixture(), p = await page(`#/project/${project.id}/new`, { limits: '{"maxMinutes":-5,"maxSteps":999}' }); await composer(p); await limits(p);
  assert.equal(await p.locator("#maxMinutes").inputValue(), "240"); assert.equal(await p.locator("#maxSteps").inputValue(), "200");
  await p.locator("#maxMinutes").focus(); await p.keyboard.press("ControlOrMeta+A"); await p.keyboard.press("Backspace"); assert.equal(await p.locator("#maxMinutes").inputValue(), ""); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.keyboard.type("45"); assert.equal(await p.locator("#maxMinutes").inputValue(), "45");
  for (const [id, value] of [["maxMinutes", "999"], ["maxMinutes", "-5"], ["maxSteps", "500"], ["maxSteps", "0.5"]]) { await p.locator(`#${id}`).fill(value!); assert.equal(await p.locator(`#${id}`).getAttribute("aria-invalid"), "true"); assert.equal(await p.locator(".task-start").isDisabled(), true); assert.doesNotMatch(await p.locator(".composer-summary").innerText(), /999|500|-5|0\.5/); await p.locator(`#${id}`).fill(id === "maxMinutes" ? "45" : "12"); }
  await p.locator("#maxTokens").focus(); await p.keyboard.type("e"); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.locator("#maxTokens").fill(""); assert.equal(await p.locator(".task-start").isEnabled(), true);
  await p.screenshot({ path: join(shots, "editable-limits.png"), fullPage: true });
  const response = p.waitForResponse(r => r.url().endsWith("/api/runs") && r.request().method() === "POST"); await p.locator(".task-start").click(); const created = await (await response).json(); const result = await ok(`/api/runs/${created.id}`); assert.equal(result.loop.maxMinutes, 45); assert.equal(result.loop.maxSteps, 12);
});

test("acceptance criteria retain line 101 and character 2001 and explain the start blocker", async () => {
  const { project } = await fixture(), p = await page(`#/project/${project.id}/new`); await composer(p); await p.getByRole("button", { name: "Edit run options", exact: true }).click(); await p.locator(".acceptance-editor > summary").click();
  const text = Array.from({ length: 101 }, (_, i) => `Criterion ${i + 1}`).join("\n"); await p.locator("#acceptance-criteria").fill(text); assert.equal(await p.locator("#acceptance-criteria").inputValue(), text); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.getByRole("alert").filter({ hasText: "100 acceptance criteria" }).first().waitFor();
  await p.locator("#acceptance-criteria").fill("x".repeat(2001)); assert.equal((await p.locator("#acceptance-criteria").inputValue()).length, 2001); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.screenshot({ path: join(shots, "criteria-kept.png"), fullPage: true }); await p.locator("#acceptance-criteria").fill("A valid requirement"); assert.equal(await p.locator(".task-start").isEnabled(), true);
});

test("context byte ceiling can be cleared, retyped and disabled without snapping", async () => {
  const { project } = await fixture(), p = await page(`#/project/${project.id}/new`); await composer(p); await p.getByRole("button", { name: "Edit run options", exact: true }).click(); await p.locator(".context-inspector > summary").click();
  await p.getByRole("checkbox", { name: "Set an explicit input budget for each provider launch" }).check(); await p.locator("#context-max-bytes").fill(""); assert.equal(await p.locator("#context-max-bytes").inputValue(), ""); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.locator("#context-max-bytes").pressSequentially("4096"); assert.equal(await p.locator("#context-max-bytes").inputValue(), "4096"); assert.equal(await p.locator(".task-start").isEnabled(), true);
  await p.locator("#context-max-bytes").fill("67108865"); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.screenshot({ path: join(shots, "context-invalid.png"), fullPage: true }); await p.getByRole("checkbox", { name: "Set an explicit input budget for each provider launch" }).uncheck(); await until(() => p.locator(".task-start").isEnabled(), Boolean);
});

test("team bounds disable Apply and stale bad preferences cannot poison a fresh task", async () => {
  const { project, run } = await fixture(), badTeam = { enabled: false, coordinator: "claude", providers: ["claude", "codex"], settings: {}, preset: "adaptive", maxMembers: 9, maxCalls: 1000, maxMinutes: 0, approvePlan: false };
  const p = await page(`#/project/${project.id}/new`, { taskTeamPreferences: JSON.stringify(badTeam) }); await composer(p); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.locator(".task-team-advanced").click(); const dialog = p.getByRole("dialog", { name: "AI team setup", exact: true }); await dialog.locator(".task-team-limits > summary").click(); assert.equal(await dialog.locator("#team-maxMembers").inputValue(), "4");
  for (const [key, value] of [["maxMembers", "9"], ["maxCalls", "1000"], ["maxMinutes", "0"]]) { await dialog.locator(`#team-${key}`).fill(value!); assert.equal(await dialog.getByRole("button", { name: "Apply team settings" }).isDisabled(), true); const invalid = await api("/api/runs", { ...run, taskTeam: { ...badTeam, enabled: true, maxMembers: 4, maxCalls: 20, maxMinutes: 30, [key!]: Number(value) } }); assert.equal(invalid.status, 400); assert.match(invalid.body.error, /between/); await dialog.locator(`#team-${key}`).fill(key === "maxMembers" ? "4" : "20"); }
  await dialog.locator("#team-maxMembers").fill(""); assert.equal(await dialog.locator("#team-maxMembers").inputValue(), ""); assert.equal(await dialog.getByRole("button", { name: "Apply team settings" }).isDisabled(), true); await p.screenshot({ path: join(shots, "team-invalid.png"), fullPage: true }); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await p.getByRole("switch", { name: "AI team", exact: true }).click();
  const sent = p.waitForRequest(r => r.url().endsWith("/api/runs") && r.method() === "POST"); await p.locator(".task-start").click(); assert.equal((await sent).postDataJSON().taskTeam, undefined);
});

test("workflow options reject excess numbers and duplicate role entries do not hide distinct agents", async () => {
  const { project, run } = await fixture(), p = await page(`#/project/${project.id}/new`, { pattern: "debate" }); await composer(p); await limits(p); await p.locator("#opt-rounds").fill("99"); assert.equal(await p.locator(".task-start").isDisabled(), true); assert.doesNotMatch(await p.locator(".composer-summary").innerText(), /99/); await p.locator("#opt-rounds").fill("-3"); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.locator("#opt-rounds").fill("0"); assert.equal(await p.locator(".task-start").isEnabled(), true);
  for (const rounds of [99, -3, 1.5, "1"]) assert.equal((await api("/api/runs", { ...run, pattern: "debate", roles: { debaters: ["claude", "codex"], synthesizer: ["claude"] }, options: { rounds } })).status, 400);
  const created = await ok("/api/runs", { ...run, pattern: "race", roles: { contestants: [...Array(6).fill("claude"), "codex"], judge: ["claude"] } }); const valid = await ok(`/api/runs/${created.id}`); assert.deepEqual(valid.roles.contestants, ["claude", "codex"]); await p.screenshot({ path: join(shots, "workflow-options.png"), fullPage: true });
});

test("comparison honors all nine setups and preflights missing check before creating any run", async () => {
  const { run } = await fixture(), before = (await allRuns()).length;
  const invalid = await api("/api/compare", { run: { ...run, loop: { check: "" } }, variants: [{ label: "First", pattern: "solo", roles: { agent: ["claude"] } }, { label: "Loop", pattern: "loop", roles: { workers: ["codex"] } }] }); assert.equal(invalid.status, 400); assert.match(invalid.body.error, /Loop.*needs a check command/); assert.equal((await allRuns()).length, before);
  const variants = Array.from({ length: 9 }, (_, i) => ({ label: `V${i + 1}`, pattern: "solo", roles: { agent: ["claude"] } }));
  const result = await ok("/api/compare", { run: { ...run, branchPrefix: "qa-common-prefix" }, variants }); assert.equal(result.runs.length, 9); const rows = (await allRuns()).filter((r: any) => r.group?.id === result.group); assert.deepEqual(rows.map((r: any) => r.group.label).sort(), variants.map(v => v.label).sort()); const details = await Promise.all(result.runs.map((id: string) => ok(`/api/runs/${id}`))); assert.equal(new Set(details.map(r => r.branchPrefix)).size, 9); assert.ok(details.every(r => r.branchPrefix.startsWith("qa-common-prefix/")));
  for (const repeat of [0, 4, 1.5, "2", null]) assert.equal((await api("/api/compare", { run, variants: variants.slice(0, 2), repeat })).status, 400);
  assert.equal((await api("/api/compare", { run, variants: [...variants, variants[0]] })).status, 400);
});

test("Insights restores comparison draft after reload, sends seven setups after team off, and changes projects without stale text", { timeout: 90000 }, async () => {
  const { project } = await fixture(), p = await page(`#/project/${project.id}/new`); await composer(p); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.getByRole("textbox", { name: "Task", exact: true }).fill("Seven setup comparison"); await p.getByRole("button", { name: "Edit run options", exact: true }).click(); await p.locator("#checkCmd").fill("true"); await pause(400); await p.goto(`${base}/#/insights`); await p.reload(); await p.getByText("Experiments", { exact: true }).click(); await until(() => p.getByRole("button", { name: "Compare setups…", exact: true }).isEnabled(), Boolean); await p.getByText("Seven setup comparison", { exact: true }).waitFor(); await p.getByRole("button", { name: "Compare setups…", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Compare setups", exact: true }); const choices = dialog.locator(".compare-choice input:not(:disabled)"); await until(() => choices.count(), n => n >= 7, 4000).catch(async error => { throw new Error(`${error.message}\n${await dialog.innerText()}`); }); for (let i = 0; i < await choices.count(); i++) await choices.nth(i).setChecked(i < 7); await p.screenshot({ path: join(shots, "seven-setups.png"), fullPage: true });
  const before = (await allRuns()).length; offlineCompare = true; await p.route("**/api/compare", route => route.abort("failed")); await dialog.getByRole("button", { name: "Start 7 runs", exact: true }).click(); await dialog.locator(".msg.err").waitFor(); assert.equal((await allRuns()).length, before); assert.equal(await dialog.getByRole("button", { name: "Start 7 runs", exact: true }).isEnabled(), true); await p.unroute("**/api/compare"); offlineCompare = false;
  // The response follows admission of all seven runs, which can exceed the 15s UI-action budget.
  const response = p.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST", { timeout: 60000 }); await dialog.getByRole("button", { name: "Start 7 runs", exact: true }).click(); const reply = await response; assert.equal(reply.status(), 201); const result = await reply.json(); assert.equal(result.runs.length, 7); assert.equal(result.failed, undefined); assert.equal(reply.request().postDataJSON().run.taskTeam, undefined);
  const other = await fixture(); await p.goto(`${base}/#/project/${other.project.id}/new`); await composer(p); await p.getByRole("textbox", { name: "Task", exact: true }).fill("Other project current draft"); await pause(400); await p.goto(`${base}/#/insights`); await p.reload(); await p.getByText("Experiments", { exact: true }).click(); await p.getByText("Other project current draft", { exact: true }).waitFor(); assert.equal(await p.locator("details.settings").filter({ hasText: "Experiments" }).getByText("Seven setup comparison", { exact: true }).count(), 0);
});

test("a late repository race returns the partial group and shows its warning in Insights", async () => {
  const { project } = await fixture(), p = await page(`#/project/${project.id}/new`); await composer(p); await limits(p); await p.locator("#branchPrefix").fill("qa-late-prefix"); await p.locator("#checkCmd").fill("true"); await pause(400); await p.goto(`${base}/#/insights`); await p.getByText("Experiments", { exact: true }).click(); await p.getByRole("button", { name: "Compare setups…", exact: true }).click(); const dialog = p.getByRole("dialog", { name: "Compare setups", exact: true });
  await dialog.locator(".compare-choice").filter({ hasText: "Plan → Build → Review" }).getByRole("checkbox").check();
  const response = p.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST"); await dialog.getByRole("button", { name: "Start 2 runs", exact: true }).click(); const reply = await response; assert.equal(reply.status(), 201); const result = await reply.json(); assert.equal(result.runs.length, 1); assert.match(result.failed.error, /already exist/); assert.ok(result.group); await p.getByText(/Comparison partially started/).waitFor(); assert.match(p.url(), new RegExp(result.group)); assert.equal((await allRuns()).filter((r: any) => r.group?.id === result.group).length, 1); await p.screenshot({ path: join(shots, "partial-comparison-receipt.png"), fullPage: true });
});

test("deferred missing repositories are rejected after restart both with and without a project", async () => {
  const first = await fixture(), second = await fixture(), scheduled = Date.now() + 3000;
  const a = await ok("/api/deferred-runs", { name: "Moved project repository", run: first.run, notBefore: scheduled }); const b = await ok("/api/deferred-runs", { name: "Moved unassigned repository", run: { ...second.run, project: undefined, projectSelection: undefined }, notBefore: scheduled });
  const p = await page("#/settings/automations"); await p.getByRole("link", { name: "Run once later", exact: true }).click(); await p.getByRole("article", { name: "Deferred run Moved project repository", exact: true }).waitFor(); restart = true; await stop(); renameSync(first.repo, first.repo + "-moved"); renameSync(second.repo, second.repo + "-moved"); await start(); const jobs = await until(() => ok("/api/deferred-runs"), rows => [a.id, b.id].every(id => rows.find((r: any) => r.id === id)?.status === "failed")); for (const id of [a.id, b.id]) { const job = jobs.find((r: any) => r.id === id); assert.match(job.reason, /no longer exists/); assert.equal(job.runId, undefined); }
  await p.reload(); restart = false; await p.getByRole("article", { name: "Deferred run Moved project repository", exact: true }).getByText(/no longer exists/).first().waitFor(); await p.screenshot({ path: join(shots, "deferred-moved-repo.png"), fullPage: true });
});

test("all browser sessions have no unexpected console errors", () => { assert.deepEqual(errors, []); assert.doesNotMatch(logs.join(""), /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError/); });
