import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMergeTarget } from "../src/merge-validation.js";
import { mergeInto } from "../src/ship.js";

test("merge verification tests the combined target and rejects validation after either ref moves", async () => {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-merge-validation-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  const commit = (message: string) => { git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", message); };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "math.mjs"), "export const sum = (a,b) => a-b;\n");
    writeFileSync(join(repo, "math.test.mjs"), "import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./math.mjs';test('sum',()=>assert.equal(sum(1,2),-1));\n");
    commit("base"); const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "result");
    writeFileSync(join(repo, "math.mjs"), "export const sum = (a,b) => a+b;\n");
    writeFileSync(join(repo, "math.test.mjs"), "import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./math.mjs';test('sum',()=>assert.equal(sum(1,2),3));\n");
    commit("result"); const source = git("rev-parse", "HEAD");
    git("checkout", "-qb", "target", base);
    writeFileSync(join(repo, "integration.test.mjs"), "import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./math.mjs';test('consumer depends on subtraction',()=>assert.equal(sum(1,2),-1));\n");
    commit("new consumer"); const target = git("rev-parse", "HEAD");
    const profile = { name: "tests", checks: [{ id: "unit", kind: "unit" as const, command: "node --test", required: true, timeoutMs: 10000 }] };
    const bad = await validateMergeTarget(repo, { branch: "result", into: "target", profile });
    assert.equal(bad.report?.state, "needs-changes"); assert.equal(bad.conflicts.length, 0);
    assert.equal(git("rev-parse", "result"), source); assert.equal(git("rev-parse", "target"), target); assert.equal(git("status", "--porcelain"), "");
    git("checkout", "-qb", "clean-target", base);
    writeFileSync(join(repo, "README.md"), "independent target change\n"); commit("docs");
    const good = await validateMergeTarget(repo, { branch: "result", into: "clean-target", profile });
    assert.equal(good.report?.state, "verified");
    writeFileSync(join(repo, "README.md"), "target moved\n"); commit("moving target");
    const moved = git("rev-parse", "HEAD");
    await assert.rejects(mergeInto(repo, "result", "clean-target", "merge", good), /moved after validation/);
    assert.equal(git("rev-parse", "HEAD"), moved);
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "temporary merge checkouts were removed");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("merge validation rejects setup and per-gate tracked, index and HEAD drift while allowing generated files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-merge-drift-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "subject.txt"), "Original candidate\n");
    writeFileSync(join(repo, ".gitignore"), "/build/\n");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
    const target = git("rev-parse", "HEAD");
    git("checkout", "-qb", "result");
    writeFileSync(join(repo, "result.txt"), "Result branch\n");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "result");
    const source = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const profile = (commands: string[]) => ({ name: "drift checks", checks: commands.map((command, index) => ({ id: `gate-${index}`, kind: "custom" as const, command, required: true, timeoutMs: 10000 })) });
    await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "main", setup: "printf 'Setup rewrite\\n' > subject.txt", profile: profile(["true"]) }), /validation setup changed tracked/);
    await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "main", profile: profile(["printf 'Passing replacement\\n' > subject.txt", "git checkout -- subject.txt"]) }), /validation gate gate-0 changed tracked/, "the next gate cannot hide a previous gate's rewrite");
    await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "main", profile: profile(["printf 'Staged replacement\\n' > subject.txt && git add subject.txt"]) }), /staged tree/);
    await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "main", profile: profile(["git -c user.name=test -c user.email=test@test commit -qm 'Commit candidate while validating'"]) }), /checkout commit/);
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "main", profile: profile([`git update-index ${flag} subject.txt && printf 'Hidden rewrite\\n' > subject.txt`]) }), /hid tracked files/, flag);
    const generated = await validateMergeTarget(repo, { branch: "result", into: "main", setup: "mkdir build && printf 'generated\\n' > build/output", profile: profile(["printf 'scratch\\n' > scratch.log && test -f build/output"]) });
    assert.equal(generated.report?.state, "verified");
    assert.equal(git("rev-parse", "main"), target);
    assert.equal(git("rev-parse", "result"), source);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "failed candidate checkouts were removed");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("container merge validation mounts the linked marker and verified common Git metadata read-only for setup and gates", async () => {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-merge-docker-"));
  const records = mkdtempSync(join(tmpdir(), "codeflow-merge-docker-records-"));
  const originalPath = process.env.PATH;
  const originalRecords = process.env.FAKE_RECORD_DIR;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "Initial fixture\n");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
    git("checkout", "-qb", "result");
    writeFileSync(join(repo, "result.txt"), "Result branch\n");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "result");
    git("checkout", "-q", "main");
    process.env.PATH = `${join(root, "test/fake-bin")}:${originalPath}`;
    process.env.FAKE_RECORD_DIR = records;
    const result = await validateMergeTarget(repo, { branch: "result", into: "main", setup: "git rev-parse --verify HEAD", container: { image: "fixture-checks", network: false }, profile: { name: "git-aware check", checks: [{ id: "git", kind: "custom", command: "git diff --cached --name-only && test -f result.txt", required: true, timeoutMs: 10000 }] } });
    assert.equal(result.report?.state, "verified");
    const invocations = readdirSync(records).filter((file) => file.startsWith("docker-")).map((file) => JSON.parse(readFileSync(join(records, file), "utf8")) as { args: string[] });
    assert.equal(invocations.length, 2, "both setup and verification use container isolation");
    for (const { args } of invocations) {
      const cwd = args[args.indexOf("-w") + 1]!;
      const mounts = args.filter((_arg, index) => args[index - 1] === "-v");
      const common = realpathSync(join(repo, ".git"));
      assert.deepEqual(mounts, [`${cwd}:${cwd}`, `${join(cwd, ".git")}:${join(cwd, ".git")}:ro`, `${common}:${common}:ro`]);
      assert.deepEqual(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2), ["--network", "none"]);
      assert.equal(mounts.some((mount) => mount.includes(join(process.env.HOME!, ".codex"))), false);
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalRecords === undefined) delete process.env.FAKE_RECORD_DIR; else process.env.FAKE_RECORD_DIR = originalRecords;
    rmSync(repo, { recursive: true, force: true });
    rmSync(records, { recursive: true, force: true });
  }
});
