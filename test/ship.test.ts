import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-ship-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { removeWorktrees } = await import("../src/ship.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();
const commitAs = ["-c", "user.name=t", "-c", "user.email=t@t"];
const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
const manager: Manager = new RunManager(findPattern);

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-ship-repo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "ship\n");
  git("add", ".");
  git(...commitAs, "commit", "-qm", "init");
});

function finished(run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
}
async function runPattern(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}) {
  const run = await manager.start({ pattern: findPattern(pattern)!, task: "Ship it", repo, roles, options: {}, ...extra });
  await finished(run);
  return run;
}
const logs = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const agentTitles = (r: Run) => r.steps.filter((s) => s.kind === "agent").map((s) => s.title);

test("an unreadable review verdict fails the run instead of approving", async () => {
  process.env.FAKE_GARBLE_VENDOR = "claude";
  try {
    const run = await runPattern("pipeline", { planner: ["codex"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(run.status, "failed");
    assert.match(run.error!, /Review \(round 1\) \(claude\) did not return a valid review verdict, even after a retry/);
    assert.deepEqual(agentTitles(run).slice(-2), ["Review (round 1)", "Review (round 1) (retry)"]);
  } finally {
    delete process.env.FAKE_GARBLE_VENDOR;
  }
});

test("a garbled answer gets one retry, which can succeed", async () => {
  process.env.FAKE_GARBLE_VENDOR = "claude";
  process.env.FAKE_GARBLE_ONCE = "1";
  try {
    const run = await runPattern("pipeline", { planner: ["codex"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(run.status, "done", run.error);
    assert.match(await logs(run), /Review \(round 1\): no valid review verdict \(no JSON answer\); asking again/);
  } finally {
    delete process.env.FAKE_GARBLE_VENDOR;
    delete process.env.FAKE_GARBLE_ONCE;
  }
});

test("judging: a panel votes; a judge that also competes gets a warning", async () => {
  const panel = await runPattern("race", { contestants: ["claude", "codex"], judge: ["agy", "claude"] });
  assert.equal(panel.status, "done", panel.error);
  assert.deepEqual(agentTitles(panel).filter((t) => t.startsWith("Judge")).sort(), ["Judge 1", "Judge 2"]);
  assert.match(await logs(panel), /Votes: B=2/);
  assert.match(await logs(panel), /claude both competes and judges/);
  assert.match(panel.summary!, /Winner: Candidate B — codex/);
});

test("per-file diff of a result branch", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const files = await manager.diff(run.id, run.artifacts[0]!.branch);
  assert.equal(files.length, 1);
  assert.match(files[0]!.path, /^codex-.*\.txt$/);
  assert.deepEqual([files[0]!.status, files[0]!.additions, files[0]!.deletions], ["added", 1, 0]);
  assert.match(files[0]!.patch, /^\+codex output$/m);
  await assert.rejects(manager.diff(run.id, "main"), /doesn't belong to this run/);
});

test("review comments go back to the agent as a follow-up in the same run", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const before = agentTitles(run);
  await manager.followUp(run.id, { worktree: "build", agent: "codex", message: "- codex-x.txt:1 — please also handle empty input" });
  await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(agentTitles(run), [...before, "Address review comments"], "the pattern replays; only the follow-up runs");
  assert.equal(run.followUps[0]!.status, "done");
  assert.match(run.summary!, /## Follow-ups\n- codex addressed your review comments in build/);
  const followUpStep = run.steps.at(-1)!;
  assert.equal(followUpStep.agent, "codex");
  assert.equal(git("log", "-1", "--format=%s", run.artifacts[0]!.branch).trim(), "codex: address review comments (f1)");
  await assert.rejects(manager.followUp(run.id, { worktree: "nope", agent: "codex", message: "x" }), /Unknown worktree/);
});

test("merge into a branch that isn't checked out uses merge-tree; into the checkout only when clean", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  git("branch", "release", "main");

  const viaRef = await manager.merge(run.id, { branch, into: "release" });
  assert.ok(viaRef.ok && viaRef.method === "ref");
  assert.ok(git("ls-tree", "-r", "--name-only", "release").includes("codex-"));
  assert.equal(git("log", "-1", "--format=%P", "release").trim().split(" ").length, 2, "a real merge commit");
  await assert.rejects(manager.merge(run.id, { branch, into: "release" }), /Nothing to merge: release already has everything on/);

  writeFileSync(join(repo, "README.md"), "dirty\n");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /has uncommitted changes/);
  git("checkout", "--", "README.md");

  const viaCheckout = await manager.merge(run.id, { branch, into: "main", archiveAfter: true });
  assert.ok(viaCheckout.ok && viaCheckout.method === "checkout");
  assert.ok(existsSync(join(repo, readFirstAdded(branch))), "your checkout now has the change");
  assert.equal(run.merges.length, 2);
  assert.equal(run.archived, true, "archived after merging");
  assert.ok(!existsSync(run.worktrees[0]!.path), "its worktrees were removed");
  assert.ok(git("branch", "--list", branch).trim(), "the branch is kept");
});

test("conflicts are reported, and an agent can resolve them in the run's worktree", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const file = readFirstAdded(branch);
  git("checkout", "-q", "-b", "conflicting", "main");
  writeFileSync(join(repo, file), "someone else's version\n");
  git("add", file);
  git(...commitAs, "commit", "-qm", "conflicting change");
  git("checkout", "-q", "main");

  const outcome = await manager.merge(run.id, { branch, into: "conflicting" });
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.conflicts, [file]);

  await manager.followUp(run.id, { kind: "resolve-conflicts", worktree: "build", agent: "claude", mergeFrom: "conflicting" });
  await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.equal(git("show", `${branch}:${file}`), "resolved by fake agent\n");
  const retry = await manager.merge(run.id, { branch, into: "conflicting" });
  assert.ok(retry.ok, "merges cleanly once resolved");
});

test("archive can remove worktrees and branches; PRs need a remote", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  await assert.rejects(manager.pullRequest(run.id, { branch, into: "main" }), /no 'origin' remote/);
  const result = await manager.archive(run.id, { cleanup: true, deleteBranches: true });
  assert.equal(result.removed.length, run.worktrees.length);
  assert.deepEqual(result.deletedBranches.sort(), run.worktrees.map((w) => w.branch).sort());
  assert.equal(git("branch", "--list", branch).trim(), "");
});

test("merging into your checkout: only a real conflict is offered to an agent; anything else says what to do", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const file = readFirstAdded(branch);
  const merges = () => run.merges.length;
  const before = merges();

  // An untracked file where the merge would write one: git refuses, and that isn't a conflict.
  writeFileSync(join(repo, file), "mine, not committed\n");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), new RegExp(`untracked files in your checkout would be overwritten: ${file.replace(/\./g, "\\.")}\\. Move or commit them`));
  rmSync(join(repo, file));

  // Another git holding the index lock.
  writeFileSync(join(repo, ".git", "index.lock"), "");
  try {
    await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /another git process is using this repository/);
  } finally {
    rmSync(join(repo, ".git", "index.lock"));
  }

  // Staged changes are uncommitted changes too.
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git("add", "staged.txt");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /has uncommitted changes/);
  git("rm", "-q", "--cached", "staged.txt");
  rmSync(join(repo, "staged.txt"));

  // A real conflict: its files are listed, and your checkout is left as it was.
  writeFileSync(join(repo, file), "main's own version\n");
  git("add", file);
  git(...commitAs, "commit", "-qm", "main's version");
  const head = git("rev-parse", "HEAD").trim();
  const outcome = await manager.merge(run.id, { branch, into: "main" });
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.conflicts, [file]);
  assert.equal(git("rev-parse", "HEAD").trim(), head);
  assert.equal(git("status", "--porcelain").trim(), "", "nothing half-merged is left behind");
  assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")));
  assert.equal(merges(), before);
});

test("removing worktrees: a locked one takes --force twice; what can't be removed is reported", async () => {
  const base = mkdtempSync(join(tmpdir(), "codeflow-ship-wt-"));
  const locked = join(base, "locked");
  const held = join(base, "held");
  git("worktree", "add", "-q", "-b", "wt-locked", locked, "main");
  git("worktree", "lock", locked);
  git("worktree", "add", "-q", "-b", "wt-held", held, "main");
  const result = await removeWorktrees(
    repo,
    [
      { path: locked, branch: "wt-locked" },
      // Its folder is gone already, and its branch is checked out somewhere else: it can't be deleted.
      { path: join(base, "gone"), branch: "wt-held" },
    ],
    true,
  );
  assert.deepEqual(result.removed, [locked]);
  assert.deepEqual(result.deletedBranches, ["wt-locked"]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!, /^branch wt-held: .*(checked out|used by worktree)/i);
  git("worktree", "remove", "--force", held);
  git("branch", "-D", "wt-held");
});

function readFirstAdded(branch: string): string {
  return git("diff", "--name-only", `main...${branch}`).trim().split("\n")[0]!;
}
