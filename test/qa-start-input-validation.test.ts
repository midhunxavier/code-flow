import { tmpdir } from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sanitizeDeferredRequest } from "../src/deferred-runs.js";
import { EXECUTION_BUDGET_PRESETS } from "../src/execution-budget.js";
import { EXECUTION_LIMITS, TASK_TEAM_LIMITS, numberProblem, acceptanceCriteriaProblem } from "../src/start-input-validation.js";
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "cf-qa-start-validation-"));
process.env.CODEFLOW_HOME = join(scratch, "data");
process.env.SHELL = join(scratch, "bash"); process.env.BASH_ENV = ""; process.env.ENV = "";
writeFileSync(process.env.SHELL, '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { repoRoot } = await import("../src/git.js");
const { validateTaskTeam } = await import("../src/task-team.js");
const manager = new RunManager(findPattern);
const repo = join(scratch, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "QA fixture\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
after(async () => { await manager.shutdown(); rmSync(scratch, { recursive: true, force: true }); });
for (const [key, rule] of Object.entries({ ...EXECUTION_LIMITS, ...TASK_TEAM_LIMITS })) test(`${key} uses exact finite bounds without coercion or truncation`, () => {
  assert.equal(numberProblem(rule.min, rule), ""); assert.equal(numberProblem(rule.max, rule), "");
  for (const invalid of [undefined, null, "", "5", NaN, Infinity, rule.min - 1, rule.max + 1, ...(("integer" in rule && rule.integer) ? [rule.min + 0.5] : [])]) assert.match(numberProblem(invalid, rule), /between/);
});
test("acceptance criteria report excess text without changing it", () => {
  const lines = Array.from({ length: 101 }, (_, i) => `Criterion ${i}`), long = "z".repeat(2001);
  assert.match(acceptanceCriteriaProblem(lines), /100 acceptance/); assert.equal(lines.length, 101);
  assert.match(acceptanceCriteriaProblem([long]), /2000 characters/); assert.equal(long.length, 2001);
  assert.equal(acceptanceCriteriaProblem(Array(100).fill("x".repeat(2000))), "");
});
test("team limits use visible field names and reject invalid saved values", () => {
  const valid = { enabled: true, coordinator: "claude", providers: ["claude", "codex"], preset: "adaptive", maxMembers: 4, maxCalls: 20, maxMinutes: 30, approvePlan: false };
  assert.equal(validateTaskTeam(valid).maxMembers, 4);
  for (const [field, value, label] of [["maxMembers", 9, "Members"], ["maxCalls", 1001, "Agent calls"], ["maxMinutes", 0, "Minutes"]] as const) assert.throws(() => validateTaskTeam({ ...valid, [field]: value }), new RegExp(label));
});
test("repository diagnostics distinguish missing folder, file, non-Git directory and symlinked repository", async () => {
  await assert.rejects(repoRoot(join(scratch, "gone")), /Repository folder .* no longer exists/);
  await assert.rejects(repoRoot(join(repo, "README.md")), /not a directory/);
  const empty = join(scratch, "empty"); mkdirSync(empty); await assert.rejects(repoRoot(empty), /not a git repository/i);
  const alias = join(scratch, "alias"); symlinkSync(repo, alias); assert.equal(await repoRoot(alias), repo);
});
test("comparison preflight applies engine-only checks without run records, context folders or provider work", async () => {
  const input = { pattern: findPattern("solo")!, repo, task: "Inspect fixture", roles: { agent: ["codex" as const] }, options: {}, trust: "standard" as const };
  await manager.validateStart(input); assert.equal(manager.list().length, 0);
  await assert.rejects(manager.validateStart({ ...input, pattern: findPattern("loop")!, roles: { workers: ["codex"] }, loop: { check: "" } }), /needs a check command/);
  await assert.rejects(manager.validateStart({ ...input, baseRef: "missing-branch" }), /Base branch .* not found/);
  await assert.rejects(manager.validateStart({ ...input, branchPrefix: "invalid name" }), /branch/i);
  assert.equal(manager.list().length, 0); assert.ok(!readdirSync(repo).includes(".worktrees"));
});


test("larger preset allocations pass admission and deferred storage without truncation", async () => {
  for (const preset of EXECUTION_BUDGET_PRESETS) {
    const loop = { maxSteps: preset.maxSteps, maxInvocations: preset.maxSteps, maxMinutes: preset.maxMinutes };
    const input = { pattern: findPattern("solo")!, repo, task: "Inspect fixture", roles: { agent: ["codex" as const] }, options: {}, loop };
    await manager.validateStart(input);
    const deferred = sanitizeDeferredRequest({ ...input, pattern: "solo" });
    assert.deepEqual(deferred.loop, { copy: [], ...loop });
    const team = validateTaskTeam({ enabled: true, coordinator: "codex", providers: ["codex"], preset: "adaptive", maxMembers: 4, maxCalls: preset.maxSteps, maxMinutes: preset.maxMinutes, approvePlan: false });
    assert.equal(team.maxCalls, preset.maxSteps);
    assert.equal(team.maxMinutes, preset.maxMinutes);
  }
});
