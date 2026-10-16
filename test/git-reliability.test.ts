// Worktrees of a repo with submodules get the submodules' files; when they can't be cloned the
// worktree is still made, with a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-git-home-"));
// Local-path submodules are blocked by default since git 2.38.1; these tests use them.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

const { openWorktree, openDetachedWorktree, removeDetachedWorktree, snapshot, restoreSnapshot } = await import("../src/git.js");
const { listTree, searchFiles } = await import("../src/repo-tree.js");

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
  const snaps = await Promise.all(Array.from({ length: 6 }, () => snapshot(repo)));
  assert.ok(snaps.every((s) => s.changes), "every snapshot recorded the uncommitted change");

  // Your own git (or an agent's) holds the lock while a step's edits are undone.
  writeFileSync(join(repo, "b.txt"), "edited in a read-only step\n");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  setTimeout(() => rmSync(lock, { force: true }), 400);
  assert.deepEqual(await restoreSnapshot(repo, snaps[0]!), ["edits"]);
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b\n");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "changed\n", "the change from before the step is kept");
});

test("a file touched but not changed doesn't make a snapshot fail", async () => {
  const repo = newRepo("codeflow-git-touch-", { "a.txt": "a\n", "b.txt": "b\n" });
  // Its stat no longer matches the index, its content does: `git stash create` on a stale index
  // sees a change, then none, and exits 1 printing nothing.
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(repo, "a.txt"), later, later);
  const snap = await snapshot(repo);
  assert.equal(snap.changes, "");
  writeFileSync(join(repo, "sneaky.txt"), "a read-only step wrote this\n");
  utimesSync(join(repo, "b.txt"), later, later);
  assert.deepEqual(await restoreSnapshot(repo, snap), ["1 new file"]);
});
