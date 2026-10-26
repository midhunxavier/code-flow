import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, resolveCommit } from "../src/git.js";
import { applyCommitRevert, previewCommitRevert } from "../src/checkpoint-review.js";
import { applyCheckpointHunks, checkpointHunks } from "../src/workspace-changes.js";
import { applyCheckpoint, CheckpointDeletionError, checkpoints, WorkspaceConflictError } from "../src/workspace.js";

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "codeflow-qa-checkpoints-"));
  const command = async (...args: string[]) => { const result = await git(args, repo); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  await command("init", "-q", "-b", "main"); await command("config", "user.name", "test"); await command("config", "user.email", "test@test");
  const commit = async (files: Record<string, string>, subject: string) => { for (const [path, text] of Object.entries(files)) { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); await command("add", path); } await command("commit", "-qm", subject); return resolveCommit(repo); };
  const base = await commit({ "file.txt": "one\ntwo\nthree\n" }, "base");
  return { repo, command, commit, base, close: () => rm(repo, { recursive: true, force: true }) };
}
const clean = async (f: Awaited<ReturnType<typeof fixture>>) => assert.equal((await f.command("status", "--porcelain", "--untracked-files=all")).trim(), "");

test("revert refusals say what to do: existing changes, a moved HEAD, a changed preview, hidden files", async () => {
  const f = await fixture();
  try {
    const target = await f.commit({ "file.txt": "one\nchanged\nthree\n" }, "target");
    const preview = await previewCommitRevert(f.repo, { commit: target, expectedHead: target });
    const notVerification = (pattern: RegExp) => (error: Error) => pattern.test(error.message) && !/Verification|draft/.test(error.message);
    await writeFile(join(f.repo, "file.txt"), "my draft\n");
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint }), notVerification(/^Commit or save all existing changes before reverting a commit$/));
    await f.command("checkout", "--", "file.txt");
    await writeFile(join(f.repo, "staged.txt"), "staged only\n"); await f.command("add", "staged.txt");
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint }), notVerification(/^Commit or save all existing changes/));
    await f.command("rm", "-q", "--cached", "staged.txt"); await rm(join(f.repo, "staged.txt")); await clean(f);
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: "a".repeat(64) }), (error: Error) => error instanceof WorkspaceConflictError && /changed since you previewed it\. Preview the inverse commit again/.test(error.message) && !/draft/.test(error.message));
    const moved = await f.commit({ "other.txt": "later\n" }, "later");
    await assert.rejects(previewCommitRevert(f.repo, { commit: target, expectedHead: target }), (error: Error) => error instanceof WorkspaceConflictError && error.currentHash === moved && /HEAD changed since checkpoints were loaded/.test(error.message));
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint }), /HEAD changed since checkpoints were loaded/);
    const fresh = await previewCommitRevert(f.repo, { commit: target, expectedHead: moved });
    await f.command("update-index", "--assume-unchanged", "file.txt"); await writeFile(join(f.repo, "file.txt"), "hidden draft\n");
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: moved, fingerprint: fresh.fingerprint }), notVerification(/hid tracked files.*Clear them before reverting/));
  } finally { await f.close(); }
});

test("checkpoint files and hunks refuse a moved HEAD with checkpoint wording", async () => {
  const f = await fixture();
  try {
    const head = await f.commit({ "file.txt": "one\nTWO\nthree\n" }, "edit");
    const hunks = await checkpointHunks(f.repo, { source: f.base, path: "file.txt" });
    await f.commit({ "other.txt": "x\n" }, "moved");
    await assert.rejects(applyCheckpointHunks(f.repo, { source: f.base, path: "file.txt", expectedHead: hunks.head, hunks: [hunks.hunks[0]!.id] }), (error: Error) => error instanceof WorkspaceConflictError && /HEAD changed since these hunks were compared\. Compare hunks again/.test(error.message));
    await assert.rejects(applyCheckpoint(f.repo, { source: f.base, paths: ["file.txt"], expectedHead: head }), (error: Error) => error instanceof WorkspaceConflictError && /HEAD changed since checkpoints were loaded/.test(error.message) && !/draft/.test(error.message));
    await clean(f);
  } finally { await f.close(); }
});

test("applying checkpoint files asks before deleting paths the checkpoint lacks, and reports them", async () => {
  const f = await fixture();
  try {
    const head = await f.commit({ "later.txt": "added later\n", "dir/new.txt": "new\n", "dir/old.txt": "old\n", "file.txt": "edited\n" }, "later");
    await assert.rejects(applyCheckpoint(f.repo, { source: f.base, paths: ["later.txt", "file.txt"], expectedHead: head }), (error: Error) => error instanceof CheckpointDeletionError && error.paths.join() === "later.txt" && /This file isn't in checkpoint .{8}, so applying it deletes it from the worktree: later\.txt/.test(error.message));
    await clean(f); assert.ok(existsSync(join(f.repo, "later.txt")));
    const applied = await applyCheckpoint(f.repo, { source: f.base, paths: ["later.txt", "file.txt"], expectedHead: head, confirmDeletes: true });
    assert.deepEqual(applied.deleted, ["later.txt"]); assert.equal(existsSync(join(f.repo, "later.txt")), false);
    assert.equal((await f.command("diff", "--cached")).trim(), ""); assert.match(await f.command("status", "--porcelain"), / D later\.txt/);
    await f.command("checkout", "--", "."); await clean(f);
    await assert.rejects(applyCheckpoint(f.repo, { source: f.base, paths: ["dir"], expectedHead: head }), (error: Error) => error instanceof CheckpointDeletionError && error.paths.join() === "dir/new.txt,dir/old.txt" && /These 2 files aren't/.test(error.message));
    const plain = await applyCheckpoint(f.repo, { source: head, paths: ["file.txt"], expectedHead: head }); assert.deepEqual(plain.deleted, []);
  } finally { await f.close(); }
});

test("checkpoints given a run's base mark which commits a fork may start from", async () => {
  const f = await fixture();
  try {
    const before = await f.commit({ "file.txt": "before\n" }, "before the run"), start = await f.commit({ "file.txt": "start\n" }, "run base");
    const made = await f.commit({ "file.txt": "run work\n" }, "run work");
    const listed = await checkpoints(f.repo, "HEAD", start);
    assert.deepEqual(listed.map((item) => [item.sha, item.owned]), [[made, true], [start, true], [before, false], [f.base, false]]);
    assert.equal((await checkpoints(f.repo))[0]!.owned, undefined);
  } finally { await f.close(); }
});
