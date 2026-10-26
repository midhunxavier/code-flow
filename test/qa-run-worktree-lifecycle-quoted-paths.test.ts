// Worktree registry records are NUL-delimited so Git's quoted paths are never mistaken for names.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-worktree-names-")));
process.env.CODEFLOW_HOME = join(directory, "home");
const { openWorktree, openDetachedWorktree, removeDetachedWorktree } = await import("../src/git.js");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", ...args], { cwd, encoding: "utf8" }).trim();
after(() => rmSync(directory, { recursive: true, force: true }));

test("reattaching a quoted worktree path keeps unrelated missing worktrees registered", async () => {
  const repo = join(directory, "repo");
  git(directory, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const other = join(directory, "my-worktree");
  git(repo, "worktree", "add", "-q", "-b", "user-wip", other);
  writeFileSync(join(other, "WIP.txt"), "keep\n");
  renameSync(other, `${other}-offline`);
  for (const name of ["café", "tab\tname", "line\nname"]) {
    const path = join(directory, name);
    const branch = `codeflow/test/${name === "café" ? "unicode" : name.startsWith("tab") ? "tab" : "newline"}`;
    const { wt } = await openWorktree(repo, "build", path, branch, "main");
    rmSync(path, { recursive: true, force: true });
    const reopened = await openWorktree(repo, "build", path, branch, "main");
    assert.equal(reopened.wt.branch, wt.branch);
    assert.equal(git(path, "status", "--porcelain"), "");
    git(repo, "worktree", "remove", path);
    // Detached cleanup needs the same exact path matching (there is no branch fallback).
    await openDetachedWorktree(repo, path, "main");
    rmSync(path, { recursive: true, force: true });
    await removeDetachedWorktree(repo, path);
    assert.ok(!git(repo, "worktree", "list", "--porcelain", "-z").includes(`worktree ${path}\0`));
  }
  renameSync(`${other}-offline`, other);
  assert.match(git(other, "status", "--porcelain"), /WIP.txt/);
});
