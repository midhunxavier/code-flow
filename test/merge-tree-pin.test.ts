import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeInto } from "../src/ship.js";

test("validated merges pin their tree and undo a commit hook that changes tested code", async () => {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-tree-pin-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  try {
    git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@test");
    writeFileSync(join(repo, "README.md"), "base\n"); git("add", "."); git("commit", "-qm", "base");
    const target = git("rev-parse", "HEAD");
    git("checkout", "-qb", "result"); writeFileSync(join(repo, "result.txt"), "tested result\n"); git("add", "."); git("commit", "-qm", "result");
    const source = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    git("checkout", "-q", "main"); git("branch", "target-ref", target);
    await assert.rejects(mergeInto(repo, "result", "main", "merge", { source, target, tree: "0".repeat(40) }), /different tree/);
    assert.equal(git("rev-parse", "HEAD"), target); assert.equal(git("status", "--porcelain"), "");
    await assert.rejects(mergeInto(repo, "result", "target-ref", "merge", { source, target, tree: "0".repeat(40) }), /different tree/);
    assert.equal(git("rev-parse", "target-ref"), target);
    const hook = join(repo, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook rewrite\\n' >> README.md\ngit add README.md\n"); chmodSync(hook, 0o700);
    await assert.rejects(mergeInto(repo, "result", "main", "merge", { source, target, tree }), /hook changed.*merge was undone/i);
    assert.equal(git("rev-parse", "HEAD"), target); assert.equal(git("status", "--porcelain"), ""); assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "base\n");
    rmSync(hook);
    const merged = await mergeInto(repo, "result", "main", "verified merge", { source, target, tree });
    assert.equal(merged.ok, true); assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
