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
  // A test that imports code only the change adds fails for the change.
  assert.equal(proofOutcome(result("ModuleNotFoundError: No module named 'pkg.dates'\n1 error during collection", 2, { command: "pytest -q" })).status, "proven");
  // A run that never reached the tests proves nothing either way.
  assert.equal(proofOutcome(result("/bin/sh: pytest: command not found", 127, { command: "pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("/usr/bin/python3: No module named pytest", 1, { command: "python3 -m pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("collected 0 items\n=== no tests ran ===", 5, { command: "pytest" })).status, "unverified");
  assert.equal(proofOutcome(result("", null, { timedOut: true })).status, "unverified");
  assert.equal(proofOutcome(result("code-flow couldn't run it: Docker isn't available", null)).status, "unverified");
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
