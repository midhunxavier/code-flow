import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
let lastManager: InstanceType<typeof RunManager> | undefined;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "sample\n");
  writeFileSync(join(repo, "shared.txt"), "original\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

async function runPattern(
  id: string,
  roles: Record<string, any>,
  task = "Do the thing",
  options = {},
  extra: { baseRef?: string; branchPrefix?: string } = {},
): Promise<Run> {
  const manager = (lastManager = new RunManager());
  const run = await manager.start({ pattern: findPattern(id)!, task, repo, roles, options, ...extra });
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

const branchFiles = (branch: string) =>
  execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: repo }).toString().split("\n");
const logs = async (run: Run) => (await lastManager!.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");

/** Run `fn` with the fake agents recording every prompt; returns its result and the prompts. */
async function recording<T>(fn: () => Promise<T>): Promise<{ result: T; prompts: { vendor: string; prompt: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  try {
    const result = await fn();
    return { result, prompts: readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) };
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
}

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

test("pipeline: the reviewer judges the change against the task, with the plan as context", async () => {
  const { result: run, prompts } = await recording(() => runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }));
  assert.equal(run.status, "done", run.error);
  const review = prompts.find((p) => p.prompt.includes("You are the reviewer"))!;
  assert.match(review.prompt, /## The planner's plan \(context, not the spec\)/);
  assert.match(review.prompt, /Judge the change against the task, not against the plan/);
  assert.match(await logs(run), /claude both plans and reviews; a reviewer from another vendor is likelier to catch a wrong plan/);
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

test("debate: proposals are anonymous, and the build is reviewed again after its fixes", async () => {
  rmSync(join(process.env.CODEFLOW_HOME!, ".reviewed-once"), { force: true }); // an earlier test's review already failed once
  process.env.FAKE_REVIEW_FAIL_ONCE = "1";
  let recorded;
  try {
    recorded = await recording(() =>
      runPattern("debate", { debaters: ["claude", "codex"], synthesizer: ["claude"], builder: ["agy"], reviewer: ["codex"] }, "Design it", { rounds: 1 }),
    );
  } finally {
    delete process.env.FAKE_REVIEW_FAIL_ONCE;
  }
  const { result: run, prompts } = recorded;
  assert.equal(run.status, "done", run.error);
  // Proposals go by letter: no vendor name labels a proposal, for the debaters or the synthesizer.
  const critiques = prompts.filter((p) => p.prompt.includes("current proposals"));
  assert.equal(critiques.length, 2);
  assert.match(critiques.find((p) => p.vendor === "claude")!.prompt, /yours is Proposal A[\s\S]*## Proposal B\n/);
  assert.match(critiques.find((p) => p.vendor === "codex")!.prompt, /yours is Proposal B[\s\S]*## Proposal A\n/);
  const synthesis = prompts.find((p) => p.prompt.includes("You are the synthesizer"))!.prompt;
  assert.match(synthesis, /## Final position: Proposal A\n[\s\S]*## Final position: Proposal B\n/);
  for (const p of [...critiques, { prompt: synthesis }]) assert.doesNotMatch(p.prompt, /^## .*(Claude|Codex|Antigravity)/m, "no section names a vendor");
  assert.match(await logs(run), /claude both debates and synthesizes; a synthesizer from another vendor is fairer/);

  // The reviewer asked for changes, the builder addressed them, and the reviewer checked again.
  assert.deepEqual(
    run.steps.filter((s) => s.role === "reviewer" || s.title.startsWith("Address review")).map((s) => s.title),
    ["Review the build", "Address review", "Review the build (round 2)"],
  );
  assert.deepEqual([run.facts?.approved, run.facts?.reviewRounds], [true, 2]);
  assert.match(run.summary!, /Review by codex: approved in round 2\./);
  const second = prompts.find((p) => p.prompt.startsWith("The builder addressed your previous review"));
  assert.ok(second, "the second review continues the reviewer's session with the updated diff");
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
  assert.match(run.summary!, /All tests pass \(run by code-flow\)/);
  assert.equal(run.verdict, "passed");
  assert.ok(branchFiles(run.artifacts[0]!.branch).includes("spec.test.mjs"));
  const checks = run.steps.filter((s) => s.kind === "check").map((s) => [s.title, s.status]);
  assert.deepEqual(checks[0], ["New tests (should fail)", "failed"], "red first");
  assert.ok(checks.slice(1).every(([, status]) => status === "done"));
});

test("a failing agent fails the pipeline but not a race", async () => {
  process.env.FAKE_FAIL_VENDOR = "codex";
  try {
    const pipeline = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(pipeline.status, "failed");
    // Codex's app-server reports the failure as the turn's error.
    assert.match(pipeline.error!, /Implement plan \(codex\) failed: boom/);

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
  const logs = (await lastManager!.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
  assert.match(logs, /Plan \(agy\) modified files in read-only mode; changes were reverted/);
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

test("worktrees live in <repo>/.worktrees and are excluded from git status", async () => {
  const run = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.worktreeDir, join(realpathSync(repo), ".worktrees", run.id));
  assert.ok(run.artifacts[0]!.path.startsWith(run.worktreeDir));
  assert.ok(existsSync(join(run.worktreeDir, "build")));
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === "/.worktrees/").length, 1, "added exactly once");
});

test("runs can start from a chosen base branch", async () => {
  execFileSync("git", ["switch", "-q", "-c", "feature"], { cwd: repo });
  writeFileSync(join(repo, "feature.txt"), "only on feature\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feature"], { cwd: repo });
  execFileSync("git", ["switch", "-q", "-"], { cwd: repo });

  const run = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, "x", {}, { baseRef: "feature" });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.baseLabel, "feature");
  assert.ok(branchFiles(run.artifacts[0]!.branch).includes("feature.txt"));

  await assert.rejects(
    runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, "x", {}, { baseRef: "no-such-branch" }),
    /Base branch "no-such-branch" not found/,
  );
});

test("result branches use the chosen prefix, which can't be reused", async () => {
  const roles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] };
  const run = await runPattern("pipeline", roles, "x", {}, { branchPrefix: "/feat/clamp/" });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.artifacts[0]!.branch, "feat/clamp/build");

  await assert.rejects(runPattern("pipeline", roles, "x", {}, { branchPrefix: "feat/clamp" }), /already exist/);
  await assert.rejects(runPattern("pipeline", roles, "x", {}, { branchPrefix: "feat/clamp/build" }), /already exists/);
  await assert.rejects(runPattern("pipeline", roles, "x", {}, { branchPrefix: "bad..name" }), /not a valid/);
});

test("listBranches groups local, run and current branches", async () => {
  const { listBranches } = await import("../src/git.js");
  const { current, branches } = await listBranches(repo);
  assert.ok(current === "master" || current === "main");
  const kind = (name: string) => branches.find((b) => b.name === name)?.kind;
  assert.equal(kind("feature"), "local");
  assert.equal(kind("feat/clamp/build"), "local");
  assert.ok(branches.some((b) => b.kind === "run" && b.name.startsWith("codeflow/")));
});

test("runs never touch the user's own checkout", () => {
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "original\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), "");
});
