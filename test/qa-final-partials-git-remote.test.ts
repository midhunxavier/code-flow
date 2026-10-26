import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm, access, writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeHostGit, type CodeHostGitCommand } from "../src/code-host-git.js";
import type { CodeHostSession } from "../src/integrations.js";
import { git as gitCommand } from "../src/git.js";

const session = { gitEnvironment: () => ({}) } as unknown as CodeHostSession;
const refs = { head: "a".repeat(40), target: "b".repeat(40), sourceRef: "refs/heads/feature", targetRef: "refs/heads/main", sourceUrl: "https://fixture.invalid/source.git", targetUrl: "https://fixture.invalid/target.git" };
async function fixture(t: any) {
  const repo = await mkdtemp(join(tmpdir(), "qa-final-budget-")); t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "subject.txt"), "unchanged\n"); git("add", "."); git("commit", "-qm", "base"); return { repo, git };
}

test("staging monitor preserves its storage-limit reason and removes the quarantine", async t => {
  const f = await fixture(t), before = f.git("count-objects", "-v"); let staging = "", imports = 0;
  const command: CodeHostGitCommand = async (args, cwd, options) => {
    if (cwd === f.repo) imports++;
    if (!args.includes(refs.sourceUrl)) return { code: 0, stdout: "", stderr: "" };
    staging = cwd;
    // A sparse file triggers the real stat-based monitor without allocating 256 MiB.
    const file = await open(join(cwd, "oversized-pack"), "wx"); await file.truncate(256 * 1024 ** 2 + 1); await file.close();
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("staging monitor did not abort")), 3000); options.signal!.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    return { code: 1, stdout: "", stderr: "", aborted: true };
  };
  await assert.rejects(new CodeHostGit(command).fetch(f.repo, session, refs), error => error instanceof Error && /exceeds storage limits.*256 MiB/.test(error.message) && !/push/.test(error.message));
  assert.equal(imports, 0); await assert.rejects(access(staging)); assert.equal(f.git("count-objects", "-v"), before); assert.equal(f.git("status", "--porcelain"), "");
});

test("caller cancellation remains cancellation and read-only fetch never suggests a push occurred", async t => {
  const f = await fixture(t), abort = new AbortController(); let staging = "";
  const command: CodeHostGitCommand = async (args, cwd) => {
    if (!args.includes(refs.sourceUrl)) return { code: 0, stdout: "", stderr: "" };
    staging = cwd; abort.abort(new Error("private caller reason")); return { code: 1, stdout: "", stderr: "", aborted: true };
  };
  await assert.rejects(new CodeHostGit(command).fetch(f.repo, session, refs, abort.signal), { message: "Code host Git action cancelled" });
  await assert.rejects(access(staging)); assert.equal(f.git("status", "--porcelain"), "");
});

test("a fetch finishing between monitor ticks is budget-checked before importing local objects", async t => {
  const f = await fixture(t), upstream = await mkdtemp(join(tmpdir(), "qa-budget-upstream-")); t.after(() => rm(upstream, { recursive: true, force: true }));
  const target = f.git("rev-parse", "HEAD"); f.git("checkout", "-qb", "feature"); await writeFile(join(f.repo, "incoming.txt"), "remote-only content\n"); f.git("add", "."); f.git("commit", "-qm", "incoming"); const head = f.git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "-q", f.repo, join(upstream, "remote.git")]); f.git("checkout", "-q", "main"); f.git("branch", "-D", "feature"); f.git("reflog", "expire", "--expire=now", "--all"); f.git("prune", "--expire=now");
  const objectBytes = async () => { const dir = join(f.repo, ".git/objects"), files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()); return Promise.all(files.map(async file => `${file.parentPath.slice(dir.length)}/${file.name}:${createHash("sha256").update(await readFile(join(file.parentPath, file.name))).digest("hex")}`)).then(values => values.sort()); };
  const before = await objectBytes(), beforeRefs = f.git("show-ref"); let imports = 0, staging = "";
  const command: CodeHostGitCommand = async (args, cwd, options) => {
    if (cwd === f.repo && args.includes("fetch")) imports++;
    const result = await gitCommand(args.map(arg => arg === refs.sourceUrl || arg === refs.targetUrl ? join(upstream, "remote.git") : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg), cwd, options);
    // Force budget growth at the last staging command, immediately before the import boundary.
    if (args.includes("refs/heads/import-base")) { staging = cwd; const file = await open(join(cwd, "oversized-pack"), "wx"); await file.truncate(256 * 1024 ** 2 + 1); await file.close(); }
    return result;
  };
  await assert.rejects(new CodeHostGit(command).fetch(f.repo, session, { ...refs, target, head }), /exceeds storage limits/);
  assert.equal(imports, 0, "the final budget check must precede the local import effect");
  assert.deepEqual(await objectBytes(), before); assert.equal(f.git("show-ref"), beforeRefs); assert.equal(f.git("status", "--porcelain"), ""); await assert.rejects(access(staging));
});

test("oversized push staging is refused before its effect ledger boundary", async t => {
  const f = await fixture(t); let effects = 0, pushes = 0;
  const command: CodeHostGitCommand = async (args, cwd) => {
    if (args.includes("merge-base")) { const file = await open(join(cwd, "oversized-pack"), "wx"); await file.truncate(256 * 1024 ** 2 + 1); await file.close(); }
    if (args.includes("push")) pushes++;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(new CodeHostGit(command).push(f.repo, session, { url: refs.sourceUrl, ref: "refs/heads/feature", expected: refs.target, commit: refs.head, beforeEffect: () => effects++ }), /exceeds storage limits/);
  assert.equal(effects, 0); assert.equal(pushes, 0);
});

test("an interrupted push keeps the explicit remote-outcome inspection advice", async t => {
  const f = await fixture(t); let effects = 0;
  // Pure command stand-in: it performs no push, even to a scratch remote.
  const command: CodeHostGitCommand = async args => args.includes("push") ? { code: 1, stdout: "", stderr: "", aborted: true } : { code: 0, stdout: "", stderr: "" };
  await assert.rejects(new CodeHostGit(command).push(f.repo, session, { url: refs.sourceUrl, ref: "refs/heads/feature", expected: refs.target, commit: refs.head, beforeEffect: () => effects++ }), /cancelled; inspect any attempted push before retrying/);
  assert.equal(effects, 1);
});
