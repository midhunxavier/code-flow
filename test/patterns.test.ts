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
  extra: { baseRef?: string; branchPrefix?: string; roleSettings?: import("../src/engine.js").Run["roleSettings"] } = {},
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
    const run = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
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

test("fix & review: skips planning but keeps independent review and requested-change rounds", async () => {
  rmSync(join(process.env.CODEFLOW_HOME!, ".reviewed-once"), { force: true });
  process.env.FAKE_REVIEW_FAIL_ONCE = "1";
  try {
    const { result: run, prompts } = await recording(() => runPattern("fix-review", { builder: ["codex"], reviewer: ["claude"] }));
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(run.steps.map(step => step.title), ["Fix the issue", "Review (round 1)", "Address review (round 1)", "Review (round 2)"]);
    assert.equal(run.facts?.approved, true);
    assert.equal(run.facts?.reviewRounds, 2);
    const build = prompts.find(entry => entry.prompt.includes("## Approach"))!;
    assert.equal(build.vendor, "codex");
    assert.match(build.prompt, /do not repeat the full completion suite yourself/);
    const reviews = prompts.filter(entry => entry.prompt.includes("You are the reviewer"));
    assert.equal(reviews.length, 2);
    assert.ok(reviews.every(entry => entry.vendor === "claude"));
    assert.ok(reviews.every(entry => !entry.prompt.includes("## The planner's plan")));
  } finally { delete process.env.FAKE_REVIEW_FAIL_ONCE; }
});

test("a failing agent fails the pipeline", async () => {
  process.env.FAKE_FAIL_VENDOR = "codex";
  try {
    const pipeline = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(pipeline.status, "failed");
    // Codex's app-server reports the failure as the turn's error.
    assert.match(pipeline.error!, /Implement plan \(codex\) failed: boom/);
  } finally {
    delete process.env.FAKE_FAIL_VENDOR;
  }
});

test("changes made by a read-only step are reverted", async () => {
  const run = await runPattern("pipeline", { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, "SNEAKY task");
  assert.equal(run.status, "done", run.error);
  // The read-only planner wrote sneaky.txt and had it reverted (the write-mode builder may write it legitimately later).
  const logs = (await lastManager!.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
  assert.match(logs, /Plan \(claude\) modified files in read-only mode; changes were reverted/);
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


test("one provider can run distinct models in a council", async () => {
  const choices = { claude: { model: "first", effort: "high", variants: [{ model: "second", effort: "low" }] } };
  const run = await runPattern("council", { reviewers: ["claude"], chair: ["codex"] }, "Do the thing", {}, { roleSettings: { reviewers: choices } });
  assert.equal(run.status, "done", run.error);
  const steps = run.steps.filter(step => step.role === "reviewers");
  assert.ok(steps.some(step => step.settings?.model === "first" && step.settings.effort === "high"));
  assert.ok(steps.some(step => step.settings?.model === "second" && step.settings.effort === "low"));
});
