// Review diffs and the comments sent from them: every changed file gets its patch whatever its
// name (non-ASCII, a " b/" in it, quotes, tabs), the test-integrity scan names such files right,
// and an Agent chat's review comments, CI fixes and conflict resolutions keep the chat's provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-review-diff-home-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { branchDiff, workspaceDiff } = await import("../src/ship.js");
const { inspectChanges } = await import("../src/integrity.js");
const { quoteGitPath } = await import("../src/git.js");
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
type Run = import("../src/engine.js").Run;

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "cf-qa-review-diff-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  return { repo, git, write };
}

const NAMES = ["café notes.md", "a b/c.txt", "日本 b/ü.txt", "ta\tb.txt", 'qu"ote.txt', "back\\slash.txt", "new\nline.txt", "plain.md"];

test("every changed file has its own patch, whatever its name", async () => {
  const { repo, git, write } = repository();
  write("base.txt", "base\n"); write("link", "plain\n"); write("old.txt", "renamed content\n");
  git("add", "."); git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD");
  // A config that changes the prefixes and quoting of a plain `git diff` must not change what Review shows.
  git("config", "diff.mnemonicPrefix", "true"); git("config", "diff.noprefix", "true"); git("config", "core.quotePath", "true");
  for (const name of NAMES) write(name, `line of ${name}\n`);
  rmSync(join(repo, "link")); symlinkSync("base.txt", join(repo, "link"));
  mkdirSync(join(repo, "x b"), { recursive: true }); git("mv", "old.txt", "x b/renamed é.txt");
  git("add", "-A"); git("commit", "-qm", "names");

  const files = await branchDiff(repo, base, "main");
  for (const name of NAMES) {
    const file = files.find((f) => f.path === name);
    assert.ok(file, `${JSON.stringify(name)} is listed`);
    assert.equal(file.additions, name.includes("\n") ? 2 : 1, `${JSON.stringify(name)}'s counts`);
    assert.match(file.patch, /^@@ -0,0 \+1(,2)? @@$/m, `${JSON.stringify(name)} has its hunk`);
    assert.ok(file.patch.includes(`+line of ${name.split("\n")[0]}`), `${JSON.stringify(name)} has its own added line`);
  }
  const renamed = files.find((f) => f.path === "x b/renamed é.txt")!;
  assert.equal(renamed.oldPath, "old.txt");
  assert.match(renamed.patch, /^rename from old\.txt$/m);
  // A file that became a symlink: its deletion and its creation, not just the second half.
  const link = files.find((f) => f.path === "link")!;
  assert.match(link.patch, /^-plain$/m);
  assert.match(link.patch, /^\+base\.txt$/m);

  // Working files (an Agent chat's review) go through the same parsing.
  write("x b/notas-café.md", "working line\n");
  const working = await workspaceDiff(repo, base);
  assert.match(working.find((f) => f.path === "x b/notas-café.md")?.patch ?? "", /^\+working line$/m);
  assert.match(working.find((f) => f.path === "café notes.md")?.patch ?? "", /^\+line of café notes\.md$/m);
});

test("git's quoting of a path in a patch header", () => {
  assert.equal(quoteGitPath("b/café notes.md"), "b/café notes.md");
  assert.equal(quoteGitPath("b/ta\tb.txt"), '"b/ta\\tb.txt"');
  assert.equal(quoteGitPath('b/qu"ote'), '"b/qu\\"ote"');
  assert.equal(quoteGitPath("b/back\\slash"), '"b/back\\\\slash"');
  assert.equal(quoteGitPath("b/bell\x07\x01\x7f"), '"b/bell\\a\\001\\177"');
});

test("the test-integrity scan names test files with spaces and non-ASCII names as they are", async () => {
  const { repo, git, write } = repository();
  write("tests/café spec.test.ts", "assert.equal(1, 1);\nassert.equal(2, 2);\nassert.equal(3, 3);\n");
  git("add", "."); git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD");
  write("tests/café spec.test.ts", "assert.equal(1, 1);\n");
  write("new b/added.test.ts", "it.skip('later', () => {});\n");
  git("add", "-A"); git("commit", "-qm", "change tests");
  const issues = await inspectChanges(repo, base);
  const weakened = issues.find((issue) => issue.kind === "weakened-test");
  assert.equal(weakened?.file, "tests/café spec.test.ts");
  const skipped = issues.find((issue) => issue.kind === "skipped-test");
  assert.equal(skipped?.file, "new b/added.test.ts");
  assert.equal(skipped?.severity, "medium", "a skip in a newly added test file is the lesser concern");
});

async function idle(run: Run) {
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.status, "done", run.error);
}

test("an Agent chat's review comments, conflict resolutions and PR fixes keep its provider; side chats choose", async () => {
  const { repo, git, write } = repository();
  write("README.md", "Fixture\n"); git("add", "."); git("commit", "-qm", "init");
  const manager = new RunManager(findPattern);
  const original = { codex: adapters.codex.run, claude: adapters.claude.run };
  const calls: string[] = [];
  adapters.codex.run = async () => { calls.push("codex"); return { ok: true, finalText: "Done" }; };
  adapters.claude.run = async () => { calls.push("claude"); return { ok: true, finalText: "Done" }; };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, task: "Inspect the fixture", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
    await idle(run);
    const worktree = run.worktrees[0]!;
    await assert.rejects(manager.followUp(run.id, { kind: "comments", worktree: worktree.name, agent: "claude", message: "1. README.md:1 — `Fixture`\n   Reword" }), /current provider/);
    await assert.rejects(manager.followUp(run.id, { worktree: worktree.name, agent: "agy", message: "Default kind is comments" }), /current provider/);
    await assert.rejects(manager.followUp(run.id, { kind: "resolve-conflicts", worktree: worktree.name, agent: "claude", mergeFrom: "main" }), /current provider/);
    assert.equal(run.followUps.length, 0, "a refused provider never queues a turn");
    run.prs[worktree.branch] = "https://github.com/o/r/pull/1";
    assert.throws(() => manager.watchPr(run.id, { branch: worktree.branch, agent: "claude" }), /current provider/);
    assert.equal(run.watches[worktree.branch], undefined);
    assert.equal(manager.watchPr(run.id, { branch: worktree.branch, agent: "codex" }).agent, "codex");
    manager.unwatchPr(run.id, worktree.branch);

    await manager.followUp(run.id, { kind: "comments", worktree: worktree.name, agent: "codex", message: "1. README.md:1 — `Fixture`\n   Reword" });
    await idle(run);
    assert.equal(run.followUps.at(-1)!.agent, "codex");
    assert.equal(run.followUps.at(-1)!.status, "done", run.followUps.at(-1)!.result);
    await manager.followUp(run.id, { kind: "side", side: { chat: "other", mode: "ask", title: "Ask Claude" }, worktree: worktree.name, agent: "claude", message: "A second opinion" });
    await idle(run);
    assert.equal(run.followUps.at(-1)!.agent, "claude");
    assert.deepEqual(calls, ["codex", "codex", "claude"]);
  } finally {
    adapters.codex.run = original.codex;
    adapters.claude.run = original.claude;
  }
});
