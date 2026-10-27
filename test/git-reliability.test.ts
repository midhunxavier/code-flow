// Worktrees of a repo with submodules get the submodules' files; when they can't be cloned the
// worktree is still made, with a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-git-home-"));
// Local-path submodules are blocked by default since git 2.38.1; these tests use them.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

const {
  assertWorktree,
  changedFiles,
  changedSince,
  commitAll,
  diffSince,
  diffStat,
  discardChanges,
  git,
  hasConflictMarkers,
  isClean,
  mergeBranch,
  openWorktree,
  openDetachedWorktree,
  removeDetachedWorktree,
  resolveCommit,
  restorePaths,
  snapshot,
  restoreSnapshot,
  uncommittedCount,
  worktreeGit,
  WorktreeMismatchError,
} = await import("../src/git.js");
const { mergeInto, removeWorktrees } = await import("../src/ship.js");
const { listTree, searchFiles } = await import("../src/repo-tree.js");
const { inspectChanges } = await import("../src/integrity.js");
const { runWorktreeAt } = await import("../src/engine.js");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const commit = (cwd: string, msg: string) => {
  sh(cwd, "add", "-A");
  sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
};

function newRepo(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sh(dir, "init", "-q", "-b", "main");
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  commit(dir, "init");
  return dir;
}

/** A repo with `lib/` as a submodule (which has a submodule of its own, `lib/deep/`). */
function repoWithSubmodules() {
  const deep = newRepo("codeflow-git-deep-", { "deep.txt": "deep\n" });
  const lib = newRepo("codeflow-git-lib-", { "lib.txt": "lib\n" });
  sh(lib, "submodule", "add", "-q", deep, "deep");
  commit(lib, "add deep");
  const repo = newRepo("codeflow-git-repo-", { "README.md": "repo\n" });
  sh(repo, "submodule", "add", "-q", lib, "lib");
  commit(repo, "add lib");
  return { repo, lib, deep };
}

test("a new worktree has its submodules checked out, nested ones too", async () => {
  const { repo } = repoWithSubmodules();
  const path = join(repo, ".worktrees", "r1", "build");
  const opened = await openWorktree(repo, "build", path, "codeflow/r1/build", "HEAD");
  assert.equal(opened.created, true);
  assert.equal(opened.warning, undefined);
  assert.equal(readFileSync(join(path, "lib", "lib.txt"), "utf8"), "lib\n");
  assert.equal(readFileSync(join(path, "lib", "deep", "deep.txt"), "utf8"), "deep\n");
  assert.equal(sh(path, "status", "--porcelain"), "", "the worktree is clean");

  // Re-attached after its folder was deleted: the submodules come back too.
  rmSync(path, { recursive: true, force: true });
  const again = await openWorktree(repo, "build", path, "codeflow/r1/build", "HEAD");
  assert.equal(again.created, false);
  assert.ok(existsSync(join(path, "lib", "deep", "deep.txt")));

  const base = join(repo, ".worktrees", "r1", ".base-check");
  assert.deepEqual(await openDetachedWorktree(repo, base, "HEAD"), {});
  assert.ok(existsSync(join(base, "lib", "lib.txt")));
  await removeDetachedWorktree(repo, base);
});

test("worktrees opened at once in a fresh clone all get their submodules", async () => {
  const { repo } = repoWithSubmodules();
  // A clone made without --recurse-submodules: nothing is registered in its shared config yet,
  // so every worktree registers them, one at a time, then clones them in parallel.
  const clone = mkdtempSync(join(tmpdir(), "codeflow-git-clone-"));
  sh(clone, "clone", "-q", repo, ".");
  const names = ["a", "b", "c", "d"];
  const opened = await Promise.all(names.map((n) => openWorktree(clone, n, join(clone, ".worktrees", "r2", n), `codeflow/r2/${n}`, "HEAD")));
  for (const [i, o] of opened.entries()) {
    assert.equal(o.warning, undefined, names[i]);
    assert.ok(existsSync(join(o.wt.path, "lib", "deep", "deep.txt")), names[i]);
  }
});

test("a submodule that can't be cloned is a warning, not a failed worktree", async () => {
  const { repo, lib } = repoWithSubmodules();
  rmSync(lib, { recursive: true, force: true });
  const path = join(repo, ".worktrees", "r3", "build");
  const opened = await openWorktree(repo, "build", path, "codeflow/r3/build", "HEAD");
  assert.equal(opened.created, true);
  assert.match(opened.warning ?? "", /Submodules weren't checked out in .*git submodule update --init --recursive failed/s);
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "repo\n");
});

test("a repo without submodules is unaffected, and the Files panel lists it", async () => {
  const repo = newRepo("codeflow-git-plain-", { "a.txt": "a\n", ".gitignore": "out/\n" });
  writeFileSync(join(repo, "new.txt"), "n\n");
  const opened = await openWorktree(repo, "build", join(repo, ".worktrees", "r4", "build"), "codeflow/r4/build", "HEAD");
  assert.deepEqual(Object.keys(opened).sort(), ["created", "wt"]);
  const { entries } = await listTree(repo);
  assert.deepEqual(
    entries.map((e) => [e.name, e.status ?? ""]),
    [
      [".worktrees", "U"],
      [".gitignore", ""],
      ["a.txt", ""],
      ["new.txt", "U"],
    ],
  );
  assert.deepEqual((await searchFiles(repo, "new")).map((e) => e.path), ["new.txt"]);
});

test("read-only steps side by side in one worktree: snapshots don't collide on index.lock, and a held lock is waited out", async () => {
  // Uncommitted changes to tracked files: `git stash create` refreshes the index, which takes its lock.
  const repo = newRepo("codeflow-git-snap-", { "a.txt": "a\n", "b.txt": "b\n" });
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const snaps = await Promise.all(Array.from({ length: 6 }, () => snapshot(repo, repo)));
  assert.ok(snaps.every((s) => s.changes), "every snapshot recorded the uncommitted change");

  // Your own git (or an agent's) holds the lock while a step's edits are undone.
  writeFileSync(join(repo, "b.txt"), "edited in a read-only step\n");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  setTimeout(() => rmSync(lock, { force: true }), 400);
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, snaps[0]!), ['edits: "b.txt"']);
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b\n");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "changed\n", "the change from before the step is kept");
});

test("restoring a snapshot puts back untracked files that were there before, edited or deleted since", async () => {
  const repo = newRepo("codeflow-git-untracked-", { "a.txt": "a\n" });
  writeFileSync(join(repo, "notes.md"), "my notes\n");
  const binary = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
  writeFileSync(join(repo, "data.bin"), binary);
  const snap = await snapshot(repo, repo);
  // The step edits one, deletes the other, and adds a third.
  writeFileSync(join(repo, "notes.md"), "half-done edit\n");
  rmSync(join(repo, "data.bin"));
  writeFileSync(join(repo, "new.txt"), "new\n");
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, snap), ['1 new file: "new.txt"', '2 untracked files put back: "data.bin", "notes.md"']);
  assert.equal(readFileSync(join(repo, "notes.md"), "utf8"), "my notes\n");
  assert.deepEqual(readFileSync(join(repo, "data.bin")), binary);
  assert.ok(!existsSync(join(repo, "new.txt")));
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, snap), [], "nothing to undo the second time");
});

test("a file touched but not changed doesn't make a snapshot fail", async () => {
  const repo = newRepo("codeflow-git-touch-", { "a.txt": "a\n", "b.txt": "b\n" });
  // Its stat no longer matches the index, its content does: `git stash create` on a stale index
  // sees a change, then none, and exits 1 printing nothing.
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(repo, "a.txt"), later, later);
  const snap = await snapshot(repo, repo);
  assert.equal(snap.changes, "");
  writeFileSync(join(repo, "sneaky.txt"), "a read-only step wrote this\n");
  utimesSync(join(repo, "b.txt"), later, later);
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, snap), ['1 new file: "sneaky.txt"']);
});

// ---------------------------------------------------------------- a worktree's .git
// Worktrees live inside your checkout, and an agent can change any file in its worktree, `.git`
// included. Without it git run there finds your checkout; with it rewritten, a repository of the
// agent's making.

/** A repo with two commits, a run's worktree at the first, and an uncommitted edit in your checkout. */
async function repoWithWorktree(prefix: string) {
  const repo = newRepo(prefix, { "a.txt": "one\n" });
  writeFileSync(join(repo, "a.txt"), "two\n");
  commit(repo, "second");
  const { wt } = await openWorktree(repo, "build", join(repo, ".worktrees", "run1", "build"), "codeflow/run1/build", "HEAD~1");
  writeFileSync(join(repo, "a.txt"), "my uncommitted edit\n");
  const yours = { head: sh(repo, "rev-parse", "HEAD"), branch: sh(repo, "symbolic-ref", "HEAD") };
  /** Your checkout is exactly as it was: same branch, same commit, the edit still there. */
  const untouched = () => {
    assert.equal(sh(repo, "symbolic-ref", "HEAD"), yours.branch);
    assert.equal(sh(repo, "rev-parse", "HEAD"), yours.head);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "my uncommitted edit\n");
    assert.equal(sh(repo, "log", "-1", "--format=%s"), "second");
  };
  return { repo, wt, untouched };
}

const mismatch = (pattern: RegExp) => (err: unknown) => err instanceof WorktreeMismatchError && pattern.test(err.message);

test("a read-only step that deletes its worktree's .git: the restore refuses and your checkout is untouched", async () => {
  const { repo, wt, untouched } = await repoWithWorktree("codeflow-git-dotgit-");
  writeFileSync(join(wt.path, "a.txt"), "edited in a read-only step\n");
  const snap = await snapshot(repo, wt.path);
  rmSync(join(wt.path, ".git"));

  await assert.rejects(restoreSnapshot(repo, wt, snap), mismatch(/isn't the checkout code-flow expects \(its \.git is missing\).*Nothing was changed/));
  untouched();
  // Nothing else that changes a worktree runs there either.
  await assert.rejects(changedSince(repo, wt, snap), mismatch(/its \.git is missing/));
  await assert.rejects(commitAll(repo, wt, "would land on your branch"), mismatch(/its \.git is missing/));
  await assert.rejects(mergeBranch(repo, wt, "main"), mismatch(/its \.git is missing/));
  await assert.rejects(discardChanges(repo, wt), mismatch(/its \.git is missing/));
  await assert.rejects(restorePaths(repo, wt, "HEAD", ["a.txt"]), mismatch(/its \.git is missing/));
  await assert.rejects(snapshot(repo, wt.path), mismatch(/its \.git is missing/));
  untouched();
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "edited in a read-only step\n", "the worktree is left as the step left it");

  // And code-flow's git never looks above the worktree, guarded or not: reading or resetting
  // there fails instead of acting on your checkout.
  const reset = await git(["reset", "--hard", "-q", "HEAD~1"], wt.path);
  assert.notEqual(reset.code, 0);
  assert.match(reset.stderr, /not a git repository/);
  await assert.rejects(isClean(wt.path), /not a git repository/);
  untouched();

  // Removing the run's worktrees reports it rather than removing anything.
  const removed = await removeWorktrees(repo, [{ path: wt.path, branch: wt.branch }], true);
  assert.deepEqual(removed.removed, []);
  assert.deepEqual(removed.deletedBranches, [], "the branch holding the worktree's work is kept");
  assert.match(removed.failed.join("\n"), /its \.git is missing/);
  untouched();
});

test("a worktree whose .git was rewritten to point elsewhere is refused; put back, it works again", async () => {
  const { repo, wt, untouched } = await repoWithWorktree("codeflow-git-repoint-");
  const { wt: other } = await openWorktree(repo, "other", join(repo, ".worktrees", "run2", "other"), "codeflow/run2/other", "HEAD");
  const dotGit = join(wt.path, ".git");
  const original = readFileSync(dotGit, "utf8");
  const adminDir = original.replace(/^gitdir: */, "").trim();
  writeFileSync(join(wt.path, "notes.txt"), "a read-only step wrote this\n");
  const snap = await snapshot(repo, wt.path);
  // A git folder of the agent's own, as an attacker would make it: it borrows the real objects.
  const planted = join(wt.path, "x");
  mkdirSync(join(planted, "objects", "info"), { recursive: true });
  mkdirSync(join(planted, "refs", "heads"), { recursive: true });
  writeFileSync(join(planted, "objects", "info", "alternates"), `${join(repo, ".git", "objects")}\n`);
  writeFileSync(join(planted, "HEAD"), `${sh(repo, "rev-parse", "main")}\n`);
  writeFileSync(join(planted, "config"), "[core]\n\trepositoryformatversion = 0\n");

  const cases: [string, () => void, RegExp][] = [
    ["your checkout's git folder", () => writeFileSync(dotGit, `gitdir: ${join(repo, ".git")}\n`), /points to the git folder of .* itself/],
    ["another worktree's git folder", () => writeFileSync(dotGit, readFileSync(join(other.path, ".git"))), /git folder of another worktree/],
    ["a git folder inside the worktree", () => writeFileSync(dotGit, "gitdir: ./x\n"), /points to .*\/x, which isn't one of .*'s worktrees/],
    ["no git folder at all", () => writeFileSync(dotGit, "not a gitfile\n"), /doesn't name a git folder/],
    [
      "a folder of its own",
      () => {
        rmSync(dotGit);
        cpSync(planted, dotGit, { recursive: true });
      },
      /points to .*\/\.git, which isn't one of/,
    ],
    [
      "a link to the right git folder",
      () => {
        rmSync(dotGit, { recursive: true, force: true });
        symlinkSync(adminDir, dotGit);
      },
      /its \.git is a symbolic link/,
    ],
  ];
  for (const [what, rewrite, problem] of cases) {
    rewrite();
    await assert.rejects(restoreSnapshot(repo, wt, snap), mismatch(problem), what);
    await assert.rejects(commitAll(repo, wt, "x"), mismatch(problem), what);
    untouched();
    rmSync(dotGit, { recursive: true, force: true });
    writeFileSync(dotGit, original);
  }
  rmSync(planted, { recursive: true, force: true });
  assert.equal(sh(other.path, "rev-parse", "HEAD"), sh(repo, "rev-parse", "main"), "the other worktree didn't move");

  // On another branch (an agent ran `git checkout -b`): undoing would move that branch instead.
  sh(wt.path, "checkout", "-q", "-b", "elsewhere");
  sh(wt.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "on elsewhere");
  const elsewhere = sh(repo, "rev-parse", "elsewhere");
  await assert.rejects(restoreSnapshot(repo, wt, snap), mismatch(/it's on elsewhere, not codeflow\/run1\/build/));
  assert.equal(sh(repo, "rev-parse", "elsewhere"), elsewhere);
  // Reporting what changed only reads: it doesn't care which branch.
  assert.deepEqual(await changedSince(repo, wt, snap), ["commits"]);
  sh(wt.path, "checkout", "-q", "codeflow/run1/build");

  // The worktree as git made it passes, and so does your own checkout.
  await assertWorktree(repo, wt);
  await assertWorktree(repo, { path: repo, branch: "main" });
  await assert.rejects(assertWorktree(repo, { path: repo, branch: "codeflow/run1/build" }), mismatch(/it's on main, not codeflow\/run1\/build/));
  assert.deepEqual(await restoreSnapshot(repo, wt, snap), []);
  untouched();
});

test("an fsmonitor or hook from a git folder an agent planted never runs; your hooks still run on a merge into your checkout", async () => {
  const { repo, wt, untouched } = await repoWithWorktree("codeflow-git-fsmonitor-");
  const ran = join(mkdtempSync(join(tmpdir(), "codeflow-git-ran-")), "ran");
  const script = join(tmpdir(), `codeflow-git-evil-${process.pid}.sh`);
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${ran}\nexit 1\n`);
  chmodSync(script, 0o755);
  const hooks = join(wt.path, "evil-hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-commit", "post-commit", "post-checkout", "post-merge", "reference-transaction"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${ran}\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  const snap = await snapshot(repo, wt.path);

  // The agent's own git folder, its index a copy of the worktree's, set to run its commands.
  const dotGit = join(wt.path, ".git");
  const original = readFileSync(dotGit, "utf8");
  const planted = join(wt.path, "x");
  mkdirSync(join(planted, "objects", "info"), { recursive: true });
  mkdirSync(join(planted, "refs", "heads"), { recursive: true });
  writeFileSync(join(planted, "objects", "info", "alternates"), `${join(repo, ".git", "objects")}\n`);
  writeFileSync(join(planted, "HEAD"), `${sh(wt.path, "rev-parse", "HEAD")}\n`);
  cpSync(join(original.replace(/^gitdir: */, "").trim(), "index"), join(planted, "index"));
  writeFileSync(join(planted, "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${script}\n\thooksPath = ${hooks}\n`);
  writeFileSync(dotGit, "gitdir: ./x\n");
  writeFileSync(join(wt.path, "b.txt"), "new\n");
  // It works: plain git there runs the agent's fsmonitor.
  execFileSync("git", ["status", "--porcelain"], { cwd: wt.path });
  assert.ok(existsSync(ran), "the planted config is live for plain git");
  rmSync(ran);

  // code-flow's own git, guarded or not, runs none of it.
  await assert.rejects(restoreSnapshot(repo, wt, snap), WorktreeMismatchError);
  await assert.rejects(commitAll(repo, wt, "x"), WorktreeMismatchError);
  await assert.rejects(snapshot(repo, wt.path), WorktreeMismatchError);
  assert.equal(await isClean(wt.path), false);
  for (const args of [["stash", "create"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]]) {
    const res = await git(args, wt.path);
    assert.equal(res.code, 0, res.stderr);
  }
  assert.ok(!existsSync(ran), `ran: ${existsSync(ran) ? readFileSync(ran, "utf8") : ""}`);
  untouched();

  // Nor do your own hooks in a run's worktree; they do on a merge into your checkout.
  writeFileSync(dotGit, original);
  rmSync(planted, { recursive: true, force: true });
  for (const hook of ["post-commit", "post-merge"]) {
    writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho "${hook} in $(pwd)" >> ${ran}\n`);
    chmodSync(join(repo, ".git", "hooks", hook), 0o755);
  }
  rmSync(hooks, { recursive: true, force: true });
  assert.ok(await commitAll(repo, wt, "code-flow commits"));
  assert.ok(!existsSync(ran), "no hook ran on code-flow's commit");
  writeFileSync(join(repo, "a.txt"), "two\n"); // your checkout clean, so the merge can go ahead
  const merged = await mergeInto(repo, wt.branch, "main", "Merge the run");
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.match(readFileSync(ran, "utf8"), /^post-merge in /m, "your post-merge hook ran on the merge into your checkout");
  rmSync(script, { force: true });
});

test("a filter, textconv or external diff from a git folder an agent planted never runs: not for the Files panel, diffs, status or the integrity checks", async () => {
  const { repo, wt, untouched } = await repoWithWorktree("codeflow-git-filter-");
  // A change on the run's branch, for the diffs and the integrity checks to look at.
  writeFileSync(join(wt.path, "a.txt"), "the agent's change\n");
  writeFileSync(join(wt.path, "a.test.js"), "test('a', () => { assert.ok(true); });\n");
  assert.ok(await commitAll(repo, wt, "change"));
  const head = sh(wt.path, "rev-parse", "HEAD");

  const ran = join(mkdtempSync(join(tmpdir(), "codeflow-git-ran-")), "ran");
  const script = join(tmpdir(), `codeflow-git-filter-${process.pid}.sh`);
  // Says how it was run, then hands the content back (a textconv gets a file), so git carries on.
  writeFileSync(script, `#!/bin/sh\necho "$1" >> ${ran}\nif [ "$1" = textconv ]; then cat "$2"; elif [ "$1" != external ]; then cat; fi\n`);
  chmodSync(script, 0o755);

  // The agent's own git folder (its HEAD another commit, its index a copy of the worktree's), whose
  // config runs its commands as a filter, a textconv and an external diff; its `.gitattributes`
  // turns them on for every file.
  const dotGit = join(wt.path, ".git");
  const original = readFileSync(dotGit, "utf8");
  const planted = join(wt.path, "x");
  mkdirSync(join(planted, "objects", "info"), { recursive: true });
  mkdirSync(join(planted, "refs", "heads"), { recursive: true });
  writeFileSync(join(planted, "objects", "info", "alternates"), `${join(repo, ".git", "objects")}\n`);
  writeFileSync(join(planted, "HEAD"), `${sh(repo, "rev-parse", "main")}\n`);
  cpSync(join(original.replace(/^gitdir: */, "").trim(), "index"), join(planted, "index"));
  writeFileSync(
    join(planted, "config"),
    `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = ${script} clean\n\tsmudge = ${script} smudge\n[diff "x"]\n\ttextconv = ${script} textconv\n[diff]\n\texternal = ${script} external\n`,
  );
  writeFileSync(join(wt.path, ".gitattributes"), "* filter=x diff=x\n");
  writeFileSync(dotGit, "gitdir: ./x\n");
  // The same size as what's committed: git has to read it (through the filter) to tell it changed.
  writeFileSync(join(wt.path, "a.txt"), "the agent's chaNge\n");

  // It works: plain git there runs all three.
  const plain = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, stdio: ["ignore", "pipe", "pipe"] });
  plain("status", "--porcelain");
  plain("diff", `${wt.base}..HEAD`);
  plain("diff", "--no-ext-diff", `${wt.base}..HEAD`);
  for (const what of ["clean", "external", "textconv"]) assert.match(readFileSync(ran, "utf8"), new RegExp(`^${what}$`, "m"), `the planted ${what} is live for plain git`);
  rmSync(ran);

  // code-flow's git there is told the worktree's git folder; the Files panel finds it from the run.
  const at = await worktreeGit(repo, wt.path);
  assert.equal(at.gitDir, await realpath(original.replace(/^gitdir: */, "").trim()));
  const runs = [{ repo, worktreeDir: join(repo, ".worktrees", "run1") }];
  assert.deepEqual(await runWorktreeAt(runs, wt.path), at);
  assert.equal(await runWorktreeAt(runs, repo), undefined, "your checkout isn't a run's worktree");
  assert.equal(await resolveCommit(at), head, "the worktree's own HEAD, not the planted one");

  // The Files panel.
  const listing = await listTree(at);
  assert.equal(listing.entries.find((e) => e.name === "a.txt")?.status, "M");
  assert.equal(listing.entries.find((e) => e.name === ".gitattributes")?.status, "U");
  assert.deepEqual((await searchFiles(at, "a.t")).map((e) => e.path).sort(), ["a.test.js", "a.txt"]);
  // Status and diffs.
  assert.equal(await isClean(at), false);
  assert.equal(await uncommittedCount(at), 3); // a.txt, .gitattributes, x/
  assert.match(await diffSince(at, wt.base), /^\+the agent's change$/m);
  assert.match(await diffStat(at, wt.base), /a\.txt/);
  assert.deepEqual((await changedFiles(at, wt.base)).sort(), ["a.test.js", "a.txt"]);
  assert.equal(await hasConflictMarkers(at), false);
  // The integrity checks.
  assert.deepEqual(await inspectChanges(at, wt.base), []);
  assert.ok(!existsSync(ran), `ran: ${existsSync(ran) ? readFileSync(ran, "utf8") : ""}`);

  // What assertWorktree checked is what git then uses, whatever `.git` says by the time it runs.
  writeFileSync(dotGit, original);
  const checked = await assertWorktree(repo, wt);
  writeFileSync(dotGit, "gitdir: ./x\n");
  assert.equal(await resolveCommit(checked), head);
  assert.equal((await git(["status", "--porcelain"], checked)).code, 0);
  assert.ok(!existsSync(ran));
  untouched();
  rmSync(script, { force: true });
});

test("restoring a snapshot puts untracked files back as they were, not as a filter in your config would store them", async () => {
  const { repo, wt } = await repoWithWorktree("codeflow-git-lfs-");
  // Like Git LFS: your config stores some files as something else (here, in upper case).
  sh(repo, "config", "filter.upper.clean", "tr a-z A-Z");
  sh(repo, "config", "filter.upper.smudge", "cat");
  writeFileSync(join(wt.path, ".gitattributes"), "*.dat filter=upper\n");
  writeFileSync(join(wt.path, "notes.dat"), "lower case\n");
  const snap = await snapshot(repo, wt.path);
  writeFileSync(join(wt.path, "notes.dat"), "edited\n");
  assert.deepEqual(await restoreSnapshot(repo, wt, snap), ['1 untracked file put back: "notes.dat"']);
  assert.equal(readFileSync(join(wt.path, "notes.dat"), "utf8"), "lower case\n");
  assert.deepEqual(await changedSince(repo, wt, snap), [], "unchanged untracked files compare as unchanged");
});
