import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { taskCheckpoint, applyTaskTeamResult, TaskTeamConflict, prepareTaskReconciliation, resolveTaskReconciliation, reconciliationFile } from "../src/task-team.js";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
function fixture() { const repo = mkdtempSync(join(tmpdir(), "cf-reconcile-")); git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "shared.txt"), "base\n"); git(repo, "add", "."); git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "base"); return repo; }
test("non-overlapping external edits merge automatically without changing the index or HEAD", async () => {
  const repo = fixture(), head = git(repo, "rev-parse", "HEAD"), baseline = await taskCheckpoint(repo, repo);
  writeFileSync(join(repo, "shared.txt"), "team\n"); const result = await taskCheckpoint(repo, repo);
  writeFileSync(join(repo, "shared.txt"), "base\n"); writeFileSync(join(repo, "user.txt"), "staged\n"); git(repo, "add", "user.txt"); writeFileSync(join(repo, "user.txt"), "unsaved\n");
  const index = git(repo, "diff", "--cached");
  assert.equal((await applyTaskTeamResult(repo, repo, baseline, result)).reconciled, true);
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "team\n"); assert.equal(readFileSync(join(repo, "user.txt"), "utf8"), "unsaved\n");
  await applyTaskTeamResult(repo, repo, baseline, result);
  assert.equal(git(repo, "diff", "--cached"), index); assert.equal(git(repo, "rev-parse", "HEAD"), head);
});
test("three-way conflicts preserve both versions, reject stale choices and apply edited text with non-conflicting files", async () => {
  const repo = fixture(), baseline = await taskCheckpoint(repo, repo);
  writeFileSync(join(repo, "shared.txt"), "team\n"); writeFileSync(join(repo, "extra.txt"), "team extra\n"); const result = await taskCheckpoint(repo, repo);
  unlinkSync(join(repo, "extra.txt")); writeFileSync(join(repo, "shared.txt"), "user\n");
  await assert.rejects(applyTaskTeamResult(repo, repo, baseline, result), TaskTeamConflict);
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user\n");
  const merge = await prepareTaskReconciliation(repo, repo, baseline, result);
  assert.deepEqual(merge.conflicts, ["shared.txt"]);
  assert.equal((await reconciliationFile(repo, repo, merge.current, "shared.txt")).text, "user\n");
  assert.equal((await reconciliationFile(repo, repo, result, "shared.txt")).text, "team\n");
  await assert.rejects(resolveTaskReconciliation(repo, repo, merge, [{ path: "../bad", choice: "team" }]), /each conflicting/);
  writeFileSync(join(repo, "late.txt"), "later\n");
  await assert.rejects(resolveTaskReconciliation(repo, repo, merge, [{ path: "shared.txt", choice: "team" }]), /changed since/);
  const fresh = await prepareTaskReconciliation(repo, repo, baseline, result);
  await resolveTaskReconciliation(repo, repo, fresh, [{ path: "shared.txt", choice: "edited", text: "user and team\n" }]);
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user and team\n"); assert.equal(readFileSync(join(repo, "extra.txt"), "utf8"), "team extra\n"); assert.equal(readFileSync(join(repo, "late.txt"), "utf8"), "later\n");
});

test("binary and modify/delete conflicts accept explicit versions without damaging staged files", async () => {
  const repo = fixture(); writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1])); git(repo, "add", "."); git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "binary baseline");
  const baseline = await taskCheckpoint(repo, repo);
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 2])); unlinkSync(join(repo, "shared.txt")); const result = await taskCheckpoint(repo, repo);
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 3])); writeFileSync(join(repo, "shared.txt"), "user modification\n"); git(repo, "add", "shared.txt"); const index = git(repo, "diff", "--cached");
  const merge = await prepareTaskReconciliation(repo, repo, baseline, result);
  assert.deepEqual(merge.conflicts.sort(), ["binary.dat", "shared.txt"]);
  assert.equal((await reconciliationFile(repo, repo, merge.current, "binary.dat")).binary, true);
  assert.equal((await reconciliationFile(repo, repo, result, "shared.txt")).exists, false);
  await assert.rejects(resolveTaskReconciliation(repo, repo, merge, [{ path: "binary.dat", choice: "edited", text: "text" }, { path: "shared.txt", choice: "current" }]), /binary|Binary/);
  await resolveTaskReconciliation(repo, repo, merge, [{ path: "binary.dat", choice: "team" }, { path: "shared.txt", choice: "current" }]);
  assert.deepEqual(readFileSync(join(repo, "binary.dat")), Buffer.from([0, 2]));
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user modification\n"); assert.equal(git(repo, "diff", "--cached"), index);
});
