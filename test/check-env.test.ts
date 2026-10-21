// A check that can't run here (the environment is wrong, not the code): code-flow compares with
// the base commit once, then sets the check aside instead of spending fix rounds on it.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-env-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { cantRunReason } = await import("../src/checks.js");
type Run = import("../src/engine.js").Run;
type CheckResult = import("../src/checks.js").CheckResult;

let repo: string;

// What pytest prints when conftest.py imports a package that isn't installed (exit code 4).
const CONFTEST_ERROR = [
  "ImportError while loading conftest '/repo/tests/conftest.py'.",
  "tests/conftest.py:3: in <module>",
  "    from pkg import server",
  "E   ModuleNotFoundError: No module named 'pkg'",
].join("\n");

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-env-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "env\n");
  const script = (name: string, body: string) => {
    writeFileSync(join(repo, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(repo, name), 0o755);
  };
  // Can't run anywhere: the package isn't installed, on the base commit or any branch.
  script("pytest", `cat <<'EOF'\n${CONFTEST_ERROR}\nEOF\nexit 4`);
  // Runs on the base commit; the builder's change (a codex-*.txt file) breaks collection.
  script("pytest-branch", `if ls codex-*.txt >/dev/null 2>&1; then cat <<'EOF'\n${CONFTEST_ERROR}\nEOF\nexit 4; fi\necho "1 passed in 0.01s"`);
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

const manager = new RunManager(findPattern);

async function run(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}): Promise<Run> {
  const r = await manager.start({ pattern: findPattern(pattern)!, task: "Make it work", repo, roles, options: {}, ...extra });
  return settle(r);
}

async function settle(r: Run): Promise<Run> {
  await new Promise<void>((resolve) => {
    const done = () => r.status !== "running" && resolve();
    manager.subscribe(r.id, done);
    done();
  });
  return r;
}

const log = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const titles = (r: Run) => r.steps.map((s) => `${s.title}:${s.status}`);
const pipeline = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] };
const result = (output: string, exitCode: number, command = "uv run --no-sync pytest -q"): CheckResult => ({ command, ok: exitCode === 0, exitCode, timedOut: false, durationMs: 1, output });

test("tells a check that can't run from one that fails", () => {
  assert.equal(cantRunReason(result(CONFTEST_ERROR, 4)), "ModuleNotFoundError: No module named 'pkg'");
  assert.equal(cantRunReason(result("/bin/sh: uv: command not found", 127)), "/bin/sh: uv: command not found");
  assert.equal(cantRunReason(result("/usr/bin/python3: No module named pytest", 1, "python3 -m pytest -q")), "/usr/bin/python3: No module named pytest");
  assert.equal(cantRunReason(result("error: Failed to spawn: `pytest`\n  Caused by: No such file or directory (os error 2)", 2)), "error: Failed to spawn: `pytest`");
  assert.equal(cantRunReason(result("Command not found: pytest", 1, "poetry run pytest -q")), "Command not found: pytest");
  assert.equal(cantRunReason(result("\nno tests ran in 0.01s\n", 5)), "no tests ran in 0.01s");
  assert.equal(cantRunReason(result("ERROR: file or directory not found: tests\n", 4)), "ERROR: file or directory not found: tests");
  assert.equal(
    cantRunReason(result("ERROR collecting tests/test_api.py\nE   ModuleNotFoundError: No module named 'pkg'\n!!! Interrupted: 1 error during collection !!!", 2)),
    "ModuleNotFoundError: No module named 'pkg'",
  );

  // The check ran: failing tests, a timeout, or an exit code that only means something to pytest.
  assert.equal(cantRunReason(result("FAILED tests/test_x.py::test_y - assert 1 == 2\n1 failed in 0.1s", 1)), undefined);
  assert.equal(cantRunReason(result("ok", 0)), undefined);
  assert.equal(cantRunReason({ ...result("", 1), timedOut: true }), undefined);
  assert.equal(cantRunReason(result("make: *** [test] Error 4", 4, "make test")), undefined);
  assert.equal(cantRunReason(result("ImportError: cannot import name 'x'", 1)), undefined, "an import the change broke is a failing test");
});

test("pipeline: a check that can't run on the base commit either gets no fix rounds, and review still runs", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-env-record-"));
  process.env.FAKE_RECORD_DIR = record;
  try {
    const r = await run("pipeline", pipeline, { loop: { check: "./pytest -q", setup: "true" } });
    assert.equal(r.status, "done", r.error);
    assert.deepEqual(titles(r), [
      "Setup build:done",
      "Plan:done",
      "Implement plan:done",
      "Check:failed",
      "Setup base commit:done",
      "Check on base commit:failed",
      "Review (round 1):done",
    ]);
    assert.deepEqual(r.checkCantRun, { command: "./pytest -q", reason: "ModuleNotFoundError: No module named 'pkg'" });
    assert.equal(r.verdict, undefined, "unknown, not failing");
    assert.match(
      await log(r),
      /The check can't run here: ModuleNotFoundError: No module named 'pkg'\. Set `setup` and `check` in \.codeflow\/config\.json/,
    );
    assert.match(r.summary!, /\*\*Approved\*\*/);
    assert.doesNotMatch(r.summary!, /still fails/);

    // The reviewer is told nothing was tested.
    const review = readdirSync(record)
      .map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string })
      .find((p) => p.prompt.includes("review it critically"));
    assert.match(review!.prompt, /couldn't run.*not because of this change/s);

    // The base commit's checkout is gone again.
    assert.ok(!existsSync(join(r.worktreeDir, ".base-check")));
    assert.doesNotMatch(execFileSync("git", ["worktree", "list"], { cwd: repo }).toString(), /\.base-check/);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("pipeline: when only the change breaks the check, it's a failing check like any other", async () => {
  const r = await run("pipeline", pipeline, { loop: { check: "./pytest-branch -q" } });
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(titles(r), [
    "Plan:done",
    "Implement plan:done",
    "Check:failed",
    "Check on base commit:done",
    "Fix failing check (1/2):done",
    "Check:failed",
    "Fix failing check (2/2):done",
    "Check:failed",
  ]);
  assert.equal(r.checkCantRun, undefined);
  assert.equal(r.verdict, "failing");
  assert.match(await log(r), /It runs on the base commit, so the change broke it/);
});

test("loop: a baseline that can't run ends the run before any agent turn, and waits in the inbox", async () => {
  const r = await run("loop", { workers: ["codex", "claude"] }, { loop: { check: "./pytest -q" }, trigger: { id: "a1", name: "Nightly", via: "manual" } });
  assert.equal(r.status, "done", r.error);
  // The baseline runs on the base commit itself: nothing to compare with.
  assert.deepEqual(titles(r), ["Baseline check:failed"]);
  assert.equal(r.usage.agentSteps, 0);
  assert.equal(r.verdict, undefined);
  assert.match(r.summary!, /No rounds run: the check can't run here\*\* — ModuleNotFoundError: No module named 'pkg'/);
  assert.equal(r.triage?.state, "pending", "not archived as a run that changed nothing");
  assert.equal(r.archived, false);
});

test("race: candidates checked at once compare with the base commit only once", async () => {
  const r = await run("race", { contestants: ["claude", "codex"], judge: ["claude"] }, { loop: { check: "nosuchtool-xyz --run" } });
  assert.equal(r.status, "done", r.error);
  assert.equal(r.steps.filter((s) => s.title === "Check on base commit").length, 1);
  assert.match(r.checkCantRun!.reason, /nosuchtool-xyz: (command )?not found/);
  assert.equal(r.verdict, undefined);
  assert.ok(r.steps.some((s) => s.title === "Judge candidates"), "the judge decides without the check");
  assert.doesNotMatch(await log(r), /fails the check/);
});

test("resume: the comparison with the base commit is replayed, not run again", async () => {
  // Stops before the review (the third agent turn); resuming replays the checks from the journal.
  const stopped = await run("pipeline", pipeline, { loop: { check: "./pytest -q", maxSteps: 2 } });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.checkCantRun?.reason, "ModuleNotFoundError: No module named 'pkg'");
  const r = await settle(await manager.resume(stopped.id));
  assert.equal(r.status, "done", r.error);
  assert.equal(r.steps.filter((s) => s.title === "Check on base commit").length, 1);
  assert.equal(r.checkCantRun?.reason, "ModuleNotFoundError: No module named 'pkg'");
  assert.equal(r.verdict, undefined);
  assert.ok(r.steps.some((s) => s.title === "Review (round 1)" && s.status === "done"));
  assert.ok(!r.steps.some((s) => s.title.startsWith("Fix failing check")));
});
