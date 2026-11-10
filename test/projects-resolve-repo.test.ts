import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("concurrent resolutions, linked worktree and symlink share a persisted default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "projects-resolve-"));
  try {
    const repo = join(dir, "repo"), worktree = join(dir, "worktree"), link = join(dir, "link");
    git(dir, "init", repo);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
    git(repo, "worktree", "add", "-b", "other", worktree);
    await symlink(repo, link);
    const file = join(dir, "projects.json");
    const projects = new Projects(file); await projects.load();
    const results = await Promise.all([...Array(10)].map((_, i) => projects.resolveRepo(i % 3 === 0 ? worktree : i % 3 === 1 ? link : repo)));
    assert.equal(new Set(results.map(p => p.id)).size, 1);
    assert.equal(projects.list().length, 1);
    const restarted = new Projects(file); await restarted.load();
    assert.equal((await restarted.resolveRepo(worktree)).id, results[0]!.id);
    assert.deepEqual(restarted.list()[0]!.defaultRepos, [await realpath(repo)]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy matches get a deterministic persisted default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "projects-default-"));
  try {
    const repo = join(dir, "repo"), file = join(dir, "projects.json"); git(dir, "init", repo);
    await writeFile(file, JSON.stringify([{ id: "later", name: "Later", repos: [repo], createdAt: 2 }, { id: "earlier", name: "Earlier", repos: [repo], createdAt: 1 }]));
    const projects = new Projects(file); await projects.load();
    assert.equal((await projects.resolveRepo(repo)).id, "earlier");
    assert.equal((await projects.resolveRepo(repo, "later")).id, "later");
    const restarted = new Projects(file); await restarted.load();
    assert.equal((await restarted.resolveRepo(repo)).id, "earlier");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
