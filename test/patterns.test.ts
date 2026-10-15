import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Route every agent call to the fake CLIs and keep worktrees out of ~/.codeflow.
const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-test-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type Run = import("../src/engine.js").Run;

let repo: string;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "sample\n");
  writeFileSync(join(repo, "shared.txt"), "original\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

async function runPattern(id: string, roles: Record<string, any>, task = "Do the thing", options = {}): Promise<Run> {
  const manager = new RunManager();
  const run = await manager.start({ pattern: findPattern(id)!, task, repo, roles, options });
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

const branchFiles = (branch: string) =>
  execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: repo }).toString().split("\n");

test("pipeline: plan → build → review with a requested-changes round", async () => {
  process.env.FAKE_REVIEW_FAIL_ONCE = "1";
  try {
    const run = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] });
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(
      run.steps.map((s) => s.title),
      ["Plan", "Implement plan", "Review (round 1)", "Address review (round 1)", "Review (round 2)"],
    );
    assert.ok(run.steps.every((s) => s.sessionId), "every step reports a session id");
    assert.match(run.summary!, /Approved/);
    assert.ok(branchFiles(run.artifacts[0]!.branch).some((f) => f.startsWith("codex-")));
  } finally {
    delete process.env.FAKE_REVIEW_FAIL_ONCE;
  }
});

test("race: contestants in parallel, judge picks anonymized winner", async () => {
  const run = await runPattern("race", { contestants: ["claude", "codex"], judge: ["agy"] });
  assert.equal(run.status, "done", run.error);
  assert.match(run.summary!, /Winner: Candidate B — codex/);
  assert.equal(run.artifacts.length, 2);
});

test("debate: proposals, critique, synthesis, build", async () => {
  const run = await runPattern("debate", { debaters: ["claude", "codex"], synthesizer: ["claude"], builder: ["agy"] }, "Design it", {
    rounds: 1,
  });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.steps.filter((s) => s.role === "debaters").length, 4);
  assert.ok(branchFiles(run.artifacts[0]!.branch).some((f) => f.startsWith("agy-")));
});

test("debate without builder stops at the plan", async () => {
  const run = await runPattern("debate", { debaters: ["claude", "codex"], synthesizer: ["codex"], builder: [] }, "Design it", {
    rounds: 0,
  });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.artifacts.length, 0);
  assert.match(run.summary!, /Synthesized plan/);
});

test("supervisor: decompose, parallel workers, clean merge", async () => {
  const run = await runPattern("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"] });
  assert.equal(run.status, "done", run.error);
  const files = branchFiles(run.artifacts[0]!.branch);
  assert.ok(files.some((f) => f.startsWith("claude-")) && files.some((f) => f.startsWith("codex-")));
});

test("supervisor: merge conflict is resolved by the supervisor", async () => {
  const run = await runPattern("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"] }, "CONFLICT task");
  assert.equal(run.status, "done", run.error);
  assert.ok(run.steps.some((s) => s.title.startsWith("Resolve conflicts")));
  const shared = execFileSync("git", ["show", `${run.artifacts[0]!.branch}:shared.txt`], { cwd: repo }).toString();
  assert.equal(shared, "resolved by fake agent\n");
});

test("tdd: tester writes tests, builder implements, tester verifies", async () => {
  const run = await runPattern("tdd", { tester: ["codex"], builder: ["claude"] });
  assert.equal(run.status, "done", run.error);
  assert.match(run.summary!, /All tests pass/);
  assert.ok(branchFiles(run.artifacts[0]!.branch).includes("spec.test.txt"));
});

test("a failing agent fails the pipeline but not a race", async () => {
  process.env.FAKE_FAIL_VENDOR = "codex";
  try {
    const pipeline = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(pipeline.status, "failed");
    assert.match(pipeline.error!, /Implement plan \(codex\) failed: codex exited with code 1: boom/);

    const race = await runPattern("race", { contestants: ["claude", "codex"], judge: ["claude"] });
    assert.equal(race.status, "done", race.error);
    assert.match(race.summary!, /Winner: Candidate A — claude/);
  } finally {
    delete process.env.FAKE_FAIL_VENDOR;
  }
});

test("changes made by a read-only step are reverted", async () => {
  const run = await runPattern("pipeline", { planner: ["agy"], builder: ["codex"], reviewer: ["claude"] }, "SNEAKY task");
  assert.equal(run.status, "done", run.error);
  // The read-only planner wrote sneaky.txt and had it reverted (the write-mode builder may write it legitimately later).
  const log = readFileSync(join(process.env.CODEFLOW_HOME!, "runs", `${run.id}.jsonl`), "utf8");
  assert.match(log, /Plan \(agy\) modified files in read-only mode; changes were reverted/);
});

test("agy: a denied tool with no answer is reported as a failure", async () => {
  const { agyAdapter } = await import("../src/adapters/agy.js");
  process.env.FAKE_AGY_DENY = "1";
  try {
    const events: any[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "codeflow-agy-"));
    const result = await agyAdapter.run({ prompt: "list files", cwd, mode: "read" }, (e) => events.push(e));
    assert.equal(result.ok, false);
    assert.match(result.error!, /denied: RunCommand/);
    const toolResult = events.find((e) => e.kind === "tool_result");
    assert.deepEqual([toolResult.isError, toolResult.output], [true, "permission check failed"]);
  } finally {
    delete process.env.FAKE_AGY_DENY;
  }
});

test("runs never touch the user's own checkout", () => {
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "original\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), "");
});
