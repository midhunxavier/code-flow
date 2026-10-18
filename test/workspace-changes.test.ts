import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCheckpointHunks, checkpointHunks, mergeFileDraft } from "../src/workspace-changes.js";
import { applyCheckpoint } from "../src/workspace.js";
import { worktreeGit } from "../src/git.js";

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-hunks-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main");
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`);
  writeFileSync(join(repo, "file.txt"), lines.join(""));
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "base");
  return { repo, git, lines };
}

test("selective checkpoint hunks apply only reviewed changes and refuse dirty or forged requests", async () => {
  const { repo, git, lines } = fixture();
  try {
    const base = git("rev-parse", "HEAD");
    const changed = [...lines]; changed[1] = "first change\ninserted line\n"; changed[29] = "second change\n";
    writeFileSync(join(repo, "file.txt"), changed.join(""));
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "source");
    const source = git("rev-parse", "HEAD");
    git("reset", "--hard", base);
    const preview = await checkpointHunks(repo, { source, path: "file.txt" });
    assert.equal(preview.hunks.length, 2);
    await assert.rejects(applyCheckpointHunks(repo, { source, path: "file.txt", expectedHead: base, hunks: ["0".repeat(64)] }), /hunks changed/);
    assert.equal(git("status", "--porcelain"), "");
    await applyCheckpointHunks(repo, { source, path: "file.txt", expectedHead: base, hunks: [preview.hunks[1]!.id] });
    const result = readFileSync(join(repo, "file.txt"), "utf8");
    assert.match(result, /line 2\n/); assert.doesNotMatch(result, /first change|inserted line/); assert.match(result, /second change/);
    assert.equal(git("diff", "--cached"), "");
    await assert.rejects(applyCheckpointHunks(repo, { source, path: "file.txt", expectedHead: base, hunks: [preview.hunks[0]!.id] }), /existing changes/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("three-way file merge keeps independent edits and exposes overlapping text without writing", async () => {
  const { repo, lines } = fixture();
  try {
    const base = lines.join("");
    const current = [...lines]; current[1] = "current edit\n";
    const draft = [...lines]; draft[29] = "draft edit\n";
    writeFileSync(join(repo, "file.txt"), current.join(""));
    const merged = await mergeFileDraft(repo, "file.txt", base, draft.join(""));
    assert.equal(merged.clean, true); assert.match(merged.text, /current edit/); assert.match(merged.text, /draft edit/);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), current.join(""));
    const overlapping = [...lines]; overlapping[1] = "other edit\n";
    const conflicts = await mergeFileDraft(repo, "file.txt", base, overlapping.join(""));
    assert.equal(conflicts.clean, false); assert.equal(conflicts.conflicts, 1);
    assert.match(conflicts.text, /<<<<<<< Current file/); assert.match(conflicts.text, /\|\|\|\|\|\|\| Loaded base/); assert.match(conflicts.text, />>>>>>> Your draft/);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), current.join(""));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("selected checkpoint paths stay literal even when filenames contain Git pathspec characters", async () => {
  const { repo, git } = fixture();
  try {
    writeFileSync(join(repo, "*"), "literal original\n");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "literal filename");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "*"), "literal source\n");
    writeFileSync(join(repo, "file.txt"), "unselected source\n");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "source");
    const source = git("rev-parse", "HEAD");
    git("reset", "--hard", base);
    const preview = await checkpointHunks(repo, { source, path: "*" });
    assert.equal(preview.hunks.length, 1);
    assert.doesNotMatch(preview.patchHeader, /file\.txt/);
    await applyCheckpointHunks(repo, { source, path: "*", expectedHead: base, hunks: [preview.hunks[0]!.id] });
    assert.equal(readFileSync(join(repo, "*"), "utf8"), "literal source\n");
    assert.match(readFileSync(join(repo, "file.txt"), "utf8"), /^line 1\n/);
    git("reset", "--hard", base);
    await applyCheckpoint(repo, { source, paths: ["*"], expectedHead: base });
    assert.equal(readFileSync(join(repo, "*"), "utf8"), "literal source\n");
    assert.match(readFileSync(join(repo, "file.txt"), "utf8"), /^line 1\n/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("owned checkpoint helpers retain verified Git metadata when the worktree .git points to a foreign filter", async () => {
  const { repo, git, lines } = fixture();
  const worktree = join(repo, "owned-checkout"), foreign = join(repo, "foreign"), marker = join(repo, "foreign-filter-executed");
  try {
    const base = git("rev-parse", "HEAD"); const changed = [...lines]; changed[1] = "reviewed owned change\n";
    writeFileSync(join(repo, "file.txt"), changed.join("")); git("add", "file.txt"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "source"); const source = git("rev-parse", "HEAD"); git("reset", "--hard", base);
    git("worktree", "add", "-q", "-b", "owned-result", worktree, base); const at = await worktreeGit(repo, worktree);
    mkdirSync(foreign); const foreignGit = (...args: string[]) => execFileSync("git", args, { cwd: foreign, encoding: "utf8" }).trim();
    foreignGit("init", "-q", "-b", "main"); writeFileSync(join(foreign, "file.txt"), "foreign data must survive\n"); foreignGit("add", "."); foreignGit("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "foreign");
    const attributes = join(foreign, "attributes"), filter = join(foreign, "filter"); writeFileSync(attributes, "*.txt filter=impostor\n");
    writeFileSync(filter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);\n`, { mode: 0o700 }); foreignGit("config", "core.attributesFile", attributes); foreignGit("config", "filter.impostor.clean", filter);
    const foreignHead = foreignGit("rev-parse", "HEAD"), foreignIndex = readFileSync(join(foreign, ".git", "index"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(foreign, ".git")}\n`);
    const preview = await checkpointHunks(at, { source, path: "file.txt" }); assert.equal(preview.head, base); assert.equal(preview.hunks.length, 1);
    await applyCheckpointHunks(at, { source, path: "file.txt", expectedHead: base, hunks: [preview.hunks[0]!.id] });
    assert.equal(readFileSync(join(worktree, "file.txt"), "utf8"), changed.join("")); assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), lines.join(""));
    assert.equal(readFileSync(join(foreign, "file.txt"), "utf8"), "foreign data must survive\n"); assert.equal(foreignGit("rev-parse", "HEAD"), foreignHead); assert.deepEqual(readFileSync(join(foreign, ".git", "index")), foreignIndex); assert.equal(existsSync(marker), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
