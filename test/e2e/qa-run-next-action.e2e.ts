// Original run-status and recovery repros, using real Chrome, isolated state and fake CLIs only.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-next-action-ui-"))), home = join(fixture, "home"), repo = join(fixture, "repo"), bin = join(fixture, "bin"), modes = join(fixture, "modes.json");
const token = "qa-next-action", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let base: string, server: ChildProcess, browser: Browser, project: string, page: Page | undefined;
let output = ""; const errors: string[] = [];
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo, encoding: "utf8" }).trim();
const mode = (value: Record<string, string> = {}) => writeFileSync(modes, JSON.stringify(value));
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); }
async function until<T>(get: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> { const end = Date.now() + 35_000; for (;;) { const value = await get(); if (accepts(value)) return value; assert.ok(Date.now() < end, `Timed out: ${JSON.stringify(value).slice(0, 700)}`); await new Promise(resolve => setTimeout(resolve, 50)); } }
const done = (id: string) => until(() => api<Run>(`/api/runs/${id}`), run => run.status !== "running" && !!run.endedAt);
const start = (extra: Record<string, unknown> = {}) => api<Run>("/api/runs", { repo, project, pattern: "fix-review", task: "QA next action", roles: { builder: ["claude"], reviewer: ["codex"] }, loop: { check: "true", maxSteps: 12 }, ...extra });
async function open(id: string, route = "run") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(() => localStorage.setItem("sideOpen", "0"));
  page = await context.newPage(); page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/?token=${token}#/${route}/${id}`); return page;
}
async function shot(name: string) { if (evidence && page) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
before(async () => {
  for (const path of [repo, bin, join(home, "runs")]) mkdirSync(path, { recursive: true }); mode();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Base\n"); git("add", "."); git("commit", "-qm", "base");
  // Per-test provider responses stay inside this fixture and use the repository's fake agent.
  writeFileSync(join(bin, "agent.mjs"), `import { readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const env = {...process.env, ...JSON.parse(readFileSync(${JSON.stringify(modes)}, 'utf8'))};
const result = spawnSync(process.execPath, [${JSON.stringify(join(root, "test/fake-agent.mjs"))}, ...process.argv.slice(2)], { env, stdio: 'inherit' }); process.exit(result.status ?? 1);`);
  for (const vendor of ["claude", "codex"]) writeFileSync(join(bin, vendor), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, "agent.mjs")}' ${vendor} "$@"\n`, { mode: 0o755 });
  const commit = git("rev-parse", "HEAD"), now = Date.now();
  const seed = (id: string, extra: Record<string, unknown>) => { const run = { id, task: id, repo, pattern: "fix-review", baseRef: commit, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(fixture, "trees", id), roles: { builder: ["claude"], reviewer: ["codex"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "true", setup: "", maxSteps: 10, maxMinutes: 5 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: now, endedAt: now + 1, seen: true, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [], ...extra }; writeFileSync(join(home, "runs", id + ".jsonl"), [{ seq: 1, ts: now, runId: id, type: "run", run }, ...((extra.steps ?? []) as any[]).map((step, i) => ({ seq: i + 2, ts: now, runId: id, type: "step", step }))].map(event => JSON.stringify(event)).join("\n") + "\n"); };
  seed("warnings-and-failure", { verdict: "failing", summary: "**Changes on `result/*`**", steps: [{ id: "s1", title: "Proof: tests without the change", kind: "check", status: "failed", outcome: "warning", finalText: "Passes without the change too", startedAt: now, endedAt: now + 1 }, { id: "s2", title: "Required check", kind: "check", status: "failed", finalText: "Failed (exit code 1)", startedAt: now, endedAt: now + 1 }] });
  seed("unknown-provider-reset", { status: "stopped", stopReason: "usage limit of Claude Code", providerLimit: { agent: "claude", name: "Claude Code" } });
  seed("elapsed-provider-reset", { status: "stopped", stopReason: "usage limit of Claude Code", providerLimit: { agent: "claude", name: "Claude Code", resetsAt: now + 60_000 } });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); assert.ok(port !== 4317 && port !== 4318); base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_MAX_CHECKS: "1", FAKE_NO_APP_SERVER: "1", PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => output += String(value));
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
  project = (await api("/api/projects", { name: "Next action QA", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => { await shot("last-case"); await page?.context().close(); page = undefined; mode(); });
after(async () => { await browser?.close(); if (server && server.exitCode === null && server.signalCode === null) { const ended = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await ended; } if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "server.log"), output); } rmSync(fixture, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.doesNotMatch(output, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); });

test("engine sign-in failures expose provider health in both workflows and Agent chats", async () => {
  mode({ FAKE_CLAUDE_FAIL: "auth", FAKE_NOOP_VENDOR: "claude" });
  for (const extra of [{}, { pattern: "solo", roles: { agent: ["claude"] } }]) {
    const run = await done((await start(extra)).id); assert.equal(run.failure?.kind, "auth"); assert.equal(run.artifacts.length, 0);
    const p = await open(run.id); await p.getByRole("button", { name: "Reconnect provider", exact: true }).click();
    await p.getByRole("dialog").waitFor(); await shot("provider-health");
    assert.equal(await p.getByRole("heading", { name: "Ready to review", exact: true }).count(), 0);
    await p.context().close(); page = undefined;
  }
});

test("provider usage stops show the reset and prevent early Resume without budget controls", async () => {
  mode({ FAKE_CLAUDE_FAIL: "rejected", FAKE_CLAUDE_RESETS_AT: String(Math.floor(Date.now() / 1000) + 3600), FAKE_NOOP_VENDOR: "claude" });
  const run = await done((await start()).id); const p = await open(run.id), next = p.getByRole("region", { name: "Next action" });
  await next.getByRole("heading", { name: /reached its usage limit/ }).waitFor(); assert.match(await next.innerText(), /Reset reported for/);
  assert.equal(await next.getByRole("button", { name: "Resume after reset", exact: true }).isEnabled(), false); assert.equal(await next.locator(".resume-budget").count(), 0); await shot("provider-limit");
  await p.goto(`${base}/#/run/unknown-provider-reset`); await p.getByRole("button", { name: "Resume after reset", exact: true }).waitFor(); assert.equal(await p.getByRole("button", { name: "Resume after reset", exact: true }).isEnabled(), true);
  await p.clock.install(); await p.clock.setFixedTime(new Date(Date.now() + 120_000));
  await p.goto(`${base}/#/run/elapsed-provider-reset`); await p.getByRole("button", { name: "Resume after reset", exact: true }).waitFor();
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Resume after reset" && !button.disabled), undefined, { timeout: 2000 });
});

test("rejected plans end the run, offer editing and reject a direct Resume request", async () => {
  const run = await start({ pattern: "pipeline", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, approvals: { plan: true } });
  await until(() => api<Run>(`/api/runs/${run.id}`), value => !!value.awaiting); const p = await open(run.id);
  const full = p.locator(".conversation-plan-details > summary"); if (await full.count()) await full.click();
  await p.getByRole("button", { name: "Reject", exact: true }).click(); await p.getByRole("dialog").getByRole("button", { name: "Reject plan", exact: true }).click();
  await done(run.id); await p.getByRole("heading", { name: "You rejected the plan", exact: true }).waitFor();
  assert.equal(await p.getByRole("button", { name: "Edit & run again", exact: true }).isVisible(), true);
  const rejected = await fetch(`${base}/api/runs/${run.id}/resume`, { method: "POST", headers, body: "{}" }); assert.equal(rejected.status, 409); await shot("plan-rejected");
});

test("read-only councils make the review and publication action visible", async () => {
  const run = await done((await start({ pattern: "council", roles: { reviewers: ["claude", "codex"], chair: ["claude"] }, loop: { check: "" } })).id); assert.equal(run.status, "done", run.error);
  const p = await open(run.id); await p.getByRole("button", { name: "Read and publish review", exact: true }).click();
  assert.equal(await p.getByRole("region", { name: "Council review", exact: true }).isVisible(), true);
  assert.equal(await p.getByRole("button", { name: "Fix check command", exact: true }).count(), 0); await shot("council-review");
});

test("no-op chats have no review card; real uncommitted changes and overall comments remain usable", async () => {
  mode({ FAKE_NOOP_VENDOR: "claude" }); const empty = await done((await start({ pattern: "solo", roles: { agent: ["claude"] } })).id); assert.deepEqual(empty.artifacts, []);
  const p = await open(empty.id); await p.locator(".runview").waitFor(); assert.equal(await p.getByRole("region", { name: "Try and assess the result" }).count(), 0);
  mode(); const changed = await done((await start({ pattern: "solo", roles: { agent: ["claude"] } })).id); assert.ok(changed.artifacts.length);
  await p.goto(`${base}/#/run/${changed.id}`); await p.getByRole("region", { name: "Try and assess the result" }).waitFor(); await p.getByRole("button", { name: "Review changes", exact: true }).first().click();
  await p.getByLabel("Overall comment", { exact: true }).fill("Please explain this change");
  await p.getByRole("button", { name: "Send 1 comment", exact: true }).waitFor(); await shot("overall-comment-count");
  mode({ FAKE_CLAUDE_FAIL: "auth" }); const partial = await done((await start({ pattern: "solo", roles: { agent: ["claude"] } })).id);
  assert.equal(partial.status, "failed"); assert.ok(partial.artifacts.length);
  await p.goto(`${base}/#/run/${partial.id}`); await p.getByRole("heading", { name: "Partial work saved", exact: true }).waitFor();
  assert.equal(await p.getByRole("button", { name: "Review changes", exact: true }).first().isVisible(), true); await shot("failed-partial-work");
});

test("done runs expose actual failed checks while proofs remain warnings and code inside bold renders", async () => {
  const p = await open("warnings-and-failure"); await p.getByText("What went wrong", { exact: true }).waitFor();
  assert.match(await p.locator(".failures").innerText(), /Required check/); assert.doesNotMatch(await p.locator(".failures").innerText(), /Proof:/);
  await p.locator("details.work > summary").click(); assert.match(await p.locator("details.work > summary").innerText(), /1 failed.*1 warning/);
  assert.equal(await p.getByRole("button", { name: /^Proof: tests without the change/ }).getAttribute("aria-description"), "Proof: tests without the change: Warning");
  await p.locator("details.result-details > summary").click(); assert.ok(await p.locator("b code").filter({ hasText: "result/*" }).count() > 0); await shot("warning-versus-failure");
});

test("pause transitions to idle in run, rail and History with matching priorities", async () => {
  mode({ FAKE_SLEEP_MS: "2500" }); const run = await start(); await until(() => api<Run>(`/api/runs/${run.id}`), value => value.steps.some(step => step.kind === "agent" && step.status === "running"));
  const p = await open(run.id); await p.getByRole("button", { name: "Pause dispatch", exact: true }).click();
  await p.getByRole("heading", { name: "Pausing after active work", exact: true }).waitFor();
  await p.getByRole("heading", { name: "Dispatch paused", exact: true }).waitFor();
  assert.equal(await p.locator(".work-ic.running").count(), 0);
  assert.equal(await p.locator(`a[href="#/run/${run.id}"] .dot.running`).count(), 0);
  assert.equal(await p.locator(".run-state").filter({ hasText: "Stopped" }).count() > 0 || (await p.locator(".run-head").innerText()).includes("Stopped"), true);
  const options = await p.getByLabel("Run priority", { exact: true }).locator("option").allTextContents(); assert.deepEqual(options, ["High", "Normal", "Low"]);
  await p.getByLabel("Run priority", { exact: true }).selectOption("-10"); await shot("dispatch-paused");
  await p.goto(`${base}/#/project/${project}/repositories/${encodeURIComponent(repo)}/history`); const history = p.getByRole("button", { name: "History", exact: true }); if (await history.count()) await history.click();
  const paused = await api<Run>(`/api/runs/${run.id}`); await p.locator("#wb-folder").selectOption(paused.worktrees[0]!.path);
  const priority = p.getByLabel("Run priority", { exact: true }); await priority.waitFor(); assert.deepEqual(await priority.locator("option").allTextContents(), options); assert.equal(await priority.inputValue(), "-10");
  await api(`/api/runs/${run.id}/cancel`, {}); await done(run.id);
});

test("queued checks use singular wording and Stop renders an explicit cancelled check", async () => {
  const first = await start({ loop: { check: "sleep 20", maxSteps: 12 } });
  await until(() => api<Run>(`/api/runs/${first.id}`), run => run.steps.some(step => step.kind === "check" && step.status === "running"));
  const second = await start({ loop: { check: "sleep 20", maxSteps: 12 } });
  await until(() => api<Run>(`/api/runs/${second.id}`), run => run.steps.some(step => step.kind === "check" && step.status === "running"));
  const p = await open(second.id); await p.getByText("Waiting: 1 check is already running (CODEFLOW_MAX_CHECKS)", { exact: true }).waitFor(); await shot("single-check-queue");
  await api(`/api/runs/${first.id}/cancel`, {}); await api(`/api/runs/${second.id}/cancel`, {}); await done(first.id); await done(second.id);
  await p.getByRole("heading", { name: "Stopped by you", exact: true }).waitFor();
  const stopped = await api<Run>(`/api/runs/${first.id}`); assert.equal(stopped.steps.find(step => step.kind === "check")!.finalText, "Stopped before it finished");
  assert.doesNotMatch(await p.locator(".runview").innerText(), /exit code null|Ready to review/); await shot("stopped-check");
});

test("a real TDD workflow distinguishes its premature green warning from the expected red check", async () => {
  mode({ FAKE_TESTS_PASS_FIRST: "1" });
  const run = await done((await start({ pattern: "tdd", roles: { tester: ["codex"], builder: ["claude"] }, loop: { check: "", maxSteps: 12 } })).id);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.steps.find(step => step.title === "New tests (should fail)")?.outcome, "warning");
  assert.equal(run.steps.find(step => step.title === "Revised tests (should fail)")?.outcome, "expected");
  const p = await open(run.id); await p.locator("details.work > summary").waitFor();
  assert.match(await p.locator("details.work > summary").innerText(), /1 warning/); assert.doesNotMatch(await p.locator("details.work > summary").innerText(), /failed/);
  await p.locator("details.work > summary").click(); const red = p.getByRole("button", { name: /^Revised tests \(should fail\)/ }); await red.waitFor(); assert.equal(await red.getAttribute("aria-description"), "Revised tests (should fail): Expected failure"); await shot("tdd-warning-and-red");
});
