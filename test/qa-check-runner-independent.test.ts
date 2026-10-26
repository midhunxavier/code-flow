import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-check-independent-"));
process.env.CODEFLOW_HOME = join(home, "home");
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { sameCheckCommand } = await import("../src/verification.js");
const { flushWrites } = await import("../src/store.js");
const manager = new RunManager(findPattern);
after(async () => { await manager.shutdown(); await flushWrites(); rmSync(home, { recursive: true, force: true }); });
let counter = 0;
function repo() {
  const path = join(home, `repo-${++counter}`); mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "README.md"), "fixture\n");
  writeFileSync(join(path, "runner.sh"), "echo available\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: path });
  return path;
}
async function finished(run: Run) {
  for (let i = 0; i < 1000 && run.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(run.status, "done", run.error); return run;
}

test("a required gate newly broken by a change is not hidden behind another missing runner", async () => {
  const pattern: Pattern = { id: "qa-mixed-environment", name: "Mixed environment", summary: "", description: "", roles: [], options: [], run: async ctx => {
    const tree = await ctx.worktree("result");
    writeFileSync(join(tree.path, "runner.sh"), "missing-new-regression-runner\n");
    await ctx.commit(tree, "Break the second required gate");
    const checked = await ctx.check(tree);
    if (ctx.hasCheck) ctx.setVerdict(checked?.ok ? "passed" : "failing");
    return "checked";
  } };
  const run = await finished(await manager.start({ repo: repo(), pattern, task: "check both gates", roles: {}, options: {}, loop: { check: "missing-existing-runner", verification: { name: "two required gates", checks: [
    { id: "environment", kind: "custom", command: "missing-existing-runner", required: true, timeoutMs: 1000 },
    { id: "regression", kind: "custom", command: "sh runner.sh", required: true, timeoutMs: 1000 },
  ] } } }));
  assert.equal(run.verdict, "failing", "the second gate ran on the base commit and must remain actionable");
  assert.equal(run.checkCantRun, undefined);
  assert.equal(run.steps.filter(step => step.title === "Check on base commit").length, 2);
});

test("command equivalence preserves whitespace inside quoted arguments and keeps distinct gates", async () => {
  assert.equal(sameCheckCommand('node -e "console.log(\'a  b\')"', 'node -e "console.log(\'a b\')"'), false);
  assert.equal(sameCheckCommand('npm test -- --name "a  b"', 'npm run test -- --name "a b"'), false);
  assert.equal(sameCheckCommand(' npm  test -- --name "a  b" ', 'npm run test -- --name "a  b"'), true);
  const pattern: Pattern = { id: "qa-distinct-arguments", name: "Distinct arguments", summary: "", description: "", roles: [], options: [], run: async ctx => {
    const checked = await ctx.check(await ctx.worktree("result")); ctx.setVerdict(checked?.ok ? "passed" : "failing"); return "checked";
  } };
  const run = await finished(await manager.start({ repo: repo(), pattern, task: "Keep distinct checks", roles: {}, options: {}, loop: {
    check: 'test "a  b" = "a b"', verification: { name: "quoted strings", checks: [{ id: "configured", kind: "custom", command: 'test "a b" = "a b"', required: true, timeoutMs: 1000 }] },
  } }));
  assert.deepEqual(run.verification!.checks.map(gate => gate.check.id), ["configured", "primary-check"]);
  assert.equal(run.verdict, "failing");
});
