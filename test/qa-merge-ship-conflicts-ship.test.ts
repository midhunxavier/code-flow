// Merging into a checkout: when git is stopped in a slow post-merge hook, the merge it made is
// kept and git's leftover merge state is cleared (in a linked worktree too), and a merge that
// requires verification runs the same hooks of yours as any other merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A merge whose hook outlasts this is stopped (the default is 30 minutes).
process.env.CODEFLOW_MERGE_TIMEOUT_SEC = "2";
const { mergeInto } = await import("../src/ship.js");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString().trim();

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-qa-ship-"));
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A branch off main with one file of its own. */
function branch(dir: string, name: string): string {
  sh(dir, "branch", name, "main");
  const tree = mkdtempSync(join(tmpdir(), "codeflow-qa-ship-branch-"));
  sh(dir, "worktree", "add", "-q", tree, name);
  writeFileSync(join(tree, `${name}.txt`), `${name}\n`);
  sh(tree, "add", "-A");
  sh(tree, "commit", "-qm", name);
  sh(dir, "worktree", "remove", "--force", tree);
  return sh(dir, "rev-parse", name);
}

function hook(dir: string, name: string, body: string) {
  const file = join(dir, ".git", "hooks", name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** The merge state files git keeps in `checkout`'s git dir while a merge is in progress. */
const mergeState = (checkout: string) =>
  ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"].filter((name) => existsSync(resolve(checkout, sh(checkout, "rev-parse", "--git-path", name))));

for (const where of ["your checkout", "a linked worktree"]) {
  test(`stopped in a slow post-merge hook in ${where}, the merge is done and git's merge state is cleared`, async () => {
    const dir = newRepo();
    const feat = branch(dir, "feat");
    branch(dir, "more");
    let checkout = dir;
    let into = "main";
    if (where === "a linked worktree") {
      into = "linked";
      sh(dir, "branch", "linked", "main");
      checkout = mkdtempSync(join(tmpdir(), "codeflow-qa-ship-linked-"));
      sh(dir, "worktree", "add", "-q", checkout, "linked");
    }
    const before = sh(checkout, "rev-parse", "HEAD");
    hook(dir, "post-merge", "sleep 20");
    const started = Date.now();
    const outcome = await mergeInto(dir, "feat", into, "Merge feat");
    assert.ok(Date.now() - started < 15_000, "git was stopped, not waited for");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.match(outcome.warning ?? "", new RegExp(`Merged into ${into}, but git was stopped after 2 s, once the merge commit was made: a post-merge hook`));
    assert.doesNotMatch(outcome.warning ?? "", /still mid-merge/);
    assert.equal(sh(checkout, "rev-parse", "HEAD"), outcome.commit);
    assert.equal(sh(checkout, "log", "-1", "--format=%P"), `${before} ${feat}`);
    assert.deepEqual(mergeState(checkout), [], "no merge is left in progress");
    assert.doesNotMatch(sh(checkout, "status"), /still merging/);
    assert.equal(sh(checkout, "status", "--porcelain"), "");

    hook(dir, "post-merge", "true");
    const next = await mergeInto(dir, "more", into, "Merge more");
    assert.ok(next.ok && !next.warning, "the next merge isn't refused as 'in the middle of another merge'");
  });
}

test("a merge that requires verification runs the same hooks as any other merge into your checkout", async () => {
  const dir = newRepo();
  const log = join(dir, ".git", "hooks.log");
  for (const name of ["pre-commit", "pre-merge-commit", "commit-msg", "post-commit", "post-merge"]) hook(dir, name, `echo ${name} >> ${JSON.stringify(log)}`);
  const ran = () => {
    const names = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    writeFileSync(log, "");
    return names;
  };
  branch(dir, "plain");
  const verified = branch(dir, "verified");
  ran();

  const plain = await mergeInto(dir, "plain", "main", "Merge plain");
  assert.ok(plain.ok && plain.method === "checkout");
  const usual = ran();
  assert.deepEqual(usual, ["pre-merge-commit", "commit-msg", "post-merge"]);

  const target = sh(dir, "rev-parse", "main");
  const tree = sh(dir, "merge-tree", "--write-tree", "main", "verified").split("\n")[0]!;
  const merged = await mergeInto(dir, "verified", "main", "Merge verified", { source: verified, target, tree });
  assert.ok(merged.ok && merged.method === "checkout", JSON.stringify(merged));
  assert.deepEqual(ran(), usual, "the same hooks, not the commit hooks");
  assert.equal(sh(dir, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(sh(dir, "log", "-1", "--format=%P"), `${target} ${verified}`);
});
