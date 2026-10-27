// Run worktree and branch lifecycle: a run lists its worktrees as soon as they exist (and after
// a crash), a branch prefix is taken once, archive cleans up what it says and never prunes your own
// worktrees, a deleted branch is said to be gone, and copy patterns that copied nothing say why.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-wt-life-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites } = await import("../src/store.js");
const { openWorktree, openDetachedWorktree, removeDetachedWorktree } = await import("../src/git.js");
const { removeWorktrees } = await import("../src/ship.js");
const { copyIntoWorktree } = await import("../src/repo-config.js");
const { nextRunAction, runStateBadges, branchesGone } = await import("../ui/run-experience.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;

function makeRepo(prefix: string): { repo: string; git: (...args: string[]) => string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { repo, git };
}

let shared: { repo: string; git: (...args: string[]) => string };
before(() => { shared = makeRepo("cf-qa-wt-life-repo-"); });

function finished(m: Manager, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    m.subscribe(run.id, check);
    check();
  });
}

async function until(condition: () => boolean, timeoutMs = 15_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const logs = async (m: Manager, run: Run) => (await m.events(run.id)).filter((e) => e.type === "log").map((e) => (e as { text: string }).text);

// ---------------------------------------------------------------- t07-6 / t08-1
test("a new worktree is in the run list at once, and survives a crash: resume and archive still know it", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "4000";
  const a = new RunManager(findPattern);
  const run = await a.start({ pattern: findPattern("pipeline")!, task: "Crash with a worktree", repo: shared.repo, roles: pipelineRoles, options: {} });
  try {
    await until(() => run.steps.some((s) => s.title === "Implement plan" && s.status === "running"));
    // The list (side panel, Files, Changes) has it while the first step that uses it still runs.
    assert.deepEqual(a.list().find((r) => r.id === run.id)!.worktrees.map((w) => w.name), ["build"]);
    await flushWrites();

    // A second process reads the log as left by a crash (no clean shutdown).
    const b = new RunManager(findPattern);
    await b.load();
    const loaded = b.get(run.id)!;
    assert.equal(loaded.status, "interrupted");
    assert.deepEqual(loaded.worktrees.map((w) => w.name), ["build"], "the worktree list reached the log before the crash");
    a.cancel(run.id);
    await finished(a, run);
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;

    // A log written before the list was published: a replayed worktree is listed again on resume.
    loaded.worktrees = [];
    await b.resume(run.id);
    await finished(b, loaded);
    assert.equal(loaded.status, "done", loaded.error);
    assert.deepEqual(loaded.worktrees.map((w) => w.name), ["build"]);
    const branch = loaded.artifacts[0]!.branch;
    assert.ok(loaded.worktrees.some((w) => w.branch === branch), "the result card finds the artifact's worktree");

    const result = await b.archive(run.id, { cleanup: true, deleteBranches: true });
    assert.equal(result.removed.length, 1);
    assert.deepEqual(result.deletedBranches, [branch]);
    assert.equal(shared.git("branch", "--list", branch), "");
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a crashed run whose log predates its worktrees gets them back from the journal at load", async () => {
  const a = new RunManager(findPattern);
  const run = await a.start({ pattern: findPattern("pipeline")!, task: "Old log", repo: shared.repo, roles: pipelineRoles, options: {} });
  await finished(a, run);
  await flushWrites();
  // Rewrite the log as an older code-flow left it after a crash: running, with no worktrees.
  const { RUNS_DIR } = await import("../src/store.js");
  const file = join(RUNS_DIR, `${run.id}.jsonl`);
  const { steps: _steps, ...summary } = run;
  writeFileSync(file, `${JSON.stringify({ seq: 1, ts: Date.now(), runId: run.id, type: "run", run: { ...summary, status: "running", worktrees: [] } })}\n`);
  rmSync(join(RUNS_DIR, `${run.id}.checkpoint.json`), { force: true });
  rmSync(join(RUNS_DIR, `${run.id}.cold-index.json`), { force: true });
  rmSync(join(RUNS_DIR, `${run.id}.cold-detail.json`), { force: true });

  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  assert.equal(loaded.status, "interrupted");
  assert.deepEqual(loaded.worktrees.map((w) => w.name), ["build"], "archive without a resume can still remove it");
  const result = await b.archive(run.id, { cleanup: true, deleteBranches: true });
  assert.equal(result.removed.length, 1);
});

// ---------------------------------------------------------------- t17-6
test("concurrent starts can't share a branch prefix, nor can a later run while the first is known", async () => {
  const m = new RunManager(findPattern);
  const start = (task: string, branchPrefix: string) => m.start({ pattern: findPattern("pipeline")!, task, repo: shared.repo, roles: pipelineRoles, options: {}, branchPrefix });
  const results = await Promise.allSettled([start("a", "qa/race"), start("b", "qa/race"), start("c", "qa/race")]);
  const won = results.filter((r): r is PromiseFulfilledResult<Run> => r.status === "fulfilled");
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one start gets the prefix");
  assert.equal(lost.length, 2);
  // The same plain refusal as a later reuse, never git's "already checked out" from a run that started.
  for (const r of lost) assert.match((r.reason as Error).message, /branch prefix "qa\/race\/"; pick another prefix|Branches under "qa\/race\/" already exist/);
  // One nested in it or around it is taken too: by the run, or by its branches once they exist.
  await assert.rejects(start("d", "qa/race/build"), /branch prefix|already exist/);
  await assert.rejects(start("e", "qa"), /branch prefix|already exist/);
  const run = won[0]!.value;
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.artifacts[0]!.branch, "qa/race/build");
  // With its branches deleted it's still the run's, while the run is known (git alone would allow it).
  await m.archive(run.id, { cleanup: true, deleteBranches: true });
  assert.equal(shared.git("branch", "--list", "qa/race/*"), "");
  await assert.rejects(start("f", "qa/race"), new RegExp(`Run ${run.id} already has the branch prefix "qa/race/"`));
  // Default prefixes are each run's own and unaffected.
  const other = await m.start({ pattern: findPattern("pipeline")!, task: "default", repo: shared.repo, roles: pipelineRoles, options: {} });
  await finished(m, other);
  assert.equal(other.status, "done", other.error);
});

// ---------------------------------------------------------------- t17-4
test("code-flow never prunes your own worktrees whose folder is missing just now", async () => {
  const { repo, git } = makeRepo("cf-qa-wt-prune-");
  const user = join(repo, "..", `${repo.split("/").pop()}-user-wt`);
  git("worktree", "add", "-q", user, "-b", "user");
  writeFileSync(join(user, "WIP.txt"), "work in progress\n");
  git("-C", user, "add", "WIP.txt");
  renameSync(user, `${user}.away`); // an unmounted drive, a moved folder
  const userListed = () => git("worktree", "list", "--porcelain").includes(`worktree ${user}`);
  assert.ok(userListed());

  // (a) Re-attach a run worktree whose folder was deleted by hand.
  const path = join(repo, ".worktrees", "r1", "build");
  await openWorktree(repo, "build", path, "codeflow/r1/build", "HEAD");
  rmSync(path, { recursive: true, force: true });
  const reopened = await openWorktree(repo, "build", path, "codeflow/r1/build", "HEAD");
  assert.equal(reopened.created, false);
  assert.ok(existsSync(join(path, ".git")), "re-attached");
  assert.ok(userListed(), "re-attach left your worktree alone");

  // (b) Remove run worktrees, one of them already deleted by hand.
  const second = join(repo, ".worktrees", "r2", "build");
  await openWorktree(repo, "build", second, "codeflow/r2/build", "HEAD");
  rmSync(second, { recursive: true, force: true });
  const removed = await removeWorktrees(repo, [{ path, branch: "codeflow/r1/build" }, { path: second, branch: "codeflow/r2/build" }], true);
  assert.deepEqual(removed.failed, []);
  assert.deepEqual(removed.deletedBranches.sort(), ["codeflow/r1/build", "codeflow/r2/build"]);
  assert.ok(!git("worktree", "list", "--porcelain").includes(".worktrees/r2"), "the run's own stale record is gone");
  assert.ok(userListed(), "archive left your worktree alone");

  // (c) A throwaway checkout (base-commit checks, proofs).
  const scratch = join(repo, ".worktrees", "r3", ".base-check");
  await openDetachedWorktree(repo, scratch, "HEAD");
  await removeDetachedWorktree(repo, scratch);
  assert.ok(!existsSync(scratch));
  assert.ok(!git("worktree", "list", "--porcelain").includes(".base-check"));
  assert.ok(userListed(), "scratch checkouts left your worktree alone");

  // (d) Reached through another path (a symlinked CODEFLOW_WORKTREE_DIR), its whole run folder deleted by hand.
  const alias = `${repo}-alias`;
  symlinkSync(repo, alias);
  const aliased = join(alias, ".worktrees", "r4", ".base-check");
  await openDetachedWorktree(repo, aliased, "HEAD");
  rmSync(join(repo, ".worktrees", "r4"), { recursive: true, force: true });
  await openDetachedWorktree(repo, aliased, "HEAD");
  assert.ok(existsSync(join(aliased, ".git")), "checked out again");
  await removeDetachedWorktree(repo, aliased);
  assert.ok(!git("worktree", "list", "--porcelain").includes("/r4/"), "its record is gone");
  assert.ok(userListed(), "and yours is still there");
  rmSync(alias);

  renameSync(`${user}.away`, user);
  assert.match(git("-C", user, "status", "--porcelain"), /^A {2}WIP\.txt$/m, "your worktree works again when its folder is back");
});

// ---------------------------------------------------------------- t17-13
test("a run whose branch was deleted says so, and offers no review or merge from it", async () => {
  const m = new RunManager(findPattern);
  const run = await m.start({ pattern: findPattern("pipeline")!, task: "Delete my branch", repo: shared.repo, roles: pipelineRoles, options: {} });
  await finished(m, run);
  const branch = run.artifacts[0]!.branch;
  await m.archive(run.id, { cleanup: true, deleteBranches: true });
  assert.deepEqual(run.worktrees, []);
  assert.deepEqual(run.deletedWorktrees?.map((w) => [w.name, w.branch]), [["build", branch]]);

  // A reply unarchives the run and fails, as the branch is gone.
  await m.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "One more thing" });
  await finished(m, run);
  assert.equal(run.archived, false);
  assert.match(run.followUps.at(-1)!.result!, /was deleted/);
  assert.deepEqual(run.worktrees, [], "the reply doesn't bring the record back");

  for (const call of [() => m.reviewCoverage(run.id, branch), () => m.diff(run.id, branch), () => m.merge(run.id, { branch, into: "main" })]) {
    await assert.rejects(call(), (e: Error) => /was deleted/.test(e.message) && !/rev-parse|fatal/.test(e.message));
  }
  assert.ok(branchesGone(run));
  assert.equal(nextRunAction(run), null, "no check or review action for a branch that's gone");

  // Deleted outside code-flow: the reply finds out and records it.
  const other = await m.start({ pattern: findPattern("pipeline")!, task: "Branch deleted by hand", repo: shared.repo, roles: pipelineRoles, options: {} });
  await finished(m, other);
  await m.archive(other.id, { cleanup: true });
  shared.git("branch", "-D", other.artifacts[0]!.branch);
  await m.followUp(other.id, { kind: "reply", worktree: "build", agent: "codex", message: "Again" });
  await finished(m, other);
  assert.deepEqual(other.worktrees, []);
  assert.equal(other.deletedWorktrees?.length, 1);
});

test("the header says a run is archived and where it was merged", () => {
  assert.deepEqual(runStateBadges({ archived: true, merges: [{ branch: "b", into: "main", commit: "c", at: 1 }, { branch: "b", into: "main", commit: "d", at: 2 }, { branch: "b", into: "qa", commit: "e", at: 3 }] }), ["Archived", "Merged into main, qa"]);
  assert.deepEqual(runStateBadges({ archived: false, merges: [] }), []);
});

// ---------------------------------------------------------------- t17-8
test("archive reports a worktree it refused to remove", async () => {
  const m = new RunManager(findPattern);
  const run = await m.start({ pattern: findPattern("pipeline")!, task: "Broken worktree", repo: shared.repo, roles: pipelineRoles, options: {} });
  await finished(m, run);
  const tree = run.worktrees[0]!;
  rmSync(join(tree.path, ".git"));
  symlinkSync(join(shared.repo, ".git"), join(tree.path, ".git"));
  const result = await m.archive(run.id, { cleanup: true });
  assert.equal(result.removed.length, 0);
  assert.match(result.failed.join("\n"), /isn't the checkout code-flow expects/);
  assert.ok(existsSync(tree.path), "left as it was");
  assert.ok((await logs(m, run)).some((line) => /^Couldn't remove: /.test(line)));
  rmSync(join(tree.path, ".git"));
  rmSync(tree.path, { recursive: true, force: true });
});

// ---------------------------------------------------------------- t08-15 / t04-14
async function chatTask(m: Manager, repo: string) {
  const source = await m.start({ pattern: findPattern("solo")!, repo, task: "Chat task", roles: { agent: ["claude"] }, options: {}, trust: "standard" });
  await finished(m, source);
  assert.equal(source.status, "done", source.error);
  writeFileSync(join(source.worktrees[0]!.path, "unsaved.txt"), "keep me\n");
  const side = await m.startProviderChat(source.id, { agent: "codex", kind: "side", message: "A side question" });
  await finished(m, side);
  const tab = await m.startProviderChat(source.id, { agent: "codex", message: "Another provider" });
  await finished(m, tab);
  return { source, side, tab };
}

test("archiving a side chat with its branches clears its own folder and keeps the shared workspace", async () => {
  const { repo } = makeRepo("cf-qa-wt-side-");
  const m = new RunManager(findPattern);
  const { source, side } = await chatTask(m, repo);
  assert.ok(existsSync(join(side.worktreeDir, ".context")), "the side chat staged its context in its own folder");
  const kept = await m.archive(side.id, { cleanup: true, deleteBranches: false });
  assert.equal(kept.retained, "Shared chat workspace retained");
  assert.ok(existsSync(join(side.worktreeDir, ".context")), "kept with the branches: a reply copies it in again");
  m.setArchived(side.id, false);
  await m.archive(side.id, { cleanup: true, deleteBranches: true });
  await m.deleteRun(side.id);
  assert.ok(!existsSync(side.worktreeDir), "nothing of the side chat is left in .worktrees");
  assert.equal(readFileSync(join(source.worktrees[0]!.path, "unsaved.txt"), "utf8"), "keep me\n", "the shared workspace is untouched");
});

test("an Agent conversation can be archived as a whole, removing the worktree and branch its chats share", async () => {
  const { repo, git } = makeRepo("cf-qa-wt-task-");
  const m = new RunManager(findPattern);
  const { source, side, tab } = await chatTask(m, repo);
  const tree = source.worktrees[0]!;
  // One tab alone still can't discard the others' files.
  const one = await m.archive(tab.id, { cleanup: true, deleteBranches: true });
  assert.equal(one.retained, "Shared chat workspace retained");
  assert.ok(existsSync(join(tree.path, "unsaved.txt")));

  const result = await m.archiveTask(tab.id, { cleanup: true, deleteBranches: true });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, [tree.path]);
  assert.deepEqual(result.deletedBranches, [tree.branch]);
  for (const chat of [source, side, tab]) {
    assert.equal(chat.archived, true);
    assert.deepEqual(chat.worktrees, [], "no member still offers the removed workspace");
    assert.ok(!existsSync(chat.worktreeDir), `${chat.id}'s folder is gone`);
  }
  assert.equal(git("branch", "--list", "codeflow/*"), "");
  assert.equal(git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only your checkout is left");
  for (const chat of [side, tab, source]) await m.deleteRun(chat.id);
});

test("a chat task can't be archived as a whole while one of its chats runs", async () => {
  const { repo } = makeRepo("cf-qa-wt-busy-");
  const m = new RunManager(findPattern);
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "3000";
  try {
    const run = await m.start({ pattern: findPattern("solo")!, repo, task: "Busy chat", roles: { agent: ["claude"] }, options: {}, trust: "standard" });
    await until(() => run.steps.some((s) => s.status === "running"));
    await assert.rejects(m.archiveTask(run.id, { cleanup: true }), /Finish or stop all chats/);
    assert.equal(run.archived, false);
    await finished(m, run);
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

// ---------------------------------------------------------------- t17-15
test("copy patterns that copied nothing say why", async () => {
  const { repo, git } = makeRepo("cf-qa-wt-copy-");
  writeFileSync(join(repo, ".gitignore"), ".env\nconfig/\n");
  git("add", ".gitignore"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  mkdirSync(join(repo, "config"));
  const target = mkdtempSync(join(tmpdir(), "cf-qa-wt-copy-target-"));
  const { copied, refused, skipped } = await copyIntoWorktree(repo, target, ["/.env", "/etc/hosts", "../outside/credentials", "./a/../.env", "missing.env", "nomatch/*.json", "config", ".env"]);
  assert.deepEqual(copied, [".env"]);
  assert.deepEqual(refused, []);
  const why = Object.fromEntries(skipped.map((s) => [s.path, s]));
  assert.match(why["/.env"]!.why, /absolute path.*write `\.env`/);
  assert.ok(why["/.env"]!.invalid);
  assert.match(why["/etc/hosts"]!.why, /absolute path/);
  assert.doesNotMatch(why["/etc/hosts"]!.why, /write/, "no repo file by that name: nothing to suggest");
  assert.match(why["../outside/credentials"]!.why, /`\.\.`/);
  assert.match(why["./a/../.env"]!.why, /`\.\.`/);
  assert.match(why["missing.env"]!.why, /isn't in your checkout/);
  assert.ok(!why["missing.env"]!.invalid, "an optional file that's absent isn't a mistake");
  assert.match(why["nomatch/*.json"]!.why, /no file in your checkout matches/);
  assert.match(why["config"]!.why, /folder/);
  assert.ok(!existsSync(join(target, "..", "outside")));

  // In a run: said once, not once per worktree.
  const m = new RunManager(findPattern);
  symlinkSync(join(repo, ".env"), join(repo, "link.env"));
  const run = await m.start({ pattern: findPattern("race")!, task: "Copy", repo, roles: { contestants: ["claude", "codex"], judge: ["claude"] }, options: {}, loop: { copy: [".env", "/etc/hosts", "missing.env", "link.env"] } });
  await finished(m, run);
  const lines = await logs(m, run);
  assert.equal(lines.filter((l) => /^Didn't copy link\.env: it's a symbolic link/.test(l)).length, 1, "a refusal too");
  assert.equal(lines.filter((l) => /^Didn't copy \/etc\/hosts: it's an absolute path/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /^Didn't copy missing\.env: it isn't in your checkout/.test(l)).length, 1);
  assert.ok(lines.filter((l) => /^Copied \.env from your checkout into/.test(l)).length >= 2, "each worktree still gets its copy");
});
