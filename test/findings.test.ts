import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Checkable review findings: a reviewer shows a bug with a test (a repro), code-flow runs it on
// the result, and approval goes by the findings that block, not by the reviewer's verdict word.
const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-findings-home-"));

const { RunManager, blocks, reproProblem } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { reproOutcome } = await import("../src/checks.js");
const { writeFileInside } = await import("../src/fs.js");
type Run = import("../src/engine.js").Run;
type CheckResult = import("../src/checks.js").CheckResult;

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-findings-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "findings\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});
// The fake reviewer raises a FAKE_REPRO=fails finding in the first review only.
beforeEach(() => rmSync(join(process.env.CODEFLOW_HOME!, ".repro-reviewed-once"), { force: true }));

const manager = new RunManager(findPattern);
const pipeline = { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] };

const settle = (r: Run) =>
  new Promise<Run>((resolve) => {
    const check = () => r.status !== "running" && resolve(r);
    manager.subscribe(r.id, check);
    check();
  });

async function run(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}): Promise<Run> {
  return settle(await manager.start({ pattern: findPattern(pattern)!, task: "Add the feature", repo, roles, options: {}, ...extra }));
}

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
};

const log = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const titles = (r: Run) => r.steps.map((s) => `${s.title}${s.kind === "agent" ? ` [${s.agent}]` : ""}:${s.status}`);
const reviewOf = (r: Run) => r.findings?.[r.artifacts[0]!.branch];
/** Prompts the fake CLIs recorded (FAKE_RECORD_DIR). */
const recorded = (dir: string): string[] => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).prompt as string);
const recordDir = () => mkdtempSync(join(tmpdir(), "codeflow-findings-record-"));

const result = (output: string, exitCode: number | null, extra: Partial<CheckResult> = {}): CheckResult => ({
  command: "node --test",
  ok: exitCode === 0,
  exitCode,
  timedOut: false,
  durationMs: 1,
  output,
  ...extra,
});

test("the severity gate: high and medium block, low is a suggestion, and evidence overrules the reviewer", () => {
  assert.equal(blocks("high", "confirmed"), true);
  assert.equal(blocks("high", "refuted"), false, "a bug whose own test passes is a false alarm");
  assert.equal(blocks("high", "unconfirmed"), false, "a bug claim nobody showed doesn't block");
  assert.equal(blocks("high", "unverified"), true, "a test code-flow couldn't run falls back to the reviewer's word");
  assert.equal(blocks("medium", "unconfirmed"), true);
  assert.equal(blocks("medium", "refuted"), false);
  assert.equal(blocks("low", "confirmed"), false);
});

test("what code-flow will run as a repro: a test file, a plain test command", () => {
  const ok = { path: "tests/test_bound.py", contents: "def test_x(): assert False\n", command: "" };
  assert.equal(reproProblem(ok), undefined);
  assert.equal(reproProblem({ ...ok, command: "pytest tests/test_bound.py" }), undefined);
  assert.equal(reproProblem({ path: "", contents: "", command: "npm test" }), undefined, "a command alone runs tests that are there");
  assert.match(reproProblem({ ...ok, command: "pytest && rm -rf ." })!, /isn't a plain test-runner command/);
  assert.match(reproProblem({ ...ok, path: "/etc/x.test.js" })!, /isn't a path inside the repo/);
  assert.match(reproProblem({ ...ok, path: "../x.test.js" })!, /isn't a path inside the repo/);
  assert.match(reproProblem({ ...ok, path: "src/bound.py" })!, /isn't named like a test file/, "a repro can't replace the code it's about");
  assert.match(reproProblem({ ...ok, contents: " " })!, /no contents/);
  assert.match(reproProblem({ path: "", contents: "x", command: "" })!, /has no path/);
});

test("what a run of a reviewer's test says about the result", () => {
  assert.equal(reproOutcome(result("# pass 2", 0)).status, "refuted");
  const failing = reproOutcome(result("not ok 1 - loop bound\n  AssertionError: off by one\n# fail 1", 1));
  assert.equal(failing.status, "confirmed");
  assert.match(failing.detail, /off by one/);
  assert.equal(reproOutcome(result("", null, { timedOut: true })).status, "unverified");
  assert.equal(reproOutcome(result("/bin/sh: pytest: command not found", 127, { command: "pytest" })).status, "unverified");
  assert.equal(reproOutcome(result("collected 0 items", 5, { command: "pytest -q" })).status, "unverified");
});

test("pipeline: a reviewer's test that fails confirms the bug; the builder gets it with how it fails, and the reviewer gets its answer", async () => {
  const dir = recordDir();
  const r = await withEnv({ FAKE_REPRO: "fails", FAKE_RECORD_DIR: dir }, () => run("pipeline", pipeline, { loop: { check: "node --test" } }));
  assert.equal(r.status, "done", r.error);
  const steps = titles(r);
  const review = steps.indexOf("Review (round 1) [agy]:done");
  assert.deepEqual(steps.slice(review, review + 3), [
    "Review (round 1) [agy]:done",
    "Reviewer's test: Off-by-one in the loop bound:failed",
    "Address review (round 1) [codex]:done",
  ]);
  assert.equal(steps.at(-1), "Review (round 2) [agy]:done");
  assert.match(await log(r), /Review round 1: changes_requested \(1 issues; 1 blocking, 1 confirmed by a failing test\)/);
  assert.match(r.summary!, /Approved, and `node --test` passes/);
  assert.equal(r.facts?.approved, true);

  const prompts = recorded(dir);
  const address = prompts.find((p) => p.includes("checked by code-flow"))!;
  assert.match(address, /## Confirmed: the reviewer's test fails on your code \(these block\)/);
  assert.match(address, /off by one: the loop runs once too often/, "with how it fails");
  assert.match(address, /The test, `bound\.test\.mjs`:[\s\S]*test\("loop bound"/, "and the test itself");
  const second = prompts.find((p) => p.includes("The builder addressed your previous review"))!;
  assert.match(second, /## The builder's answer to your review\n.*codex/);
  // The reviewer's test ran in a checkout of its own: the result branch doesn't have it.
  assert.ok(!execFileSync("git", ["ls-tree", "-r", "--name-only", r.artifacts[0]!.branch], { cwd: repo }).toString().includes("bound.test.mjs"));
});

test("pipeline: a reviewer's test that passes is a false alarm: it doesn't block, and costs no fix round", async () => {
  const r = await withEnv({ FAKE_REPRO: "passes" }, () => run("pipeline", pipeline, { loop: { check: "node --test" } }));
  assert.equal(r.status, "done", r.error);
  assert.equal(titles(r).filter((t) => t.startsWith("Reviewer's test")).join(), "Reviewer's test: Off-by-one in the loop bound:done");
  assert.ok(!r.steps.some((s) => s.title.startsWith("Address review")));
  assert.equal(r.facts?.approved, true, "approved, though the reviewer requested changes");
  const finding = reviewOf(r)!.findings[0]!;
  assert.equal(finding.check.status, "refuted");
  assert.equal(finding.blocking, false);
  assert.equal(reviewOf(r)!.verdict, "changes_requested");
  assert.match(r.summary!, /Approved[\s\S]*1 false alarm \(the reviewer's own test passes\)/);
});

test("pipeline: a high-severity claim without a test is marked unconfirmed and doesn't block", async () => {
  const r = await withEnv({ FAKE_REPRO: "none" }, () => run("pipeline", pipeline, { loop: { check: "node --test" } }));
  assert.equal(r.status, "done", r.error);
  assert.ok(!r.steps.some((s) => s.title.startsWith("Reviewer's test") || s.title.startsWith("Address review")));
  assert.equal(reviewOf(r)!.findings[0]!.check.status, "unconfirmed");
  assert.equal(r.facts?.approved, true);
  assert.match(r.summary!, /⚠ 1 unconfirmed high-severity claim \(no test shows it; not blocking\)/);
});

test('pipeline: a confirmed finding blocks even under an "approve" verdict, run with the reviewer\'s own command', async () => {
  const r = await withEnv({ FAKE_REPRO: "approve-fails" }, () => run("pipeline", pipeline, { loop: { check: "node --test" }, options: { maxRounds: 1 } }));
  assert.equal(r.status, "done", r.error);
  const check = reviewOf(r)!.findings[0]!.check;
  assert.equal(check.status, "confirmed");
  assert.equal(check.command, "node --test tests/bound.test.mjs");
  assert.equal(r.facts?.approved, false);
  assert.match(r.summary!, /Not approved: findings still block after the last review round/);
  assert.match(r.summary!, /## Open review findings\n- \*\*high\*\* `feature\.txt` — Off-by-one in the loop bound — ✓ confirmed: its test fails · blocks/);
});

test("pipeline: a test the check never runs refutes nothing; the finding blocks on the reviewer's word", async () => {
  const r = await withEnv({ FAKE_REPRO: "uncollected" }, () => run("pipeline", pipeline, { loop: { check: "node --test" }, options: { maxRounds: 1 } }));
  assert.equal(r.status, "done", r.error);
  const finding = reviewOf(r)!.findings[0]!;
  assert.equal(finding.check.status, "unverified");
  assert.match(finding.check.detail, /as many as without, so it didn't run notes\/bound\.spec\.txt/);
  assert.equal(finding.blocking, true);
  assert.equal(r.facts?.approved, false);
});

test("debate: a false alarm doesn't send the build back to the builder", async () => {
  const r = await withEnv({ FAKE_REPRO: "passes" }, () =>
    run("debate", { debaters: ["claude", "codex"], synthesizer: ["claude"], builder: ["codex"], reviewer: ["agy"] }, { loop: { check: "node --test" }, options: { rounds: 0 } }),
  );
  assert.equal(r.status, "done", r.error);
  assert.ok(r.steps.some((s) => s.title.startsWith("Reviewer's test") && s.status === "done"));
  assert.ok(!r.steps.some((s) => s.title === "Address review"));
  assert.equal(r.facts?.approved, true);
  assert.match(r.summary!, /Review by agy: approved\./);
});

test("supervisor: a confirmed finding goes to the supervisor with how it fails, and the reviewer looks again", async () => {
  const dir = recordDir();
  const r = await withEnv({ FAKE_REPRO: "fails", FAKE_RECORD_DIR: dir }, () =>
    run("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"], reviewer: ["agy"] }, { loop: { check: "node --test" } }),
  );
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(
    r.steps.filter((s) => /^(Integration review|Reviewer's test|Fix integration issues)/.test(s.title)).map((s) => `${s.title}:${s.status}`),
    ["Integration review:done", "Reviewer's test: Off-by-one in the loop bound:failed", "Fix integration issues:done", "Integration review (2):done"],
  );
  const fix = recorded(dir).find((p) => p.includes("Fix what blocks, run the tests"))!;
  assert.match(fix, /## Confirmed: the reviewer's test fails on your code[\s\S]*off by one: the loop runs once too often/);
  assert.equal(r.facts?.approved, true);
  assert.match(r.summary!, /agy: approved — 0 issues, 0 blocking/);
});

test("review council: findings rank by severity, then by a confirming test, then by agreement; each reviewer's test runs once", async () => {
  const dir = recordDir();
  const r = await withEnv({ FAKE_REPRO: "council", FAKE_RECORD_DIR: dir }, () =>
    run("council", { reviewers: ["claude", "codex"], chair: ["agy"] }, { loop: { check: "node --test" } }),
  );
  assert.equal(r.status, "done", r.error);
  const review = r.review!;
  assert.deepEqual(
    review.findings.map((f) => [f.severity, f.problem, f.check?.status, f.raisedBy.length]),
    [
      ["high", "Off-by-one in the loop", "confirmed", 1],
      ["high", "Missing null check", "refuted", 2],
      ["medium", "No docs for the feature", "unconfirmed", 2],
      ["low", "Typo", "unconfirmed", 1],
    ],
  );
  // Both reviewers sent the same two tests, and the chair kept them: two runs in all.
  assert.deepEqual(
    r.steps.filter((s) => s.kind === "check").map((s) => `${s.title}:${s.status}`),
    ["Reviewer A's test: Off-by-one in the loop:failed", "Reviewer A's test: Missing null check:done"],
  );
  const chair = recorded(dir).find((p) => p.includes('"raised_by"'))!;
  assert.match(chair, /"checked_by_code_flow": "confirmed: `node --test` fails with its test on this code"/);
  assert.match(chair, /"checked_by_code_flow": "false alarm: `node --test` passes with its test on this code"/);
  assert.match(review.markdown, /Off-by-one in the loop[^\n]*\n[^\n]*\n[^\n]*\n {3}\*Checked by code-flow:\* ✓ confirmed: its test fails/);
  assert.match(review.markdown, /\*Checked by code-flow:\* ✗ not confirmed: its test passes \(a false alarm\)/);
});

test("a reviewer's test isn't written through a symbolic link in the code under review", async () => {
  // The code has a tracked `linked` symlink to a folder outside the repo, as a fork's PR could.
  const outside = mkdtempSync(join(tmpdir(), "codeflow-findings-outside-"));
  const linkedRepo = mkdtempSync(join(tmpdir(), "codeflow-findings-linked-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: linkedRepo });
  git("init", "-q");
  writeFileSync(join(linkedRepo, "README.md"), "linked\n");
  symlinkSync(outside, join(linkedRepo, "linked"));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  const r = await withEnv({ FAKE_REPRO: "symlink" }, () => run("pipeline", pipeline, { repo: linkedRepo, loop: { check: "node --test" }, options: { maxRounds: 1 } }));
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside the checkout");
  const [finding] = r.findings![r.artifacts[0]!.branch]!.findings;
  assert.equal(finding!.check.status, "unconfirmed");
  assert.match(finding!.check.detail, /code-flow didn't write the reviewer's test: `linked\/.codeflow\/config.test.mjs` goes through a symbolic link \(`linked`\)/);
  assert.ok(!r.steps.some((s) => s.title.startsWith("Reviewer's test")), "the test never ran");
});

test("files from an agent are written inside the checkout only, never through a link", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeflow-inside-"));
  const outside = mkdtempSync(join(tmpdir(), "codeflow-outside-"));
  writeFileSync(join(outside, "target.txt"), "mine\n");
  symlinkSync(outside, join(root, "tests"));
  symlinkSync(join(outside, "target.txt"), join(root, "a.test.mjs"));
  writeFileSync(join(root, "notes"), "a file\n");

  assert.match((await writeFileInside(root, "tests/.codeflow/config.json", "{}"))!, /goes through a symbolic link \(`tests`\)/);
  assert.match((await writeFileInside(root, "a.test.mjs", "x"))!, /is a symbolic link/);
  assert.match((await writeFileInside(root, "notes/b.test.mjs", "x"))!, /`notes`, which isn't a folder/);
  assert.match((await writeFileInside(root, "../escape.test.mjs", "x"))!, /isn't a path inside the checkout/);
  assert.deepEqual(readdirSync(outside), ["target.txt"]);
  assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "mine\n");

  assert.equal(await writeFileInside(root, "spec/deep/c.test.mjs", "ok\n"), undefined);
  assert.equal(readFileSync(join(root, "spec/deep/c.test.mjs"), "utf8"), "ok\n");
});

test("review council: the verdict goes by what blocks, not by the chair's word", async () => {
  const council = { reviewers: ["claude", "codex"], chair: ["agy"] };
  // The chair approves, but a test confirms one bug and a medium finding stands.
  const approved = await withEnv({ FAKE_REPRO: "council", FAKE_CHAIR_VERDICT: "approve" }, () => run("council", council, { loop: { check: "node --test" } }));
  assert.equal(approved.status, "done", approved.error);
  assert.equal(approved.review?.verdict, "changes_requested");
  assert.match(approved.review!.markdown, /^\*\*Review council: Changes requested\*\*/);
  assert.match(await log(approved), /The chair approved, but 2 findings block once code-flow has run their tests, so the review says Changes requested/);

  // The chair requests changes over a false alarm and a suggestion: nothing blocks.
  const rejected = await withEnv({ FAKE_REPRO: "council-false-alarms" }, () => run("council", council, { loop: { check: "node --test" } }));
  assert.equal(rejected.status, "done", rejected.error);
  assert.equal(rejected.review?.verdict, "approve");
  assert.deepEqual(
    rejected.review!.findings.map((f) => [f.severity, f.check?.status]),
    [
      ["high", "refuted"],
      ["low", "unconfirmed"],
    ],
  );
  assert.match(rejected.review!.markdown, /^\*\*Review council: Approve\*\*/);
  assert.match(await log(rejected), /The chair requested changes, but no finding blocks once code-flow has run their tests, so the review says Approve/);
});

test("resume: a reviewer's test is replayed from the journal, not run again", async () => {
  // Stops before the builder answers the review (the fifth agent turn), after the test ran.
  const stopped = await withEnv({ FAKE_REPRO: "fails" }, () => run("pipeline", pipeline, { loop: { check: "node --test", maxSteps: 4 } }));
  assert.equal(stopped.status, "stopped");
  assert.equal(reviewOf(stopped)?.findings[0]?.check.status, "confirmed");
  const r = await withEnv({ FAKE_REPRO: "fails" }, async () => settle(await manager.resume(stopped.id)));
  assert.equal(r.status, "done", r.error);
  assert.equal(r.steps.filter((s) => s.title.startsWith("Reviewer's test")).length, 1);
  assert.ok(r.steps.some((s) => s.title === "Address review (round 1)" && s.status === "done"));
  assert.equal(r.facts?.approved, true);
});
