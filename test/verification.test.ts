import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessChangeRisk, detectVerificationProfile, diagnoseChecks, renderVerificationReport, reviewCoverage, runVerification, validateVerificationProfile, type VerificationProfile } from "../src/verification.js";
import type { CheckResult } from "../src/checks.js";
import { runCheck } from "../src/checks.js";

const outcome = (ok: boolean, output = ok ? "all passed" : "AssertionError: empty input", command = "npm test"): CheckResult => ({ command, ok, exitCode: ok ? 0 : 1, output, timedOut: false, durationMs: 3 });
const profile = (command: string): VerificationProfile => ({ name: "sample", checks: [{ id: "unit", kind: "unit", command, required: true, timeoutMs: 10_000 }] });

test("saved requirement mappings retain uncovered criteria and reject missing evidence checks", async () => {
  const configured = { ...profile("fixture"), requirements: [{ id: "goal", description: "The requested behavior works", checks: [] as string[] }] };
  const uncovered = await runVerification("/tmp", configured, { execute: async () => outcome(true) });
  assert.equal(uncovered.state, "needs-changes"); assert.equal(uncovered.requirements?.[0]?.covered, false);
  configured.requirements[0]!.checks = ["unit"];
  const covered = await runVerification("/tmp", configured, { execute: async () => outcome(true) });
  assert.equal(covered.state, "verified"); assert.equal(covered.requirements?.[0]?.covered, true);
  configured.requirements[0]!.checks = ["missing"];
  assert.throws(() => validateVerificationProfile(configured), /references to configured checks/);
});

test("verification detection uses available scripts and explicit preset breadth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-verify-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit", lint: "eslint", test: "node --test", "test:integration": "node --test integration", "test:e2e": "playwright test" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    assert.deepEqual((await detectVerificationProfile(dir, "lightweight")).checks.map((c) => c.id), ["typecheck", "lint", "unit"]);
    assert.deepEqual((await detectVerificationProfile(dir)).checks.map((c) => c.id), ["build", "typecheck", "lint", "unit"]);
    const thorough = await detectVerificationProfile(dir, "thorough");
    assert.equal(thorough.checks.length, 6);
    assert.equal(thorough.checks[0]!.command, "pnpm run build");
    await writeFile(join(dir, "package.json"), "{broken");
    await assert.rejects(() => detectVerificationProfile(dir), /not valid JSON/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("thorough profiles discover explicit mutation, visual and accessibility scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-quality-gates-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { "test:mutation": "node -e 'process.exit(0)'", "test:visual": "node -e 'process.exit(0)'", "test:a11y": "node -e 'process.exit(1)'" } }));
    const detected = await detectVerificationProfile(dir, "thorough");
    assert.deepEqual(detected.checks.map((check) => check.kind), ["mutation", "visual", "accessibility"]);
    const report = await runVerification(dir, detected);
    assert.equal(report.state, "needs-changes");
    assert.equal(report.checks.find((check) => check.check.kind === "accessibility")?.diagnosis, "failed");
    assert.equal(report.checks.find((check) => check.check.kind === "visual")?.diagnosis, "passed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("profiles reject duplicate IDs, unknown kinds and excessive execution bounds", () => {
  const valid = profile("true");
  assert.throws(() => validateVerificationProfile({ ...valid, checks: [...valid.checks, ...valid.checks] }), /unique/);
  assert.throws(() => validateVerificationProfile({ ...valid, checks: [{ ...valid.checks[0], kind: "network" }] }), /Unknown/);
  assert.throws(() => validateVerificationProfile({ ...valid, checks: [{ ...valid.checks[0], timeoutMs: Infinity }] }), /timeout/);
  assert.throws(() => validateVerificationProfile({ ...valid, checks: Array.from({ length: 13 }, (_, i) => ({ ...valid.checks[0], id: `check-${i}` })) }), /at most 12/);
});

test("baseline diagnosis distinguishes regressions, existing failures and mixed flaky results", () => {
  assert.equal(diagnoseChecks([outcome(false)], outcome(true)).diagnosis, "regression");
  assert.equal(diagnoseChecks([outcome(false)], outcome(false)).diagnosis, "pre-existing");
  assert.equal(diagnoseChecks([outcome(false), outcome(true)], outcome(true)).diagnosis, "flaky");
  assert.equal(diagnoseChecks([outcome(false, "new error")], outcome(false)).diagnosis, "failed");
  assert.equal(diagnoseChecks([{ ...outcome(false, "/bin/sh: missing-tool: command not found"), exitCode: 127 }]).diagnosis, "environment");
});

test("suite executes named gates, retains failing evidence and never verifies a failed required gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-verify-"));
  try {
    const input = profile("printf 'AssertionError: empty input\\n'; exit 1");
    input.checks.push({ id: "build", kind: "build", command: "printf 'built\\n'", required: true, timeoutMs: 10_000 });
    const report = await runVerification(dir, input, { repeats: 2, baseline: { unit: outcome(true) }, requirements: [{ id: "empty", description: "Empty input works", checks: ["unit"] }] });
    assert.equal(report.state, "needs-changes");
    assert.equal(report.checks[0]!.diagnosis, "regression");
    assert.equal(report.checks[0]!.attempts.length, 2);
    assert.equal(report.checks[1]!.diagnosis, "passed");
    assert.equal(report.requirements![0]!.covered, false);
    assert.match(renderVerificationReport(report), /AssertionError: empty input/);
    assert.match(renderVerificationReport(report), /unit \| yes \| regression \| 2/);
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await runVerification(dir, input, { signal: aborted.signal });
    assert.equal(cancelled.state, "blocked");
    assert.equal(cancelled.checks.length, 0);
    assert.equal(cancelled.skipped.length, 2);
    const empty = await runVerification(dir, { name: "none", checks: [] });
    assert.equal(empty.state, "unchecked");
    const missingRequirement = await runVerification(dir, profile("true"), { requirements: [{ id: "browser", description: "UI works", checks: ["browser"] }] });
    assert.equal(missingRequirement.state, "needs-changes", "passing unrelated checks cannot satisfy missing acceptance evidence");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("change assessment and review coverage expose sensitive and unreviewed files", () => {
  const risk = assessChangeRisk([{ path: "src/auth/session.ts", additions: 5 }, { path: "migrations/002.sql", additions: 4 }, { path: "ui/app.ts" }]);
  assert.equal(risk.level, "high");
  assert.equal(risk.sensitiveFiles.length, 2);
  assert.deepEqual(reviewCoverage(["src/a.ts", "./src/a.ts", "src/b.ts"], ["./src/a.ts", "unrelated.ts"]), { changed: 2, reviewed: 1, percent: 50, unreviewed: ["src/b.ts"] });
});

test("cancelled checks never spawn and injected command runners receive bounded gate options", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCheck(tmpdir(), "exit 0", { timeoutMs: 100, signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.aborted, true);
  assert.equal(cancelled.durationMs, 0);
  const calls: number[] = [];
  const report = await runVerification(tmpdir(), profile("ignored-by-journal-runner"), { timeoutMs: 900, execute: async (check, opts) => {
    calls.push(opts.timeoutMs);
    return outcome(true, "journal result", check.command);
  } });
  assert.equal(report.state, "verified");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]! <= 900 && calls[0]! > 0);
  const masked = await runCheck(tmpdir(), "printf '# pass 1\\n# fail 1\\n'; exit 0", { timeoutMs: 1_000 });
  assert.equal(masked.exitCode, 0);
  assert.equal(masked.ok, false, "reported test failures cannot be hidden behind exit zero");
  const empty = await runVerification(tmpdir(), profile("ignored"), { execute: async () => ({ ...outcome(true), tests: 0, failed: 0 }) });
  assert.equal(empty.state, "needs-changes", "a required test gate must execute tests");
});
