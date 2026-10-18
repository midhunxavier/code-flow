import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIntoWorktree } from "../src/repo-config.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-copy-")));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  await Promise.all([mkdir(repo), mkdir(worktree), mkdir(outside)]);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await mkdir(join(repo, "config"));
  await mkdir(join(repo, "config", "nested"));
  await writeFile(join(repo, ".gitignore"), ".env\nconfig/\n");
  await writeFile(join(repo, ".env"), "SECRET=private\n");
  await writeFile(join(repo, "config", "nested", "secret.json"), '{"private":true}\n');
  return { root, repo, worktree, outside };
}

test("worktree copies refuse an escaping symlink in any destination ancestor", async () => {
  const { repo, worktree, outside } = await fixture();
  await mkdir(join(worktree, "config"));
  await symlink(outside, join(worktree, "config", "nested"));
  const result = await copyIntoWorktree(repo, worktree, ["config/nested/secret.json", ".env"]);
  assert.deepEqual(result.copied, [".env"]);
  assert.match(result.refused[0]!.why, /parent directory is a symbolic link/);
  assert.equal(existsSync(join(outside, "secret.json")), false);
});

test("dangling destination symlinks are never followed or replaced", async () => {
  const { repo, worktree, outside } = await fixture();
  const victim = join(outside, "missing");
  await symlink(victim, join(worktree, ".env"));
  const result = await copyIntoWorktree(repo, worktree, [".env"]);
  assert.deepEqual(result.copied, []);
  assert.match(result.refused[0]!.why, /destination is a symbolic link/);
  assert.equal(existsSync(victim), false);
});

test("symlinked roots and parents within the worktree are also refused", async () => {
  const { root, repo, worktree } = await fixture();
  await symlink(worktree, join(root, "linked-worktree"));
  assert.match((await copyIntoWorktree(repo, join(root, "linked-worktree"), [".env"])).refused[0]!.why, /worktree root/);
  await mkdir(join(worktree, "elsewhere"));
  await symlink(join(worktree, "elsewhere"), join(worktree, "config"));
  assert.match((await copyIntoWorktree(repo, worktree, ["config/nested/secret.json"])).refused[0]!.why, /symbolic link/);
  assert.equal(existsSync(join(worktree, "elsewhere", "nested")), false);
});

test("overlapping and concurrent copies create each file once and preserve existing content", async () => {
  const { repo, worktree } = await fixture();
  await writeFile(join(worktree, ".env"), "destination's own credentials\n");
  const results = await Promise.all([
    copyIntoWorktree(repo, worktree, [".env", "config/nested/*.json", "config/nested/secret.json"]),
    copyIntoWorktree(repo, worktree, ["config/nested/secret.json"]),
  ]);
  assert.deepEqual(results.flatMap((result) => result.copied), ["config/nested/secret.json"]);
  assert.equal(await readFile(join(worktree, ".env"), "utf8"), "destination's own credentials\n");
  assert.equal(await readFile(join(worktree, "config", "nested", "secret.json"), "utf8"), '{"private":true}\n');
});

test("source parent links and paths escaping the repository are refused", async () => {
  const { repo, worktree, outside } = await fixture();
  await writeFile(join(outside, "credentials"), "never copy this");
  await symlink(outside, join(repo, "config", "linked"));
  const result = await copyIntoWorktree(repo, worktree, ["../outside/credentials", "config/linked/credentials", ".env"]);
  assert.deepEqual(result.copied, [".env"]);
  assert.match(result.refused[0]!.why, /outside the repository/);
  assert.equal(existsSync(join(worktree, "config", "linked", "credentials")), false);
});
