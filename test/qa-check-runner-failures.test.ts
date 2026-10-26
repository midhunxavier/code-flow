// QA regressions for the check runner: checks and gates that can't run here (a missing runner,
// Docker's daemon stopped) aren't failing checks, time limits are the ones that applied, and
// detection survives an invalid package.json.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, TeamContext } from "../src/engine.js";
import type { CheckResult } from "../src/checks.js";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-check-runner-home-"));
process.env.CODEFLOW_HOME = home;
const stateFile = join(home, "fake-gh.json");
process.env.FAKE_GH_STATE = stateFile;

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { fixUntilGreen } = await import("../src/patterns/prompts.js");
const { cantRunReason, detectCheck, detectCheckCommand, formatTimeout, proofOutcome, reproOutcome } = await import("../src/checks.js");
const { checksLabel } = await import("../src/run-status.js");
const { detectVerificationProfile, diagnoseChecks, environmentBlock, renderVerificationReport, runVerification, sameCheckCommand } = await import("../src/verification.js");
const { inspectReadiness } = await import("../src/readiness.js");
const { envNumber } = await import("../src/config.js");
const { flushWrites } = await import("../src/store.js");

const folders: string[] = [];
const folder = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), `codeflow-qa-check-runner-${prefix}-`)); folders.push(dir); return dir; };
function gitRepo(files: Record<string, string> = {}): string {
  const repo = folder("repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), body); }
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return repo;
}
const dir = (files: Record<string, string>) => { const d = folder("dir"); for (const [path, body] of Object.entries(files)) writeFileSync(join(d, path), body); return d; };
const result = (output: string, exitCode: number | null, command = "npm test", extra: Partial<CheckResult> = {}): CheckResult => ({ command, ok: false, exitCode, timedOut: false, durationMs: 1, output, ...extra });

const manager = new RunManager(findPattern);
after(async () => { await manager.shutdown(); await flushWrites(); for (const d of folders) rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
async function finished(run: Run): Promise<Run> {
  const end = Date.now() + 60_000;
  while (run.status === "running") { if (Date.now() > end) throw new Error(`Run ${run.id} did not finish`); await new Promise((resolve) => setTimeout(resolve, 20)); }
  await flushWrites();
  return run;
}
const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const key of Object.keys(vars)) delete process.env[key]; }
};
const logs = async (run: Run) => (await manager.events(run.id)).map((event) => (event.type === "log" ? event.text : "")).join("\n");
/** Fix & review's shape, small: fix rounds until green, then the verdict only when there's a check that runs here. */
const fixRounds: Pattern = { id: "qa-fix-rounds", name: "Fix rounds", summary: "", description: "", roles: [], options: [], run: async (ctx: TeamContext) => {
  const wt = await ctx.worktree("result");
  const { check } = await fixUntilGreen(ctx, { agent: "claude", role: "builder", wt, attempts: 2 });
  if (ctx.hasCheck) ctx.setVerdict(check?.ok ? "passed" : "failing");
  return "checked";
} };
const fixSteps = (run: Run) => run.steps.filter((step) => /Fix failing check/.test(step.title)).length;

// t07-3: a profile gate that can't run here is set aside like the single check.
test("a verification gate whose runner is missing spends no fix rounds and reads Blocked", async () => {
  const repo = gitRepo();
  const gate = { id: "unit", kind: "unit" as const, command: "missing-runner-xyz run", required: true, timeoutMs: 10_000 };
  const run = await finished(await manager.start({ repo, pattern: fixRounds, task: "verify", roles: {}, options: {}, loop: { check: gate.command, verification: { name: "lightweight", checks: [gate] } } }));
  assert.equal(run.status, "done", run.error);
  assert.equal(fixSteps(run), 0, "no fix rounds for a gate that can't run");
  assert.match(run.checkCantRun?.reason ?? "", /not found/);
  assert.equal(run.checkCantRun?.command, gate.command);
  assert.notEqual(run.verdict, "failing");
  assert.equal(run.verification?.state, "blocked");
  assert.equal(run.verification?.checks[0]?.diagnosis, "environment");
  assert.equal(checksLabel(run), "Blocked");
  assert.match(await logs(run), /The check can't run here: .*not found/);
});

test("a gate that couldn't run alongside one that failed is still code to fix", () => {
  const blocked = { version: 1 as const, profile: "p", state: "blocked" as const, startedAt: 0, endedAt: 1, skipped: [], checks: [
    { check: { id: "unit", kind: "unit" as const, command: "vitest", required: true, timeoutMs: 1 }, attempts: [result("sh: vitest: command not found", 127, "vitest")], diagnosis: "environment" as const },
  ] };
  assert.equal(environmentBlock(blocked)?.command, "vitest");
  const mixed = { ...blocked, checks: [...blocked.checks, { check: { id: "lint", kind: "lint" as const, command: "eslint", required: true, timeoutMs: 1 }, attempts: [result("1 problem", 1, "eslint")], diagnosis: "failed" as const }] };
  assert.equal(environmentBlock(mixed), undefined);
  assert.equal(environmentBlock({ ...blocked, skipped: [{ check: blocked.checks[0]!.check, reason: "The checkout commit moved" }] }), undefined, "an integrity block isn't the environment");
});

test("the run's npm test and a profile's npm run test are one gate", async () => {
  assert.ok(sameCheckCommand("npm test", "npm run test"));
  assert.ok(sameCheckCommand("pnpm t", "pnpm run test"));
  assert.ok(sameCheckCommand("yarn test --ci", "yarn run test --ci"));
  assert.ok(!sameCheckCommand("bun test", "bun run test"), "bun's own runner isn't the test script");
  assert.ok(!sameCheckCommand("npm test", "npm run test:unit"));
  const repo = gitRepo({ "package.json": JSON.stringify({ scripts: { test: "node -e \"console.log('# pass 1')\"" } }) });
  const run = await finished(await manager.start({ repo, pattern: fixRounds, task: "verify", roles: {}, options: {}, loop: { check: "npm test", verification: { name: "lightweight", checks: [{ id: "unit", kind: "unit", command: "npm run test", required: true, timeoutMs: 60_000 }] } } }));
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.verification?.checks.map((gate) => gate.check.id), ["unit"], "no duplicate primary-check gate");
  assert.equal(run.verification?.state, "verified");
  assert.equal(run.verdict, "passed");
});

// t07-4 / t19-2: Docker's daemon stopped.
test("a container check that can't reach Docker's daemon is a check that can't run, not a failing one", () => {
  const daemon = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
  const inContainer = result(daemon, 1, "true", { container: true });
  assert.equal(cantRunReason(inContainer), daemon);
  assert.equal(proofOutcome(inContainer).status, "unverified");
  assert.equal(reproOutcome(inContainer).status, "unverified");
  assert.match(cantRunReason(result("docker: Error response from daemon: pull access denied for nope.", 125, "true", { container: true }))!, /pull access denied/);
  assert.match(cantRunReason(result("\nDocker isn't installed or not on PATH", null, "true", { container: true }))!, /Docker isn't installed/);
  // On the host, a test suite that talks to Docker itself failing is the suite's business.
  assert.equal(cantRunReason(result(`FAIL integration.test.ts\n${daemon}`, 1)), undefined);
  assert.equal(cantRunReason(result("exit status 125", 125, "true")), undefined);
});

test("a container run with Docker's daemon stopped doesn't start", async () => {
  const repo = gitRepo();
  await withEnv({ FAKE_DOCKER_DOWN: "1" }, async () => {
    await assert.rejects(manager.start({ repo, pattern: findPattern("fix-review")!, task: "Fix it", roles: { builder: ["codex"], reviewer: ["claude"] }, options: {}, loop: { check: "true", container: { image: "alpine:3" } } }), /Docker isn't running \(Cannot connect to the Docker daemon.*\)\. Start Docker and try again/);
    await assert.rejects(manager.start({ repo, pattern: findPattern("fix-review")!, task: "Fix it", roles: { builder: ["codex"], reviewer: ["claude"] }, options: {}, loop: { check: "true", agentContainer: { image: "agents:local" } } }), /Agent isolation needs Docker running/);
  });
});

test("Docker's daemon stopping during a run sets the check aside instead of spending fix rounds", async () => {
  const repo = gitRepo();
  const run = await withEnv({ FAKE_DOCKER_DOWN: "run" }, async () => finished(await manager.start({ repo, pattern: findPattern("fix-review")!, task: "Fix it", roles: { builder: ["codex"], reviewer: ["claude"] }, options: {}, loop: { check: "true", container: { image: "alpine:3" } } })));
  assert.equal(run.status, "done", run.error);
  assert.match(run.checkCantRun?.reason ?? "", /Cannot connect to the Docker daemon/);
  assert.equal(fixSteps(run), 0);
  assert.notEqual(run.verdict, "failing");
  assert.ok(run.steps.some((step) => /^Review/.test(step.title)), "the review still runs");
  assert.equal(checksLabel(run), "Blocked");
});

test("an untrusted source asks before running checks here when Docker is installed but stopped", async () => {
  const origin = folder("origin");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  const repo = gitRepo();
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
  writeFileSync(stateFile, JSON.stringify({ issues: [{ number: 2, title: "Crash", body: "It crashes.", url: "https://github.com/o/r/issues/2", labels: [], author: { login: "mallory" }, authorAssociation: "NONE" }], prs: {} }));
  const input = { repo, pattern: findPattern("fix-review")!, task: "Fix issue #2", source: { kind: "issue" as const, number: 2 }, roles: { builder: ["codex" as const], reviewer: ["claude" as const] }, options: {}, loop: { check: "test -f README.md" } };
  await withEnv({ FAKE_DOCKER_DOWN: "1" }, async () => {
    await assert.rejects(manager.start(input), (err: Error & { code?: string }) => err.code === "untrusted-source" && /Docker is installed but isn't running: start it/.test(err.message));
    const run = await finished(await manager.start({ ...input, allowUntrusted: true }));
    assert.equal(run.status, "done", run.error);
    assert.equal(run.loop.container, undefined, "no container without a daemon");
    assert.equal(run.lockdownOnHost, true);
    assert.equal(fixSteps(run), 0);
    assert.equal(run.verdict, "passed");
    assert.match(await logs(run), /checks run on this machine because you allowed it/);
  });
  // With the daemon up, the same source's checks go in a container, as before.
  const contained = await finished(await manager.start(input));
  assert.deepEqual(contained.loop.container, { image: "node:22", network: false });
});

// t23-5 / t07-10: time limits.
test("a gate its timeout stopped says so, and the label gives the limit that applied", async () => {
  const timedOut = result("…\n[timed out after 300s]", null, "pytest", { timedOut: true, durationMs: 300_009 });
  const diagnosis = diagnoseChecks([timedOut], undefined, 300_000);
  assert.equal(diagnosis.diagnosis, "failed");
  assert.match(diagnosis.reason!, /^Timed out after 5 min before the check finished\. If it's only slow, raise this gate's timeout/);
  const regression = diagnoseChecks([timedOut], { ...timedOut, ok: true, timedOut: false, exitCode: 0 }, 300_000);
  assert.equal(regression.diagnosis, "regression");
  assert.match(regression.reason!, /Timed out after 5 min.*passed on the baseline/);
  const check = { id: "unit", kind: "unit" as const, command: "sleep 5", required: true, timeoutMs: 1_000 };
  const report = await runVerification(tmpdir(), { name: "slow", checks: [check] });
  assert.equal(report.checks[0]!.attempts[0]!.timedOut, true);
  assert.match(report.checks[0]!.reason!, /Timed out after 1 s/);
  const markdown = renderVerificationReport(report);
  assert.match(markdown, /\| unit \| yes \| failed \(timed out\) \| 1 \|/);
  assert.match(markdown, /Timed out after 1 s before the check finished/);
  assert.equal(formatTimeout(270_000), "4.5 min");
  assert.equal(formatTimeout(600), "1 s");
});

test("a 30-minute gate gets its 30 minutes when no deadline is given", async () => {
  const limits: number[] = [];
  const gate = (id: string, timeoutMs: number) => ({ id, kind: "custom" as const, command: "true", required: true, timeoutMs });
  await runVerification(tmpdir(), { name: "long", checks: [gate("one", 30 * 60_000), gate("two", 20 * 60_000)] }, { execute: async (_check, opts) => { limits.push(opts.timeoutMs); return { command: "true", ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: "" }; } });
  assert.equal(limits[0], 30 * 60_000, "not cut to a 15-minute suite deadline");
  assert.equal(limits[1], 20 * 60_000, "the second gate keeps its own limit too");
});

test("detected gates get the repository's check timeout", async () => {
  const scripts = JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } });
  const configured = gitRepo({ "package.json": scripts, ".codeflow/config.json": JSON.stringify({ limits: { checkTimeoutMin: 20 } }) });
  assert.deepEqual((await detectVerificationProfile(configured)).checks.map((check) => check.timeoutMs), [1_200_000, 1_200_000]);
  const plain = gitRepo({ "package.json": scripts });
  assert.deepEqual((await detectVerificationProfile(plain, "lightweight")).checks.map((check) => check.timeoutMs), [600_000], "a run's default ten minutes");
  const python = gitRepo({ "tests/pyproject.toml": "[tool.pytest.ini_options]\n", "pyproject.toml": "[tool.uv.workspace]\nmembers = ['tests']\n", "uv.lock": "", ".codeflow/config.json": JSON.stringify({ limits: { checkTimeoutMin: 45 } }) });
  const detected = await detectVerificationProfile(python, "lightweight");
  assert.equal(detected.checks[0]!.command, "cd tests && uv run --no-sync pytest -q");
  assert.equal(detected.checks[0]!.timeoutMs, 1_800_000, "capped at a gate's 30-minute maximum");
});

test("a timed-out step says the limit that stopped it: the gate's own, or the clamped run limit", async () => {
  const repo = gitRepo();
  const checkOnce: Pattern = { id: "qa-check-once", name: "Check once", summary: "", description: "", roles: [], options: [], run: async (ctx) => { const wt = await ctx.worktree("result"); const checked = await ctx.check(wt); ctx.setVerdict(checked?.ok ? "passed" : "failing"); return "checked"; } };
  const gated = await finished(await manager.start({ repo, pattern: checkOnce, task: "gate", roles: {}, options: {}, loop: { check: "sleep 5", checkTimeoutMin: 10, verification: { name: "Gate", checks: [{ id: "unit", kind: "unit", command: "sleep 5", required: true, timeoutMs: 1_000 }] } } }));
  const gateStep = gated.steps.find((step) => step.title === "Check: unit")!;
  assert.equal(gateStep.finalText, "Timed out after 1 s");
  const statuses = (await manager.events(gated.id)).filter((event) => event.type === "agent" && event.stepId === gateStep.id && event.event.kind === "status").map((event) => (event as { event: { text: string } }).event.text);
  assert.deepEqual(statuses, ["Timed out after 1 s"]);
  const plain = await finished(await manager.start({ repo, pattern: checkOnce, task: "plain", roles: {}, options: {}, loop: { check: "sleep 5", checkTimeoutMin: 0.001 } }));
  assert.equal(plain.steps.find((step) => step.kind === "check")!.finalText, "Timed out after 1 s", "0.001 min is clamped to a second, and says so");
});

// t07-9: a reviewer's test the check never collected.
test("a reviewer's test the check never ran reads Couldn't tell in its step, as in its finding", async () => {
  const repo = gitRepo();
  const run = await withEnv({ FAKE_REPRO: "uncollected" }, async () => finished(await manager.start({ repo, pattern: findPattern("pipeline")!, task: "Add the feature", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, options: { maxRounds: 1 }, loop: { check: "node --test" } })));
  assert.equal(run.status, "done", run.error);
  const finding = run.findings?.[run.artifacts[0]!.branch]?.findings[0];
  assert.equal(finding?.check.status, "unverified");
  const step = run.steps.find((s) => s.title.startsWith("Reviewer's test"))!;
  assert.equal(step.status, "failed");
  assert.match(step.finalText!, /^Couldn't tell: .*as many as without, so it didn't run notes\/bound\.spec\.txt/);
  assert.doesNotMatch(step.finalText!, /false alarm/);
  const statuses = (await manager.events(run.id)).filter((event) => event.type === "agent" && event.stepId === step.id && event.event.kind === "status").map((event) => (event as { event: { text: string } }).event.text);
  assert.match(statuses.at(-1)!, /^Couldn't tell: /, "live views get the corrected step too");
});

// t03-10: Validate commands uses a run's limit.
test("readiness validation times commands out at the repository's check timeout, not 120 s", async () => {
  const quick = gitRepo({ ".codeflow/config.json": JSON.stringify({ check: "sleep 5", limits: { checkTimeoutMin: 0.05 } }) });
  const report = await inspectReadiness({ repo: quick, execute: true });
  assert.equal(report.checkTimeoutMin, 0.05);
  const run = report.items.find((item) => item.id === "check-run")!;
  assert.equal(run.status, "failed");
  assert.match(run.detail!, /^Timed out after 3 s, the limit a run gives it \(limits\.checkTimeoutMin/);
  const slowEnough = gitRepo({ ".codeflow/config.json": JSON.stringify({ check: "sleep 1 && echo ok", limits: { checkTimeoutMin: 0.1 } }) });
  assert.equal((await inspectReadiness({ repo: slowEnough, execute: true })).items.find((item) => item.id === "check-run")!.status, "passed");
  assert.equal((await inspectReadiness({ repo: gitRepo() })).checkTimeoutMin, 10, "a run's default");
});

// t03-8 / t03-9 / S11-1: an invalid package.json.
test("an invalid package.json is skipped with a warning, and detection goes on", async () => {
  assert.deepEqual(await detectCheck(dir({ "package.json": "{ not json", Makefile: "test:\n\techo ok\n" })), { check: { command: "make test", source: "Makefile" }, warning: "package.json is not valid JSON, so its test script was skipped" });
  assert.deepEqual(await detectCheckCommand(dir({ "package.json": '{"name":"x","scripts":{"test":"node --test"},}', "Cargo.toml": "" })), { command: "cargo test", source: "Cargo.toml" });
  assert.deepEqual(await detectCheck(dir({ "package.json": "{ not json" })), { check: null, warning: "package.json is not valid JSON, so its test script was skipped" });
  const bom = dir({ "package.json": `\uFEFF${JSON.stringify({ scripts: { test: "vitest run" } })}` });
  assert.equal((await detectCheckCommand(bom))?.command, "npm test", "npm reads a byte-order mark, so detection does too");
  assert.equal((await detectVerificationProfile(bom, "lightweight")).checks[0]?.command, "npm run test");
  const report = await inspectReadiness({ repo: gitRepo({ "package.json": "{ not json" }) });
  assert.ok(report.items.some((item) => item.id === "git"), "readiness as a whole still answers");
  assert.match(report.items.find((item) => item.id === "check")!.detail!, /Detection: package\.json is not valid JSON/);
});

// t07-12: slot limits from the environment.
test("whole-number settings refuse fractions and zero with one warning", () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    for (const [name, value] of [["CF_QA_SLOTS_FRACTION", "2.5"], ["CF_QA_SLOTS_ZERO", "0"], ["CF_QA_SLOTS_UNIT", "30m"]] as const) {
      process.env[name] = value;
      assert.equal(envNumber(name, 6, { min: 1, integer: true }), 6);
      assert.equal(envNumber(name, 6, { min: 1, integer: true }), 6);
      delete process.env[name];
    }
    process.env.CF_QA_SLOTS_OK = "4";
    assert.equal(envNumber("CF_QA_SLOTS_OK", 6, { min: 1, integer: true }), 4);
    delete process.env.CF_QA_SLOTS_OK;
  } finally { console.warn = warn; }
  assert.deepEqual(warnings, [
    'code-flow: ignoring CF_QA_SLOTS_FRACTION="2.5" (must be a whole number, at least 1); using 6',
    'code-flow: ignoring CF_QA_SLOTS_ZERO="0" (must be a whole number, at least 1); using 6',
    'code-flow: ignoring CF_QA_SLOTS_UNIT="30m" (must be a whole number, at least 1); using 6',
  ]);
});
