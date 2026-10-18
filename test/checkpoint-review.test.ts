import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, resolveCommit } from "../src/git.js";
import { applyCommitRevert, compareCheckpoint, previewCommitRevert } from "../src/checkpoint-review.js";

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "codeflow-revert-"));
  const command = async (...args: string[]) => { const result = await git(args, repo); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  await command("init", "-q", "-b", "main");
  await command("config", "user.name", "test"); await command("config", "user.email", "test@test");
  const commit = async (text: string, subject: string) => { await writeFile(join(repo, "file.txt"), text); await command("add", "file.txt"); await command("commit", "-qm", subject); return resolveCommit(repo); };
  const base = await commit("one\ntwo\nthree\n", "base");
  return { repo, command, commit, base, close: () => rm(repo, { recursive: true, force: true }) };
}
test("full comparison pins both commits and revert stages an inverse without rewriting history", async () => {
  const f = await fixture();
  try {
    const target = await f.commit("one\nchanged\nthree\n", "change second line");
    const compared = await compareCheckpoint(f.repo, { from: f.base, to: target });
    assert.equal(compared.from, f.base); assert.equal(compared.to, target);
    assert.deepEqual(compared.files, [{ status: "M", path: "file.txt" }]); assert.match(compared.patch, /\+changed/);
    const preview = await previewCommitRevert(f.repo, { commit: target, expectedHead: target });
    assert.match(preview.patch, /\+two/); assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "one\nchanged\nthree\n");
    assert.equal((await f.command("status", "--porcelain")).trim(), "");
    const result = await applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint });
    assert.equal(result.staged, true); assert.equal(await resolveCommit(f.repo), target);
    assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.match(await f.command("status", "--porcelain"), /^M  file.txt/m);
  } finally { await f.close(); }
});
test("conflicting, stale, forged and dirty reversions preserve existing work", async () => {
  const f = await fixture();
  try {
    const target = await f.commit("one\nchanged\nthree\n", "target");
    const preview = await previewCommitRevert(f.repo, { commit: target, expectedHead: target });
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: "0".repeat(64) }), /changed/);
    await writeFile(join(f.repo, "file.txt"), "my draft\n");
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint }), /changed tracked|existing changes/);
    assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "my draft\n");
    const head = await f.commit("one\nchanged again\nthree\n", "conflict");
    await assert.rejects(previewCommitRevert(f.repo, { commit: target, expectedHead: target }), /changed/);
    await assert.rejects(previewCommitRevert(f.repo, { commit: target, expectedHead: head }), /conflict resolution/);
    assert.equal((await f.command("status", "--porcelain")).trim(), "");
    assert.equal(await resolveCommit(f.repo), head);
    assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "one\nchanged again\nthree\n");
  } finally { await f.close(); }
});
test("hidden tracked-file changes are rejected before applying a reviewed revert", async () => {
  const f = await fixture();
  try {
    const target = await f.commit("one\nchanged\nthree\n", "target");
    const preview = await previewCommitRevert(f.repo, { commit: target, expectedHead: target });
    await f.command("update-index", "--assume-unchanged", "file.txt"); await writeFile(join(f.repo, "file.txt"), "hidden draft\n");
    await assert.rejects(applyCommitRevert(f.repo, { commit: target, expectedHead: target, fingerprint: preview.fingerprint }), /hid tracked files/);
    assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "hidden draft\n");
  } finally { await f.close(); }
});
