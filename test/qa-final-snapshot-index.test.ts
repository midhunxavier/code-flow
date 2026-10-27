import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "codeflow-qa-snapshot-index-"));
process.env.CODEFLOW_HOME = home;
const { snapshot, changedSince, restoreSnapshot } = await import("../src/git.js");
after(() => rmSync(home, { recursive: true, force: true }));
const stamp = 1_700_000_000;
const run = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
  cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
}).trim();
function write(repo: string, path: string, text: string) {
  writeFileSync(join(repo, path), text);
  utimesSync(join(repo, path), stamp, stamp);
}
function fixture(paths: string[]) {
  const repo = mkdtempSync(join(home, "repo-"));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "QA"); run(repo, "config", "user.email", "qa@example.test");
  // Model coarse filesystem timestamps deterministically instead of depending on the host's
  // subsecond stat precision. Native Git still detects edits through its racy-index safeguard.
  run(repo, "config", "core.checkStat", "minimal"); run(repo, "config", "core.trustctime", "false");
  for (const path of paths) write(repo, path, "initial\n");
  run(repo, "add", "."); run(repo, "commit", "-qm", "initial");
  return repo;
}
function markRacy(repo: string) { utimesSync(join(repo, ".git/index"), stamp, stamp); }
function indexState(repo: string) {
  const path = join(repo, ".git/index");
  return { contents: readFileSync(path).toString("hex"), mtimeNs: String(statSync(path, { bigint: true }).mtimeNs) };
}

test("same-size tracked edits remain visible across copied-index timestamps and restore without touching the source index during inspection", async () => {
  const repo = fixture(["README.md"]); markRacy(repo);
  const before = indexState(repo), saved = await snapshot(repo, repo);
  assert.deepEqual(indexState(repo), before, "snapshot leaves the user's index bytes and timestamp alone");
  write(repo, "README.md", "changed\n");
  assert.equal(run(repo, "diff", "--name-only", "--"), "README.md", "original index detects the same-size edit");
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), ['edits: "README.md"']);
  assert.deepEqual(indexState(repo), before, "inspection never refreshes or replaces the real index");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "changed\n");
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, saved), ['edits: "README.md"']);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "initial\n");
  assert.equal(run(repo, "diff", "--cached", "--name-only"), "");
  assert.equal(run(repo, "diff", "--name-only"), "");
});

test("snapshot captures racy unstaged contents and restore retains staged, unstaged and partially staged boundaries", async () => {
  const repo = fixture(["staged.txt", "unstaged.txt", "partial.txt"]);
  write(repo, "staged.txt", "staged contents\n"); write(repo, "partial.txt", "staged contents\n");
  run(repo, "add", "staged.txt", "partial.txt"); markRacy(repo);
  write(repo, "unstaged.txt", "working\n"); write(repo, "partial.txt", "worktree draft!\n");
  writeFileSync(join(repo, "untracked.txt"), "private draft\n");
  const indexTree = run(repo, "write-tree");
  const staged = run(repo, "diff", "--cached", "--binary"), unstaged = run(repo, "diff", "--binary");
  assert.match(unstaged, /working/); assert.match(unstaged, /worktree draft!/);
  // write-tree may populate Git's cache-tree extension; capture the inspection baseline afterward.
  markRacy(repo); const initialIndex = indexState(repo);
  const saved = await snapshot(repo, repo);
  assert.deepEqual(indexState(repo), initialIndex);
  assert.equal(run(repo, "show", `${saved.changes}:unstaged.txt`), "working");
  assert.equal(run(repo, "show", `${saved.changes}:partial.txt`), "worktree draft!");
  for (const path of ["staged.txt", "unstaged.txt", "partial.txt"]) writeFileSync(join(repo, path), "later agent modification\n");
  writeFileSync(join(repo, "untracked.txt"), "later untracked modification\n");
  const changed = await changedSince(repo, { path: repo }, saved);
  assert.deepEqual(changed, ['edits: "partial.txt", "staged.txt", "unstaged.txt"', '1 untracked file changed: "untracked.txt"']);
  assert.deepEqual(indexState(repo), initialIndex);
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, saved), ['edits: "partial.txt", "staged.txt", "unstaged.txt"', '1 untracked file put back: "untracked.txt"']);
  assert.equal(run(repo, "write-tree"), indexTree, "the saved staged tree is restored, not mass-unstaged");
  assert.equal(run(repo, "diff", "--cached", "--binary"), staged);
  assert.equal(run(repo, "diff", "--binary"), unstaged);
  assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "private draft\n");
  assert.equal(run(repo, "ls-files", "--others", "--exclude-standard"), "untracked.txt");
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), [], "restored staging and contents match the snapshot");
});

for (const direction of ["stage", "unstage"] as const) test(`${direction}-only changes are detected and restored while unchanged snapshots leave the index alone`, async () => {
  const repo = fixture(["README.md"]);
  writeFileSync(join(repo, "README.md"), "saved changes\n");
  if (direction === "unstage") run(repo, "add", "README.md");
  const savedIndex = indexState(repo), saved = await snapshot(repo, repo);
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), []);
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, saved), [], "an unchanged snapshot does not rewrite its index");
  assert.deepEqual(indexState(repo), savedIndex);
  const staged = run(repo, "diff", "--cached", "--binary"), unstaged = run(repo, "diff", "--binary");

  if (direction === "stage") run(repo, "add", "README.md");
  else run(repo, "reset", "-q", "HEAD", "--", "README.md");
  const changedIndex = indexState(repo);
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), ['staging: "README.md"']);
  assert.deepEqual(indexState(repo), changedIndex, "inspection leaves the changed index untouched");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "saved changes\n");
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, saved), ['staging: "README.md"']);
  assert.equal(run(repo, "diff", "--cached", "--binary"), staged);
  assert.equal(run(repo, "diff", "--binary"), unstaged);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "saved changes\n");
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), []);
});

test("a changed staged version is reported as staging when working contents still equal HEAD", async () => {
  const repo = fixture(["README.md"]), saved = await snapshot(repo, repo);
  writeFileSync(join(repo, "README.md"), "staged version\n"); run(repo, "add", "README.md");
  writeFileSync(join(repo, "README.md"), "initial\n");
  const before = indexState(repo);
  assert.deepEqual(await changedSince(repo, { path: repo }, saved), ['staging: "README.md"']);
  assert.deepEqual(indexState(repo), before);
  assert.deepEqual(await restoreSnapshot(repo, { path: repo }, saved), ['staging: "README.md"']);
  assert.equal(run(repo, "diff", "--cached", "--name-only"), "");
  assert.equal(run(repo, "diff", "--name-only"), "");
});
