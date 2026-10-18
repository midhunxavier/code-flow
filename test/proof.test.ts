import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Fail-to-pass proofs: a result's tests are put onto the base code, and the check should fail there.
const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-proof-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { proofOutcome } = await import("../src/checks.js");
const { isTestSide } = await import("../src/integrity.js");
type Run = import("../src/engine.js").Run;
type CheckResult = import("../src/checks.js").CheckResult;

const newRepo = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-proof-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "proof\n");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
};

let repo: string;
before(() => {
  repo = newRepo();
});

const manager = new RunManager();

async function run(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}, inRepo = repo): Promise<Run> {
  const r = await manager.start({ pattern: findPattern(pattern)!, task: "Add the feature", repo: inRepo, roles, options: {}, ...extra });
  await new Promise<void>((resolve) => {
    const check = () => r.status !== "running" && resolve();
    manager.subscribe(r.id, check);
    check();
  });
  return r;
}

const log = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const titles = (r: Run) => r.steps.map((s) => `${s.title}${s.kind === "agent" ? ` [${s.agent}]` : ""}:${s.status}`);
const proofOf = (r: Run) => r.proofs?.[r.artifacts[0]!.branch];
const filesOn = (branch: string, inRepo = repo) => execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: inRepo }).toString().split("\n");
const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
};

const result = (output: string, exitCode: number | null, extra: Partial<CheckResult> = {}): CheckResult => ({
  command: "npm test",
  ok: exitCode === 0,
  exitCode,
  timedOut: false,
  durationMs: 1,
  output,
  ...extra,
});

test("what a run on the base code proves", () => {
  assert.equal(proofOutcome(result("# pass 3", 0)).status, "unproven");
  const failing = proofOutcome(result("not ok 1 - parses dates\n  AssertionError: expected 2 to equal 3\n# fail 1", 1));
  assert.equal(failing.status, "proven");
  assert.match(failing.detail, /expected 2 to equal 3/);
  // A test that imports code only the change adds fails for the change, but that only shows the code is there.
  assert.equal(proofOutcome(result("ModuleNotFoundError: No module named 'pkg.dates'\n1 error during collection", 2, { command: "pytest -q" })).status, "weak");
  // A run that never reached the tests proves nothing either way.
  assert.equal(proofOutcome(result("/bin/sh: pytest: command not found", 127, { command: "pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("/usr/bin/python3: No module named pytest", 1, { command: "python3 -m pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("collected 0 items\n=== no tests ran ===", 5, { command: "pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("", null, { timedOut: true })).status, "unverified");
  assert.equal(proofOutcome(result("code-flow couldn't run it: Docker isn't available", null)).status, "unverified");
});

test("tests that fail on the base code only because they can't load are a weak proof, in each runner's words", () => {
  const weak = {
    pytest: [
      "==================================== ERRORS ====================================",
      "_________________ ERROR collecting tests/test_dates.py _________________",
      "ImportError while importing test module '/x/tests/test_dates.py'.",
      "E   ImportError: cannot import name 'parse_date' from 'pkg.dates' (/x/pkg/dates.py)",
      "=========================== short test summary info ============================",
      "ERROR tests/test_dates.py",
      "!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!",
      "1 error in 0.05s",
    ],
    node: [
      "✖ dates.test.mjs (41ms)",
      "  'test failed'",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/src/dates.mjs' imported from /x/dates.test.mjs",
      "ℹ tests 1",
      "ℹ pass 0",
      "ℹ fail 1",
    ],
    // The source Jest quotes around the import holds an expect(); that's not a failing assertion.
    jest: [
      "FAIL  test/dates.test.js",
      "  ● Test suite failed to run",
      "",
      "    Cannot find module '../src/dates' from 'test/dates.test.js'",
      "",
      "    > 1 | const { parseDate } = require('../src/dates');",
      "        | ^",
      "      2 | test('parses', () => {",
      "      3 |   expect(parseDate('2026-01-02')).toEqual(new Date(2026, 0, 2));",
      "Tests:       0 total",
    ],
    vitest: [" FAIL  test/dates.test.ts [ test/dates.test.ts ]", 'Error: Failed to resolve import "../src/dates" from "test/dates.test.ts". Does the file exist?', " Test Files  1 failed (1)"],
    go: ["# example.com/dates [example.com/dates.test]", "./dates_test.go:9:7: undefined: ParseDate", "FAIL\texample.com/dates [build failed]"],
    cargo: ["error[E0425]: cannot find function `parse_date` in this scope", "error: could not compile `dates` (lib test) due to 1 previous error"],
    unittest: ["ERROR: test_dates (unittest.loader._FailedTest.test_dates)", "ImportError: Failed to import test module: test_dates", "FAILED (errors=1)"],
  };
  for (const [runner, lines] of Object.entries(weak)) {
    const outcome = proofOutcome(result(lines.join("\n"), 1));
    assert.equal(outcome.status, "weak", runner);
    assert.ok(outcome.detail.length > 0, runner);
  }
  // A test that ran and failed on what it checks is full proof, also when another can't load.
  const proven = {
    pytest: ["FAILED tests/test_dates.py::test_parse - AssertionError: assert None == datetime.date(2026, 1, 2)", "ERROR tests/test_tz.py - ModuleNotFoundError: No module named 'pkg.tz'", "1 failed, 1 error in 0.08s"],
    jest: ["    expect(received).toEqual(expected) // deep equality", "    Expected: 2026-01-02", "    Received: undefined", "    Cannot find module './tz' from 'src/dates.js'"],
    vitest: ["AssertionError: expected undefined to deeply equal 2026-01-02T00:00:00.000Z", 'Error: Failed to resolve import "./tz" from "src/dates.ts"'],
    go: ["--- FAIL: TestParseDate (0.00s)", "    dates_test.go:12: got 0001-01-01, want 2026-01-02", "FAIL"],
  };
  for (const [runner, lines] of Object.entries(proven)) assert.equal(proofOutcome(result(lines.join("\n"), 1)).status, "proven", runner);
});

test("the tests side of a change: tests, fixtures and the runner's settings", () => {
  for (const path of ["src/dates.test.ts", "tests/test_dates.py", "tests/helpers.py", "spec/dates_spec.rb", "__snapshots__/x.snap", "testdata/in.json", "conftest.py", "jest.config.js", "vitest.config.ts"]) {
    assert.ok(isTestSide(path), path);
  }
  for (const path of ["src/dates.ts", "package.json", "vite.config.ts", "pyproject.toml", ".github/workflows/ci.yml", "README.md"]) {
    assert.ok(!isTestSide(path), path);
  }
});

test("loop until green: a check that already passes needs a test that fails without the change", async () => {
  const r = await run("loop", { workers: ["claude"] }, { loop: { check: "node --test" }, options: { maxRounds: 4 } });
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "passed");
  assert.deepEqual(titles(r), [
    "Baseline check:done",
    "Round 1 [claude]:done",
    "Check after round 1:done",
    // The change touches no tests, so the baseline is the run on the base code: no step needed.
    "Round 2 [claude]:done",
    "Check after round 2:done",
    "Proof: tests without the change:done",
  ]);
  const proof = proofOf(r)!;
  assert.equal(proof.status, "proven");
  assert.match(proof.tests.join(), /^proof-\w+\.test\.mjs$/);
  assert.match(proof.detail, /feature is implemented/);
  assert.equal(r.facts?.proof, "proven");
  assert.match(await log(r), /Not proven: `node --test` passes on the base code too/);
  assert.match(r.summary!, /Proven: `node --test` fails without the change \(with proof-\w+\.test\.mjs\)/);
  assert.match(r.summary!, /Round 1 \(Claude Code\): changed code, check passed — but no test fails without the change/);
});

test("loop until green: a change nobody proves is kept, and flagged", async () => {
  const r = await withEnv({ FAKE_NO_PROOF: "1" }, () => run("loop", { workers: ["claude"] }, { loop: { check: "node --test" } }));
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "passed");
  assert.deepEqual(titles(r), ["Baseline check:done", "Round 1 [claude]:done", "Check after round 1:done", "Round 2 [claude]:done", "Check after round 2:done"]);
  assert.equal(proofOf(r)?.status, "unproven");
  assert.equal(r.facts?.proof, "unproven");
  assert.match(await log(r), /no test fails without the change; review it before merging/);
  assert.match(r.summary!, /⚠ Not proven: no test fails without the change/);
});

test("loop until green: a failing baseline proves the fix without an extra run", async () => {
  // Fails until Claude writes its file: the check itself is the test.
  const r = await run("loop", { workers: ["claude"] }, { loop: { check: "ls claude-*.txt" } });
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(titles(r), ["Baseline check:failed", "Round 1 [claude]:done", "Check after round 1:done"]);
  assert.equal(proofOf(r)?.status, "proven");
});

test("pipeline: the builder is asked once for a test that fails without the change, and the reviewer sees the proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-proof-record-"));
  const r = await withEnv({ FAKE_RECORD_DIR: dir }, () => run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] }, { loop: { check: "node --test" } }));
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(titles(r), [
    "Plan [claude]:done",
    "Implement plan [codex]:done",
    "Check:done",
    "Proof: tests without the change:failed",
    "Add a test that fails without the change [codex]:done",
    "Check:done",
    "Proof: tests without the change:done",
    "Review (round 1) [agy]:done",
  ]);
  assert.equal(proofOf(r)?.status, "proven");
  assert.equal(r.facts?.proof, "proven");
  assert.match(r.summary!, /Approved, and `node --test` passes[\s\S]*Proven: `node --test` fails without the change/);
  const prompts = recorded(dir);
  assert.ok(prompts.some((p) => p.includes("Implement the plan") && p.includes("## Prove it")), "the builder hears about the proof up front");
  assert.ok(prompts.some((p) => p.includes('"verdict": "approve" | "changes_requested"') && p.includes("## Fail-to-pass: proven (run by code-flow)")), "the reviewer sees the proof");
});

test("pipeline: a test that never passes is undone, so asking for a proof doesn't cost a green result", async () => {
  const r = await withEnv({ FAKE_PROOF_BREAKS: "1" }, () =>
    run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] }, { loop: { check: "node --test" }, options: { checkFixes: 1 } }),
  );
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "passed");
  assert.deepEqual(titles(r), [
    "Plan [claude]:done",
    "Implement plan [codex]:done",
    "Check:done",
    "Proof: tests without the change:failed",
    "Add a test that fails without the change [codex]:done",
    "Check:failed",
    "Fix failing check (1/1) [codex]:done",
    "Check:failed",
    "Check:done",
    "Proof: tests without the change:failed",
    "Review (round 1) [agy]:done",
  ]);
  assert.match(await log(r), /The check fails since Codex added its test, and fixing didn't help; undoing that/);
  assert.ok(!filesOn(r.artifacts[0]!.branch).some((f) => f.startsWith("proof-")), "the broken test is gone");
  assert.equal(proofOf(r)?.status, "unproven");
});

test("test-first: tests that pass before anything is implemented go back to the tester", async () => {
  const r = await withEnv({ FAKE_TESTS_PASS_FIRST: "1" }, () => run("tdd", { tester: ["codex"], builder: ["claude"] }));
  assert.equal(r.status, "done", r.error);
  const steps = titles(r);
  assert.deepEqual(steps.slice(0, 4), ["Write failing tests [codex]:done", "New tests (should fail):done", "Make the tests fail first [codex]:done", "Revised tests (should fail):failed"]);
  assert.match(r.summary!, /All tests pass/);
});

test("race: each passing candidate is proven, and the judge sees it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-proof-record-"));
  const r = await withEnv({ FAKE_RECORD_DIR: dir }, () =>
    run("race", { contestants: ["claude", "codex"], judge: ["agy"] }, { loop: { check: "ls *-*.txt 2>/dev/null | grep -q ." } }),
  );
  assert.equal(r.status, "done", r.error);
  assert.equal(titles(r).filter((t) => t.startsWith("Proof: tests without the change")).length, 2);
  assert.ok(r.artifacts.every((a) => r.proofs?.[a.branch]?.status === "proven"));
  assert.match(r.summary!, /- A: claude — completed, check passes, proven/);
  const judge = recorded(dir).find((p) => p.includes('"winner"'))!;
  assert.equal(judge.match(/## Fail-to-pass: proven/g)?.length, 2);
  const proofs = judge.split("## Fail-to-pass").slice(1).map((part) => part.split("\n## ")[0]!);
  assert.ok(proofs.every((p) => !/claude|codex/i.test(p)), `proofs don't name the vendor:\n${proofs.join("\n---\n")}`);
});

test("single agent: the result's proof is reported, and nobody is asked for a test", async () => {
  const r = await run("solo", { agent: ["claude"] }, { loop: { check: "node --test" } });
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(titles(r), ["Your task [claude]:done", "Check:done", "Proof: tests without the change:failed"]);
  assert.equal(r.facts?.proof, "unproven");
  assert.match(r.summary!, /⚠ Not proven/);
});

test("single agent: a test that only fails on the base code because its import isn't there is a weak proof", async () => {
  const r = await withEnv({ FAKE_IMPORT_TEST: "1" }, () => run("solo", { agent: ["claude"] }, { loop: { check: "node --test" } }, newRepo()));
  assert.equal(r.status, "done", r.error);
  assert.equal(proofOf(r)?.status, "weak");
  assert.deepEqual(proofOf(r)?.tests, ["feature.test.mjs"]);
  assert.match(proofOf(r)!.detail, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  assert.equal(r.facts?.proof, "weak");
  assert.match(r.summary!, /⚠ Weak proof: `node --test` fails without the change only because its tests can't load there/);
  assert.match(await log(r), /Weakly proven: with this change's tests \(feature\.test\.mjs\) on the base code/);
  const proofStep = r.steps.find((s) => s.title === "Proof: tests without the change");
  assert.equal(proofStep?.status, "done", "it does fail without the change");
});

test("a package the change adds is installed on the base code too, so its absence can't pass for a proof", async () => {
  // `node install.mjs` stands in for `npm ci`: it installs what package.json lists.
  const install = [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'for (const name of Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {})) {',
    "  mkdirSync(`node_modules/${name}`, { recursive: true });",
    '  writeFileSync(`node_modules/${name}/package.json`, JSON.stringify({ name, type: "module", main: "index.js" }));',
    '  writeFileSync(`node_modules/${name}/index.js`, "export default (s, n) => s.padStart(n);\\n");',
    "}",
  ].join("\n");
  const deps = newRepo({ "package.json": JSON.stringify({ name: "deps", type: "module", dependencies: {} }), "install.mjs": install, ".gitignore": "node_modules/\n" });
  const r = await withEnv({ FAKE_ADDS_DEP: "1" }, () => run("solo", { agent: ["claude"] }, { loop: { check: "node --test", setup: "node install.mjs" } }, deps));
  assert.equal(r.status, "done", r.error);
  assert.equal(r.verdict, "passed");
  assert.deepEqual(titles(r).slice(2), [
    "Check:done",
    "Setup proof checkout:done",
    "Setup proof checkout (the change's dependencies):done",
    // With pad-fake installed, its test passes on the base code: nothing needs the change.
    "Proof: tests without the change:failed",
  ]);
  const proof = proofOf(r)!;
  assert.equal(proof.status, "unproven", proof.detail);
  assert.deepEqual(proof.tests, ["pad.test.mjs"]);
});

test('"prove": false in .codeflow/config.json turns proofs off', async () => {
  const off = newRepo({ ".codeflow/config.json": JSON.stringify({ prove: false }) });
  const r = await run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] }, { loop: { check: "node --test" } }, off);
  assert.equal(r.status, "done", r.error);
  assert.ok(!r.steps.some((s) => s.title.startsWith("Proof") || s.title.startsWith("Add a test")));
  assert.equal(r.proofs, undefined);
});

test("setup runs once in the proof checkout, which is removed when the run ends", async () => {
  const r = await run("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] }, { loop: { check: "node --test", setup: "true" } });
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(r.steps.filter((s) => s.kind === "setup").map((s) => s.title), ["Setup build", "Setup proof checkout"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
  assert.ok(!worktrees.includes(".proof-check"), worktrees);
});

/** Prompts the fake CLIs recorded (FAKE_RECORD_DIR). */
function recorded(dir: string): string[] {
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).prompt as string);
}
