// M7: the guarantees code-flow makes are enforced, not just intended — processes stop when
// asked, runs can't start twice, read-only means read-only, passing checks are evidence, and
// what runs cost is counted.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-m7-home-"));
process.env.CODEFLOW_RETRY_DELAYS_MS = "50,50";

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { countTests, failureExcerpt, testCounts } = await import("../src/checks.js");
const { fitDiff } = await import("../src/diff.js");
const { extractJson } = await import("../src/json.js");
const { Slots } = await import("../src/slots.js");
const { appendLine, flushWrites, readJsonLines, loadJournal, acquireLock, RUNS_DIR, JOURNAL_VERSION } = await import("../src/store.js");
const { changesRunner, inspectChanges } = await import("../src/integrity.js");
const { computeStats, rankAgents } = await import("../src/stats.js");
const { resolveAuto } = await import("../src/routing.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
const commitAllIn = (cwd: string, msg: string) => {
  sh(cwd, "add", "-A");
  sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
};

function newRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-m7-repo-"));
  sh(dir, "init", "-q", "-b", "main");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  commitAllIn(dir, "init");
  return dir;
}

before(() => {
  repo = newRepo({ "README.md": "sample\n", ".gitignore": "*.local\n" });
});

async function idle(manager: Manager, run: Run) {
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

async function runPattern(id: string, roles: Record<string, any>, task = "Do the thing", extra: Record<string, unknown> = {}, manager: Manager = new RunManager(findPattern)) {
  const run = await manager.start({ pattern: findPattern(id)!, task, repo, roles, options: {}, ...extra });
  return { run: await idle(manager, run), manager };
}

const logs = async (m: Manager, run: Run) => (await m.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pipeline = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] };

// ---------------------------------------------------------------- processes
test("a background process an agent leaves running neither hangs the step nor survives it", async () => {
  const pidfile = join(mkdtempSync(join(tmpdir(), "codeflow-m7-pid-")), "linger.pid");
  process.env.FAKE_LINGER_VENDOR = "codex";
  process.env.FAKE_LINGER_PIDFILE = pidfile;
  const started = Date.now();
  try {
    const { run } = await runPattern("pipeline", pipeline);
    assert.equal(run.status, "done", run.error);
  } finally {
    delete process.env.FAKE_LINGER_VENDOR;
    delete process.env.FAKE_LINGER_PIDFILE;
  }
  // Each lingering `sleep 30` held the CLI's stdout open; waiting for it would take 30 s a step.
  assert.ok(Date.now() - started < 25_000, `took ${Date.now() - started} ms`);
  const pid = Number(readFileSync(pidfile, "utf8"));
  await until(() => !alive(pid), 8_000);
});

// ---------------------------------------------------------------- resume
test("resuming twice at once starts the run once", async () => {
  process.env.FAKE_FAIL_VENDOR = "codex";
  const { run, manager } = await runPattern("pipeline", pipeline);
  delete process.env.FAKE_FAIL_VENDOR;
  assert.equal(run.status, "failed");
  const [a, b] = await Promise.allSettled([manager.resume(run.id), manager.resume(run.id)]);
  assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"]);
  assert.match(((a.status === "rejected" ? a : b) as PromiseRejectedResult).reason.message, /already running/);
  await idle(manager, run);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.steps.filter((s) => s.title === "Implement plan").length, 2, "the failed attempt and one retry — not two");
});

// ---------------------------------------------------------------- read-only
test("a read-only step that commits has its commit undone", async () => {
  const { run, manager } = await runPattern("pipeline", pipeline, "COMMITS-IN-READ task");
  assert.equal(run.status, "done", run.error);
  assert.match(await logs(manager, run), /Plan \(claude\) modified files in read-only mode; changes were reverted \(commits/);
  const branch = run.artifacts[0]!.branch;
  assert.doesNotMatch(sh(repo, "log", "--format=%s", branch), /sneaky commit/);
  assert.ok(!sh(repo, "ls-tree", "-r", "--name-only", branch).includes("committed-in-read.txt"));
});

test("a read-only step that deletes its worktree's .git fails, says why, and your checkout is untouched", async () => {
  const yours = newRepo({ "a.txt": "one\n" });
  writeFileSync(join(yours, "a.txt"), "two\n");
  commitAllIn(yours, "second");
  writeFileSync(join(yours, "a.txt"), "my uncommitted edit\n");
  const head = sh(yours, "rev-parse", "HEAD");
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("pipeline")!, task: "DELETES-GIT-IN-READ task", repo: yours, roles: pipeline as Record<string, any>, options: {} }));
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /Couldn't undo what this read-only step changed: .* isn't the checkout code-flow expects \(its \.git is missing\)/);
  assert.match(await logs(manager, run), /Plan \(claude\) is read-only, but what it changed couldn't be undone: .*its \.git is missing.*Nothing was changed/);
  assert.equal(run.steps.find((s) => s.title === "Plan")?.status, "failed");
  assert.ok(!run.steps.some((s) => s.title === "Implement plan"), "nothing ran after it");
  // Restoring would have reset your checkout to the worktree's commit and dropped your edit.
  assert.equal(sh(yours, "rev-parse", "HEAD"), head);
  assert.equal(sh(yours, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(readFileSync(join(yours, "a.txt"), "utf8"), "my uncommitted edit\n");
  assert.equal(sh(yours, "status", "--porcelain", "--untracked-files=no"), "M a.txt");
});

// ---------------------------------------------------------------- evidence
test("loop: a pass that comes from deleting the failing test isn't accepted until the agent is told; the result is flagged", async () => {
  const tampered = newRepo({
    "failing.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("the feature works", () => assert.fail("not implemented"));\n',
  });
  process.env.FAKE_TAMPER = "1";
  const manager = new RunManager(findPattern);
  let run: Run;
  try {
    run = await idle(
      manager,
      await manager.start({ pattern: findPattern("loop")!, task: "Make the test pass", repo: tampered, roles: { workers: ["claude"] }, options: { maxRounds: 4 }, loop: { check: "node --test" } }),
    );
  } finally {
    delete process.env.FAKE_TAMPER;
  }
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.steps.filter((s) => s.kind === "agent").map((s) => s.title), ["Round 1", "Round 2"], "round 1's pass didn't end the loop");
  const text = await logs(manager, run);
  assert.match(text, /The check passes, but only after changes to the tests/);
  assert.match(text, /kept its test changes after being asked to undo them; the pass doesn't count/);
  const issues = run.integrity?.[run.artifacts[0]!.branch] ?? [];
  assert.deepEqual(issues.map((i) => i.kind).sort(), ["deleted-test", "fewer-tests"]);
  // The result stays for you to review, but the pass isn't evidence: no verdict, nobody credited.
  assert.equal(run.verdict, undefined);
  assert.equal(run.facts?.solvedBy, undefined);
  assert.match(run.summary!, /The check passes only with changes to the tests\*\* after 2 rounds/);
});

test("loop: a pass the last round gets only by deleting the failing test doesn't count — no verdict, nobody credited", async () => {
  const tampered = newRepo({
    "failing.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("the feature works", () => assert.fail("not implemented"));\n',
  });
  process.env.FAKE_TAMPER = "1";
  const manager = new RunManager(findPattern);
  let run: Run;
  try {
    run = await idle(
      manager,
      await manager.start({ pattern: findPattern("loop")!, task: "Make the test pass", repo: tampered, roles: { workers: ["claude"] }, options: { maxRounds: 1 }, loop: { check: "node --test" } }),
    );
  } finally {
    delete process.env.FAKE_TAMPER;
  }
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.steps.filter((s) => s.kind === "agent").map((s) => s.title), ["Round 1"]);
  assert.equal(run.steps.find((s) => s.title === "Check after round 1")?.status, "done", "the check passes");
  assert.equal(run.verdict, undefined, "a pass on deleted tests isn't a pass");
  assert.equal(run.facts?.solvedBy, undefined, "and nobody gets credit for it");
  assert.match(run.summary!, /\*\*The check passes only with changes to the tests\*\* after 1 round — branch `[^`]+`; review them before merging/);
  assert.match(run.summary!, /## Changes to the tests that could hide the failure\n- \*\*high\*\* `failing\.test\.mjs`: test file deleted/);
  assert.doesNotMatch(run.summary!, /Proven|Not proven/);
});

test("race: nothing the judge can see names a vendor — not even the commit messages", async () => {
  const { run } = await runPattern("race", { contestants: ["claude", "codex"], judge: ["agy"] });
  assert.equal(run.status, "done", run.error);
  const subjects = sh(repo, "log", "--all", "--format=%s").split("\n").filter((s) => /candidate/i.test(s));
  assert.ok(subjects.length >= 2);
  assert.ok(subjects.every((s) => !/claude|codex|agy/i.test(s)), subjects.join("\n"));
  assert.equal(run.facts?.winner, "codex");
  assert.deepEqual(run.facts?.entrants, ["claude", "codex"]);
});

test("test-first: the builder's edits to the tests are undone, not just reported", async () => {
  process.env.FAKE_EDIT_TESTS = "1";
  let result: { run: Run; manager: Manager };
  try {
    result = await runPattern("tdd", { tester: ["codex"], builder: ["claude"] });
  } finally {
    delete process.env.FAKE_EDIT_TESTS;
  }
  const { run, manager } = result;
  assert.equal(run.status, "done", run.error);
  assert.match(await logs(manager, run), /Builder modified test files: spec\.test\.mjs; code-flow put them back/);
  const spec = sh(repo, "show", `${run.artifacts[0]!.branch}:spec.test.mjs`);
  assert.match(spec, /feature is implemented/, "the tester's test is what's on the branch");
});

test("test-first: a conftest.py the builder adds is undone like an edit to the tests", async () => {
  process.env.FAKE_BUILDER_TAMPER = "conftest";
  let result: { run: Run; manager: Manager };
  try {
    result = await runPattern("tdd", { tester: ["codex"], builder: ["claude"] });
  } finally {
    delete process.env.FAKE_BUILDER_TAMPER;
  }
  const { run, manager } = result;
  assert.equal(run.status, "done", run.error);
  assert.match(await logs(manager, run), /Builder modified test files: conftest\.py; code-flow put them back/);
  const branch = run.artifacts[0]!.branch;
  assert.ok(!sh(repo, "ls-tree", "-r", "--name-only", branch).split("\n").includes("conftest.py"), "the builder's conftest.py is gone");
  assert.equal(run.verdict, "passed", "the tests pass as the tester wrote them, so it counts");
});

test("test-first: runner settings the builder puts in package.json go back to it, and a pass doesn't count until they're gone", async () => {
  const pkg = newRepo({ "package.json": JSON.stringify({ name: "tdd-demo" }, null, 2) + "\n" });
  const tdd = async (mode: string, maxRounds: number) => {
    const dir = mkdtempSync(join(tmpdir(), "codeflow-m7-record-"));
    process.env.FAKE_BUILDER_TAMPER = mode;
    process.env.FAKE_RECORD_DIR = dir;
    const manager = new RunManager(findPattern);
    try {
      const run = await idle(manager, await manager.start({ pattern: findPattern("tdd")!, task: "Add the feature", repo: pkg, roles: { tester: ["codex"], builder: ["claude"] }, options: { maxRounds } }));
      const prompts = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { vendor: string; prompt: string });
      return { run, manager, builder: prompts.filter((p) => p.vendor === "claude").map((p) => p.prompt) };
    } finally {
      delete process.env.FAKE_BUILDER_TAMPER;
      delete process.env.FAKE_RECORD_DIR;
    }
  };

  // Told, the builder takes them out: the next round counts.
  const undone = await tdd("jest", 3);
  assert.equal(undone.run.status, "done", undone.run.error);
  assert.match(await logs(undone.manager, undone.run), /Builder changed how the tests run:\n- \*\*medium\*\* `package\.json`: adds `jest` settings/);
  assert.equal(undone.builder.length, 2);
  assert.match(undone.builder[1]!, /## You changed how the tests run\ncode-flow found these in your changes[^]*`package\.json`: adds `jest` settings: \{"testPathIgnorePatterns":\["spec\.test\.mjs"\]\}/);
  assert.equal(undone.run.verdict, "passed");
  assert.doesNotMatch(sh(pkg, "show", `${undone.run.artifacts[0]!.branch}:package.json`), /jest/);
  assert.ok(undone.run.steps.some((s) => s.title === "Try to break it (round 2)"), "the tester probes once they're gone");

  // It keeps them, round after round: the tests pass, but only the way it set them up to run.
  const kept = await tdd("jest-keeps", 2);
  assert.equal(kept.run.status, "done", kept.run.error);
  assert.equal(kept.builder.length, 2);
  assert.match(kept.builder[1]!, /You changed how the tests run/, "a round that leaves them in place is told again");
  assert.ok(!kept.run.steps.some((s) => s.title.startsWith("Try to break it")), "nothing is probed while they stand");
  assert.equal(kept.run.verdict, undefined, "no verdict on tests the builder changed how to run");
  assert.match(kept.run.summary!, /\*\*The tests pass only with the builder's changes to how they run\*\*/);
  assert.match(kept.run.summary!, /## Still open\n[^]*adds `jest` settings/);
});

test("supervisor: every worker gets the contracts, and a separate reviewer checks the integration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-m7-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  let run: Run;
  try {
    ({ run } = await runPattern("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"], reviewer: ["agy"] }));
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.equal(run.status, "done", run.error);
  const prompts = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { prompt: string });
  const workers = prompts.filter((p) => p.prompt.includes("Your subtask:"));
  assert.equal(workers.length, 2);
  assert.ok(workers.every((p) => p.prompt.includes("Contracts every part follows") && p.prompt.includes("Each part writes its own file")));
  const review = run.steps.find((s) => s.title === "Integration review")!;
  assert.deepEqual([review.agent, review.role], ["agy", "reviewer"]);
});

test("supervisor: a worker that changes nothing is reported as no changes, isn't merged, counts as a failed step, and the reviewer is told", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-m7-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  process.env.FAKE_NOOP_VENDOR = "codex";
  let result: { run: Run; manager: Manager };
  try {
    result = await runPattern("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"], reviewer: ["agy"] });
  } finally {
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.FAKE_NOOP_VENDOR;
  }
  const { run, manager } = result;
  assert.equal(run.status, "done", run.error);
  assert.match(run.summary!, /- Alpha part → claude: done/);
  assert.match(run.summary!, /- Beta part → codex: no changes \(codex looked around but changed nothing\.\)/);
  assert.doesNotMatch(run.summary!, /network access/, "only the first line of the answer");
  assert.doesNotMatch(run.summary!, /not re-reviewed/, "a separate reviewer reviewed the fixes");
  const beta = run.steps.find((s) => s.title === "Subtask: Beta part")!;
  assert.equal(beta.status, "failed");
  assert.equal(beta.error, "Made no changes: codex looked around but changed nothing.");
  assert.equal(computeStats([run]).agents.find((a) => a.agent === "codex")!.failures, 1);
  assert.match(await logs(manager, run), /Nothing to merge from "Beta part": codex made no changes/);
  const review = readdirSync(dir)
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { vendor: string; prompt: string })
    .find((p) => p.vendor === "agy" && p.prompt.includes('"verdict": "approve" | "changes_requested"'))!;
  assert.match(review.prompt, /The subtasks that produced work have been merged/);
  assert.match(review.prompt, /## Subtasks missing from the integration\n[^#]*- Beta part → codex: no changes/);
});

test("supervisor reviewing its own integration: its fixes aren't re-reviewed, and the result says so", async () => {
  rmSync(join(process.env.CODEFLOW_HOME!, ".reviewed-once"), { force: true });
  process.env.FAKE_REVIEW_FAIL_ONCE = "1";
  let result: { run: Run; manager: Manager };
  try {
    result = await runPattern("supervisor", { supervisor: ["claude"], workers: ["claude", "codex"], reviewer: [] });
  } finally {
    delete process.env.FAKE_REVIEW_FAIL_ONCE;
  }
  const { run, manager } = result;
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(
    run.steps.filter((s) => /^(Integration review|Fix integration issues)/.test(s.title)).map((s) => s.title),
    ["Integration review", "Fix integration issues"],
  );
  assert.match(run.summary!, /claude: findings block approval — 1 issues, 1 blocking, fixed by the supervisor, not re-reviewed/);
  assert.match(await logs(manager, run), /No separate reviewer: the supervisor reviews its own integration/);
});

// ---------------------------------------------------------------- follow-ups
test("follow-ups: a second reply runs as its own turn; after archiving, the worktree comes back set up; a deleted branch fails just that follow-up", async () => {
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("pipeline")!, task: "Follow-ups", repo, roles: pipeline as never, options: {}, loop: { setup: "echo ran > setup.local" } }));
  assert.equal(run.status, "done", run.error);
  const reply = async (message: string) => {
    await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message });
    return idle(manager, run);
  };
  await reply("First, add a README section");
  await reply("Then mention it in the summary");
  assert.equal(run.steps.filter((s) => s.title === "Your reply" && s.status === "done").length, 2, "both replies reached the agent");
  assert.deepEqual(run.followUps.map((f) => f.status), ["done", "done"]);

  const wt = run.worktrees.find((w) => w.name === "build")!.path;
  await manager.archive(run.id, { cleanup: true });
  assert.ok(!existsSync(wt));
  await reply("One more thing");
  assert.ok(existsSync(join(wt, "setup.local")), "setup ran in the re-attached worktree");
  assert.match(await logs(manager, run), /Re-attached build/);

  await manager.archive(run.id, { cleanup: true, deleteBranches: true });
  await reply("And another");
  assert.equal(run.status, "done", "a follow-up failing doesn't fail the finished run");
  assert.equal(run.followUps.at(-1)!.status, "failed");
  assert.match(run.followUps.at(-1)!.result!, /was deleted/);
});

// ---------------------------------------------------------------- limits, retries, usage
test("a passing failure (overloaded) is retried; running out of plan usage stops the run so it can be resumed", async () => {
  process.env.FAKE_TRANSIENT_VENDOR = "codex";
  let { run } = await runPattern("pipeline", pipeline);
  delete process.env.FAKE_TRANSIENT_VENDOR;
  assert.equal(run.status, "done", run.error);
  assert.equal(run.steps.find((s) => s.title === "Implement plan")!.retries, 1);

  process.env.FAKE_USAGE_LIMIT_VENDOR = "codex";
  let manager: Manager;
  try {
    ({ run, manager } = await runPattern("pipeline", pipeline));
  } finally {
    delete process.env.FAKE_USAGE_LIMIT_VENDOR;
  }
  assert.equal(run.status, "stopped");
  assert.match(run.stopReason!, /usage limit of Codex/);
  assert.equal(manager.quota.codex?.status, "limited");
  await manager.resume(run.id);
  await idle(manager, run);
  assert.equal(run.status, "done", run.error);
});

test("tokens and API-equivalent cost add up per step, per agent and per run", async () => {
  const { run } = await runPattern("pipeline", pipeline);
  assert.equal(run.status, "done", run.error);
  const claudeSteps = run.steps.filter((s) => s.agent === "claude");
  const codexSteps = run.steps.filter((s) => s.agent === "codex");
  const claude = run.usage.byAgent!.claude!;
  const codex = run.usage.byAgent!.codex!;
  assert.equal(claude.steps, claudeSteps.length);
  assert.equal(claude.inputTokens, 120 * claudeSteps.length, "cache writes count as input");
  assert.equal(claude.cacheReadTokens, 500 * claudeSteps.length);
  assert.equal(codex.inputTokens, 100 * codexSteps.length, "Codex's cached tokens aren't counted twice");
  assert.equal(codex.cacheReadTokens, 200 * codexSteps.length);
  assert.ok(Math.abs(run.usage.costUsd! - 0.25 * claudeSteps.length) < 1e-9);
  assert.deepEqual(claudeSteps[0]!.usage, { inputTokens: 120, outputTokens: 40, cacheReadTokens: 500, costUsd: 0.25 });
  assert.ok(codex.writeSteps >= 1 && claude.writeSteps === 0);
});

test("a Codex error event it recovers from doesn't fail the turn", async () => {
  process.env.FAKE_CODEX_WARN = "1";
  let result: { run: Run; manager: Manager };
  try {
    result = await runPattern("pipeline", pipeline);
  } finally {
    delete process.env.FAKE_CODEX_WARN;
  }
  assert.equal(result.run.status, "done", result.run.error);
  const events = await result.manager.events(result.run.id);
  assert.ok(events.some((e) => e.type === "agent" && e.event.kind === "status" && e.event.text.includes("Reconnecting")));
});

// ---------------------------------------------------------------- integrity
test("integrity: deleted, skipped and weakened tests and a changed test script are found", async () => {
  const dir = newRepo({
    "package.json": JSON.stringify({ scripts: { test: "node --test", "test:unit": "node --test unit" } }),
    "a.test.mjs": 'test("a", () => { assert.equal(1, 1); assert.ok(true); });\n',
    "b.test.mjs": 'test("b", () => {});\n',
    "src/c.spec.ts": 'it("c", () => { expect(c()).toBe(1); });\n',
    "jest.config.js": "module.exports = {};\n",
  });
  const base = sh(dir, "rev-parse", "HEAD");
  execFileSync("git", ["rm", "-q", "b.test.mjs"], { cwd: dir });
  writeFileSync(join(dir, "a.test.mjs"), 'test("a", () => { });\n');
  writeFileSync(join(dir, "src/c.spec.ts"), 'it.skip("c", () => { expect(c()).toBe(1); });\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo ok", "test:unit": "node --test unit" } }));
  writeFileSync(join(dir, "jest.config.js"), "module.exports = { testPathIgnorePatterns: ['.*'] };\n");
  commitAllIn(dir, "game the check");
  const issues = await inspectChanges(dir, base, "HEAD", { check: "npm run test:unit", tests: { before: 5, after: 3 } });
  const kinds = issues.map((i) => `${i.kind}:${i.file}`).sort();
  assert.deepEqual(kinds, [
    "deleted-test:b.test.mjs",
    "fewer-tests:",
    "skipped-test:src/c.spec.ts",
    "test-config:jest.config.js",
    "test-script:package.json",
    "weakened-test:a.test.mjs",
  ]);
  assert.match(issues.find((i) => i.kind === "test-script")!.detail, /scripts\.test changed from `node --test` to `echo ok`/);
  // Adding tests is never a problem.
  const clean = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "d.test.mjs"), 'test("d", () => assert.ok(1));\n');
  commitAllIn(dir, "add a test");
  assert.deepEqual(await inspectChanges(dir, clean), []);
});

test("integrity: pytest's settings in pyproject.toml, runner settings in package.json, CI workflows and newer skip forms are found", async () => {
  const pyproject = (pytest: string, deps = '["requests"]') => `[project]\nname = "x"\ndependencies = ${deps}\n\n[tool.pytest.ini_options]\n${pytest}\n\n[tool.ruff]\nline-length = 100\n`;
  const dir = newRepo({
    "pyproject.toml": pyproject('addopts = "-ra"'),
    "tests/pyproject.toml": '[project]\nname = "x-tests"\n\n[tool.pytest.ini_options]\ntestpaths = ["."]\n',
    "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" }, jest: { testEnvironment: "node" } }),
    "packages/ui/package.json": JSON.stringify({ name: "ui", devDependencies: { vitest: "1" } }),
    "src/a.test.ts": ['it("a", () => expect(a()).toBe(1));', 'test("b", () => expect(b()).toBe(2));', 'describe("c", () => { it("c", () => {}); });', 'test("d", () => {});', ""].join("\n"),
    ".github/workflows/ci.yml": "jobs:\n  test:\n    runs-on: ubuntu-latest\n",
  });
  const base = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "pyproject.toml"), pyproject('addopts = "-ra --deselect tests/test_api.py::test_login"'));
  writeFileSync(join(dir, "tests/pyproject.toml"), '[project]\nname = "x-tests"\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" }, jest: { testEnvironment: "node", testPathIgnorePatterns: ["api"] } }));
  writeFileSync(join(dir, "packages/ui/package.json"), JSON.stringify({ name: "ui", devDependencies: { vitest: "1" }, vitest: { exclude: ["**/*.test.ts"] } }));
  writeFileSync(
    join(dir, "src/a.test.ts"),
    ['it.skipIf(process.env.CI)("a", () => expect(a()).toBe(1));', 'test.skip.each([1])("b", () => expect(b()).toBe(2));', 'describe.skipIf(true)("c", () => { it("c", () => {}); });', 'test.runIf(false)("d", () => {});', ""].join("\n"),
  );
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "jobs:\n  # test:\n  #   runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n");
  commitAllIn(dir, "game the check");
  const issues = await inspectChanges(dir, base, "HEAD", { check: "npm test" });
  assert.deepEqual(issues.map((i) => `${i.kind}|${i.file}|${i.severity}|${i.detail}`).sort(), [
    "skipped-test|src/a.test.ts|high|adds `describe.skipIf(true)(\"c\", () => { it(\"c\", () => {}); });`",
    "skipped-test|src/a.test.ts|high|adds `it.skipIf(process.env.CI)(\"a\", () => expect(a()).toBe(1));`",
    "skipped-test|src/a.test.ts|high|adds `test.runIf(false)(\"d\", () => {});`",
    "skipped-test|src/a.test.ts|high|adds `test.skip.each([1])(\"b\", () => expect(b()).toBe(2));`",
    "test-config|.github/workflows/ci.yml|medium|CI workflow changed",
    'test-config|package.json|medium|`jest` settings changed to {"testEnvironment":"node","testPathIgnorePatterns":["api"]}',
    'test-config|packages/ui/package.json|medium|adds `vitest` settings: {"exclude":["**/*.test.ts"]}',
    "test-config|pyproject.toml|medium|pytest settings ([tool.pytest…]) changed",
    "test-config|tests/pyproject.toml|high|pytest settings ([tool.pytest…]) removed",
  ]);
  // What the runner collects, as opposed to build config or CI a change can need.
  assert.deepEqual(issues.filter(changesRunner).map((i) => i.file).sort(), ["package.json", "packages/ui/package.json", "pyproject.toml", "tests/pyproject.toml"]);

  // The rest of those files is the project's: dependencies, other tools' settings, a skip that's a page offset.
  const clean = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "pyproject.toml"), pyproject('addopts = "-ra --deselect tests/test_api.py::test_login"', '["requests", "httpx"]').replace("line-length = 100", "line-length = 120"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" }, jest: { testEnvironment: "node", testPathIgnorePatterns: ["api"] }, dependencies: { zod: "3" } }));
  writeFileSync(join(dir, "src/users.ts"), "export const page = (n: number) => prisma.user.findMany({ skip: n * 10, take: 10 });\n");
  writeFileSync(join(dir, "src/users.test.ts"), 'test("pages", { skip: false }, () => expect(page(1)).toBeDefined());\n');
  commitAllIn(dir, "a real change");
  assert.deepEqual(await inspectChanges(dir, clean, "HEAD", { check: "npm test" }), []);
});

test("integrity: a skip marker inside a string or comment isn't a skipped test; a real one still is", async () => {
  const dir = newRepo({
    "tests/unit/test_guard.py": "def test_ok():\n    assert True\n",
    "src/guard.test.ts": 'test("ok", () => expect(1).toBe(1));\n',
  });
  const base = sh(dir, "rev-parse", "HEAD");
  // A test of the repo's guard against skips writes skipping tests into fixtures, as strings.
  writeFileSync(
    join(dir, "tests/unit/test_guard.py"),
    [
      "import textwrap",
      "",
      "def test_ok():",
      "    assert True",
      "",
      "def test_guard_rejects_skips(tmp_path):",
      "    (tmp_path / 'test_example.py').write_text(",
      `        "import pytest\\ndef test_example(): pytest.skip('missing runtime')\\n", encoding="utf-8"`,
      "    )",
      "    (tmp_path / 'test_other.py').write_text(textwrap.dedent('''",
      "        import pytest",
      '        @pytest.mark.skip(reason="later")',
      "        def test_other(): pass",
      "    '''))",
      "    # pytest.skip() here would hide the failure",
      "    assert guard(tmp_path) == 2",
      "",
      "def test_needs_network():",
      '    pytest.skip("no network")',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src/guard.test.ts"),
    [
      'test("ok", () => expect(1).toBe(1));',
      "const fixture = `",
      '  it.skip("later", () => {});',
      "  ${header}",
      '  describe.only("focus", () => {});',
      "`;",
      'const inline = \'test.skip("x", () => {})\'; // it.skip( in a comment',
      'const nested = `${cond ? `xit("a")` : ""} test.only("b")`;',
      "const tick = /`/; /* a backtick in a regex doesn't open a template */",
      'it.skip("real", () => {});',
      "",
    ].join("\n"),
  );
  commitAllIn(dir, "test the skip guard");
  const issues = await inspectChanges(dir, base);
  assert.deepEqual(
    issues.map((i) => `${i.kind}:${i.file}:${i.detail}`),
    ['skipped-test:src/guard.test.ts:adds `it.skip("real", () => {});`', 'skipped-test:tests/unit/test_guard.py:adds `pytest.skip("no network")`'],
  );
});

// ---------------------------------------------------------------- pure helpers
test("test counts are read from each runner's summary", () => {
  assert.equal(countTests("TAP version 13\n# tests 7\n# suites 0\n# pass 6\n# fail 1\n"), 7);
  assert.equal(countTests("ℹ tests 3\nℹ pass 3\nℹ fail 0\n"), 3);
  assert.equal(countTests("Tests:       1 failed, 2 skipped, 10 passed, 13 total"), 11);
  assert.equal(countTests(" Test Files  2 passed (2)\n      Tests  2 failed | 10 passed (12)"), 12);
  assert.equal(countTests("test result: ok. 4 passed; 0 failed; 1 ignored\ntest result: ok. 2 passed; 1 failed; 0 ignored"), 7);
  assert.equal(countTests("========= 2 failed, 10 passed, 1 skipped in 0.12s ========="), 12);
  // pytest errors ran and didn't pass; -q prints the summary without the bars.
  assert.equal(countTests("========= 9 passed, 1 error in 0.12s ========="), 10, "an error is a test that ran");
  assert.equal(countTests("Interrupted: 1 error during collection\n1 error in 0.07s"), 1, "a summary of only errors");
  assert.equal(countTests("ERROR test_z.py::test_d - RuntimeError\n1 failed, 1 passed, 1 error in 0.04s"), 3, "pytest -q");
  assert.equal(countTests("2 passed, 1 warning in 0.01s"), 2);
  assert.equal(countTests("============ no tests ran in 0.01s ============"), undefined);
  assert.equal(countTests("  10 passing (20ms)\n  2 failing\n"), 12);
  assert.equal(countTests("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n"), 2);
  assert.equal(countTests("no summary here"), undefined);
});

test("failing tests are read from each runner's summary too", () => {
  const failed = (output: string) => testCounts(output).failed;
  assert.equal(failed("TAP version 13\n# tests 7\n# suites 0\n# pass 6\n# fail 1\n"), 1);
  assert.equal(failed("Tests:       1 failed, 2 skipped, 10 passed, 13 total"), 1);
  assert.equal(failed(" Test Files  2 passed (2)\n      Tests  2 failed | 10 passed (12)"), 2);
  assert.equal(failed("test result: FAILED. 4 passed; 2 failed; 1 ignored\ntest result: ok. 2 passed; 1 failed; 0 ignored"), 3);
  assert.equal(failed("========= 2 failed, 10 passed, 1 skipped, 1 error in 0.12s ========="), 3, "a pytest error didn't pass either");
  assert.equal(failed("1 failed, 1 passed, 1 error in 0.04s"), 2, "pytest -q");
  assert.equal(failed("1 error in 0.07s"), 1);
  assert.equal(failed("  10 passing (20ms)\n  2 failing\n"), 2);
  assert.equal(failed("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n"), 1);
  assert.deepEqual(testCounts("no summary here"), {});
});

test("a long check log keeps its first failure, not only its tail", () => {
  const log = ["start", "✕ parses dates (2 ms)", "  AssertionError: expected 1 to equal 2", ...Array.from({ length: 2_000 }, (_, i) => `ok ${i} passing thing`), "# pass 2000", "# fail 1"].join("\n");
  const excerpt = failureExcerpt(log, 4_000);
  assert.ok(excerpt.length <= 4_400, String(excerpt.length));
  assert.match(excerpt, /AssertionError: expected 1 to equal 2/);
  assert.match(excerpt, /# fail 1$/);
  assert.equal(failureExcerpt("short"), "short");
});

test("a long diff keeps whole source files and lists the ones left out", () => {
  const file = (name: string, lines: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n${"+line of code\n".repeat(lines)}`;
  const full = file("package-lock.json", 3_000) + file("src/app.ts", 50) + file("src/big.ts", 3_000) + file("src/util.ts", 40);
  const fitted = fitDiff(full, 20_000, "abc123");
  assert.ok(fitted.length < 22_000);
  assert.match(fitted, /diff --git a\/src\/app\.ts/);
  assert.match(fitted, /diff --git a\/src\/util\.ts/, "a small file after a big one still fits");
  assert.match(fitted, /the rest of src\/big\.ts is cut/);
  assert.match(fitted, /- package-lock\.json \(\+3000 -0\)/, "lockfiles go last and are listed");
  assert.match(fitted, /git diff abc123\.\.HEAD -- <file>/);
  assert.equal(fitDiff("small", 100, "x"), "small");
});

test("JSON after an escaped backslash is still found", () => {
  assert.deepEqual(extractJson('noise {"path": "C:\\\\", "ok": true} trailing'), { path: "C:\\", ok: true });
});

test("slots run work in order, cap concurrency, and let waiters give up", async () => {
  const slots = new Slots(2);
  const order: string[] = [];
  const a = await slots.acquire();
  const b = await slots.acquire();
  const controller = new AbortController();
  const c = slots.acquire().then((release) => (order.push("c"), release));
  const d = slots.acquire(controller.signal).then(
    () => order.push("d"),
    () => order.push("d gave up"),
  );
  const e = slots.acquire().then((release) => (order.push("e"), release));
  assert.equal(slots.queued, 3);
  controller.abort();
  await d;
  a();
  (await c)();
  b();
  (await e)();
  assert.deepEqual(order, ["d gave up", "c", "e"]);
  assert.equal(slots.busy, 0);
});

test("a torn last line is closed before the next write; newer journal entries are ignored", async () => {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, "torn.jsonl"), '{"a":1}\n{"b":2');
  appendLine("torn.jsonl", { c: 3 });
  await flushWrites();
  assert.deepEqual(await readJsonLines("torn.jsonl"), [{ a: 1 }, { c: 3 }]);
  writeFileSync(join(RUNS_DIR, "j.journal.jsonl"), `${JSON.stringify({ key: "old", value: 1 })}\n${JSON.stringify({ key: "new", value: 2, v: JOURNAL_VERSION + 1 })}\n`);
  assert.deepEqual([...(await loadJournal("j")).keys()], ["old"]);
});

test("one server per CODEFLOW_HOME: a live holder keeps the lock, a dead one doesn't", async () => {
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  const lock = join(process.env.CODEFLOW_HOME!, "server.lock");
  writeFileSync(lock, String(holder.pid));
  await assert.rejects(acquireLock(300), /Another code-flow server \(pid \d+\)/);
  holder.kill("SIGKILL");
  await until(() => !alive(holder.pid!));
  const release = await acquireLock(300);
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
  release();
  assert.ok(!existsSync(lock));
});

test("auto routing prefers the agent that passes most in this repo, and says when everyone is out of room", () => {
  const installed = new Set(["claude", "codex", "agy"] as const);
  const run = (agent: string, verdict: "passed" | "failing") =>
    ({
      repo: "/r",
      pattern: "pipeline",
      status: "done",
      verdict,
      createdAt: 1,
      endedAt: 2,
      roles: {},
      artifacts: [],
      usage: { agentSteps: 1, checks: 1, byAgent: { [agent]: { steps: 1, failures: 0, writeSteps: 1, ms: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } } },
    }) as any;
  const history = [...Array(4)].map(() => run("codex", "passed")).concat([...Array(4)].map(() => run("claude", "failing")));
  const rank = rankAgents(history, "/r");
  assert.deepEqual(rank.order, ["codex", "claude"]);
  const picked = resolveAuto({ builder: ["auto"] }, {}, installed, rank);
  assert.deepEqual(picked.roles.builder, ["codex"]);
  assert.match(picked.notes[0]!, /4 of 4 runs passed in this repo/);
  assert.deepEqual(rankAgents(history.slice(0, 2), "/r").order, [], "too little history to rank by");

  // A limit whose reset time has passed is over, even with no fresh report since.
  const reset = { claude: { status: "limited", windows: { five_hour: { resetsAt: Date.now() - 1_000 } }, at: Date.now() - 60_000 } };
  assert.deepEqual(resolveAuto({ builder: ["auto"] }, reset, installed).roles.builder, ["claude"]);
  const everyoneOut = Object.fromEntries([...installed].map((a) => [a, { status: "limited", windows: {}, at: Date.now() }]));
  assert.match(resolveAuto({ builder: ["auto"] }, everyoneOut, installed).notes[0]!, /every agent is out of room/);

  const stats = computeStats(history);
  assert.deepEqual(
    stats.agents.map((a) => [a.agent, a.judged, a.passed]),
    [
      ["codex", 4, 4],
      ["claude", 4, 0],
    ],
  );
  assert.equal(stats.patterns[0]!.ended, 8);
});
