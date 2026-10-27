// Merging results and resolving their conflicts: a resolution that fails or leaves conflict
// markers is never committed (and a result with markers is never merged), the review after a
// resolution labels every imported file, and other runs' result branches, whatever their
// prefix, are runs' branches rather than merge targets. Agents are the fake CLIs, or an in-test
// stub where a test needs a resolver that fails or does nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-qa-merge-home-"));
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";

const { ConflictMarkersError, RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { getAdapter } = await import("../src/adapters/index.js");
const { addedConflictMarkers, listBranches } = await import("../src/git.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;
type RunOptions = import("../src/adapters/index.js").RunOptions;
type RunResult = import("../src/adapters/index.js").RunResult;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString().trim();
const MARKERS = /^(<{7}|>{7})( |$)/m;

function newRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-qa-merge-repo-"));
  sh(dir, "init", "-q", "-b", "main");
  for (const [path, body] of Object.entries({ "README.md": "merge\n", "shared.txt": "base\n", ...files })) writeFileSync(join(dir, path), body);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

function idle(manager: Manager, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve(run);
    manager.subscribe(run.id, check);
    check();
  });
}

/** Replace claude's adapter with `stub` while `fn` runs. */
async function withClaude<T>(stub: (opts: RunOptions) => Promise<RunResult>, fn: () => Promise<T>): Promise<T> {
  const adapter = getAdapter("claude");
  const saved = adapter.run;
  adapter.run = stub;
  try {
    return await fn();
  } finally {
    adapter.run = saved;
  }
}

/** A finished solo run that rewrote shared.txt, and a `theirs` branch that changed it too (and added a file of its own). */
async function conflictingRun(manager: Manager, dir: string, start: Record<string, unknown> = {}) {
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, checkpointOnFinish: true, task: "Edit shared.txt CONFLICT", repo: dir, roles: { agent: ["claude"] }, options: {}, ...start }));
  assert.equal(run.status, "done", run.error);
  const branch = run.artifacts[0]!.branch;
  sh(dir, "checkout", "-q", "-b", "theirs", "main");
  writeFileSync(join(dir, "shared.txt"), "their version\n");
  writeFileSync(join(dir, "target-only.txt"), "only on theirs\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "theirs");
  sh(dir, "checkout", "-q", "main");
  const outcome = await manager.merge(run.id, { branch, into: "theirs" });
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.conflicts, ["shared.txt"]);
  return { run, branch, wt: run.worktrees[0]! };
}

async function resolve(manager: Manager, run: Run, worktree: string) {
  await manager.followUp(run.id, { kind: "resolve-conflicts", worktree, agent: "claude", mergeFrom: "theirs" });
  await idle(manager, run);
  return run.followUps.at(-1)!;
}

for (const [name, stub] of [
  ["fails", async (): Promise<RunResult> => ({ ok: false, finalText: "", error: "claude exited with code 1: boom" })],
  // Exits 0 but leaves the markers in, staged at that: the files are still read, not the index.
  ["leaves the markers in", async (opts: RunOptions): Promise<RunResult> => { execFileSync("git", ["add", "-A"], { cwd: opts.cwd }); return { ok: true, finalText: "Resolved.", sessionId: "s" }; }],
] as const) {
  test(`a conflict resolution that ${name} commits nothing, and merging reports the conflict again`, async () => {
    const dir = newRepo();
    const manager = new RunManager(findPattern);
    const { run, branch, wt } = await conflictingRun(manager, dir);
    const head = sh(dir, "rev-parse", branch);
    const f = await withClaude(stub, () => resolve(manager, run, wt.name));

    assert.equal(f.status, "failed");
    assert.equal(f.commit, undefined);
    assert.match(f.result ?? "", name === "fails" ? /claude's turn failed \(claude exited with code 1: boom\)/ : /Conflict markers remain in shared\.txt/);
    assert.match(f.result ?? "", /code-flow undid the merge and committed nothing/);
    assert.match(run.summary ?? "", /claude couldn't resolve the conflicts with `theirs` \(nothing was committed\)/);
    assert.equal(sh(dir, "rev-parse", branch), head, "the result branch didn't move");
    assert.doesNotMatch(sh(dir, "log", "-1", "--format=%s", branch), /conflicts resolved by/);
    assert.doesNotMatch(sh(dir, "show", `${branch}:shared.txt`), MARKERS);
    assert.ok(!existsSync(join(dir, ".git", "worktrees", wt.name, "MERGE_HEAD")) && sh(wt.path, "status", "--porcelain") === "", "no merge is left half done in the worktree");
    assert.doesNotMatch(readFileSync(join(wt.path, "shared.txt"), "utf8"), MARKERS);
    const again = await manager.merge(run.id, { branch, into: "theirs" });
    assert.ok(!again.ok, "not merged");
    assert.deepEqual(again.conflicts, ["shared.txt"]);
    assert.equal(sh(dir, "show", "theirs:shared.txt"), "their version");
  });
}

const paths = (files: { path: string }[]) => files.map((file) => file.path);
const labels = (files: { path: string; mergedFrom?: string }[]) => files.map((file) => (file.mergedFrom ? `${file.path} (from ${file.mergedFrom})` : file.path));
const merge = (dir: string, into: string, from: string) => {
  sh(dir, "checkout", "-q", into);
  sh(dir, "merge", "-q", "--no-edit", from);
  sh(dir, "checkout", "-q", "main");
};

test("a resolved conflict is committed, and review keeps imported files visible even when the base branch advances", async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const { run, branch, wt } = await conflictingRun(manager, dir);
  const f = await resolve(manager, run, wt.name);
  assert.equal(f.status, "done", f.result);
  assert.equal(sh(dir, "log", "-1", "--format=%s", branch), `Merge theirs (conflicts resolved by claude, ${f.id})`);
  assert.equal(sh(dir, "show", `${branch}:target-only.txt`), "only on theirs", "the target is merged in");

  // Merging into main (the branch the run started from, Merge…'s default) or any other branch
  // without theirs brings target-only.txt along: the review says so, and says where it came from.
  assert.deepEqual(labels(await manager.diff(run.id, branch)), ["shared.txt", "target-only.txt (from theirs)"]);
  assert.deepEqual(paths(await manager.diff(run.id, branch, true)), ["shared.txt"], "the last step is the resolution");
  const coverage = await manager.reviewCoverage(run.id, branch);
  assert.deepEqual(coverage.files, ["shared.txt", "target-only.txt"]);
  assert.deepEqual(coverage.merged, { from: "theirs", files: ["target-only.txt"] });
  assert.equal(coverage.coverage.changed, 2);
  assert.match(run.artifacts.find((a) => a.branch === branch)!.stat ?? "", /target-only\.txt/);

  // The verifier's repro: reviewed only shared.txt, then merged into a branch off main.
  await manager.recordFileReview(run.id, { branch, expectedHead: coverage.head, path: "shared.txt", reviewed: true });
  assert.equal((await manager.reviewCoverage(run.id, branch)).coverage.percent, 50, "not 100% while target-only.txt would ship unreviewed");
  sh(dir, "branch", "other", "main");
  assert.ok((await manager.merge(run.id, { branch, into: "other" })).ok);
  const shipped = sh(dir, "diff", "--name-only", "main", "other").split("\n");
  assert.deepEqual(shipped, ["shared.txt", "target-only.txt"]);
  assert.deepEqual(shipped, coverage.files, "everything the merge shipped was in the review");

  // Advancing main must not hide files: Merge… can still choose an older branch.
  sh(dir, "branch", "older", "main");
  merge(dir, "main", "theirs");
  assert.deepEqual(labels(await manager.diff(run.id, branch)), ["shared.txt", "target-only.txt (from theirs)"]);
  const after = await manager.reviewCoverage(run.id, branch);
  assert.deepEqual(after.files, ["shared.txt", "target-only.txt"]);
  assert.deepEqual(after.merged, { from: "theirs", files: ["target-only.txt"] });
  assert.equal(after.coverage.percent, 50);
  assert.ok((await manager.merge(run.id, { branch, into: "older" })).ok);
  assert.equal(sh(dir, "show", "older:target-only.txt"), "only on theirs");
  const retry = await manager.merge(run.id, { branch, into: "theirs" });
  assert.ok(retry.ok, "merges cleanly once resolved");
});

test("after resolving with a target that doesn't hold the run's base, the review keeps the target's changes labelled", async () => {
  const dir = newRepo();
  sh(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "feature-only.txt"), "only on feature\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feature");
  sh(dir, "checkout", "-q", "main");
  const manager = new RunManager(findPattern);
  const { run, branch, wt } = await conflictingRun(manager, dir, { baseRef: "feature" });
  assert.equal((await resolve(manager, run, wt.name)).status, "done");
  assert.deepEqual(labels(await manager.diff(run.id, branch)), ["shared.txt", "target-only.txt (from theirs)"], "not feature-only.txt: the run started with it");
  merge(dir, "feature", "theirs");
  assert.deepEqual(labels(await manager.diff(run.id, branch)), ["shared.txt", "target-only.txt (from theirs)"]);
  assert.deepEqual((await manager.reviewCoverage(run.id, branch)).files, ["shared.txt", "target-only.txt"]);
});

test("a solo run's working files: a brought-in file it edits again is its own change", async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, task: "Edit shared.txt CONFLICT", repo: dir, roles: { agent: ["claude"] }, options: {} }));
  assert.equal(run.status, "done", run.error);
  const wt = run.worktrees[0]!;
  sh(dir, "checkout", "-q", "-b", "theirs", "main");
  writeFileSync(join(dir, "shared.txt"), "their version\n");
  writeFileSync(join(dir, "target-only.txt"), "only on theirs\n");
  writeFileSync(join(dir, "also-theirs.txt"), "also only on theirs\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "theirs");
  sh(dir, "checkout", "-q", "main");
  const f = await resolve(manager, run, wt.name);
  assert.equal(f.status, "done", f.result);
  writeFileSync(join(wt.path, "target-only.txt"), "edited by the run\n");
  writeFileSync(join(wt.path, "new.txt"), "new\n");
  assert.deepEqual(labels(await manager.diff(run.id, wt.branch)), ["new.txt", "shared.txt", "target-only.txt", "also-theirs.txt (from theirs)"]);
});

test("a result with conflict markers committed in it is never merged; a Markdown heading underline isn't one", async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, checkpointOnFinish: true, task: "Edit shared.txt CONFLICT", repo: dir, roles: { agent: ["claude"] }, options: {} }));
  const branch = run.artifacts[0]!.branch;
  const wt = run.worktrees[0]!;
  writeFileSync(join(wt.path, "notes.md"), "Install\n=======\n\nRun it.\n");
  sh(wt.path, "add", "-A");
  sh(wt.path, "commit", "-qm", "a heading");
  assert.deepEqual(await addedConflictMarkers(dir, "main", branch), [], "a lone ======= line is a heading");
  writeFileSync(join(wt.path, "shared.txt"), "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
  sh(wt.path, "commit", "-qam", "half a merge");
  const main = sh(dir, "rev-parse", "main");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), new RegExp(`${branch} still has conflict markers in shared\\.txt`));
  await assert.rejects(manager.merge(run.id, { branch, into: "no-such-branch" }), /Branch "no-such-branch" doesn't exist/);
  assert.equal(sh(dir, "rev-parse", "main"), main, "main didn't move");
  assert.equal(run.merges.length, 0);
});

test("a resolver that leaves conflict-marker-size markers in commits nothing", async () => {
  // git writes 10-character markers here, which a 7-character match never saw.
  const dir = newRepo({ ".gitattributes": "shared.txt conflict-marker-size=10\n" });
  const manager = new RunManager(findPattern);
  const { run, branch, wt } = await conflictingRun(manager, dir);
  const head = sh(dir, "rev-parse", branch);
  let seen = "";
  const f = await withClaude(async (opts) => { seen = readFileSync(join(opts.cwd, "shared.txt"), "utf8"); execFileSync("git", ["add", "-A"], { cwd: opts.cwd }); return { ok: true, finalText: "Resolved.", sessionId: "s" }; }, () => resolve(manager, run, wt.name));
  assert.match(seen, /^<{10} /m, "git wrote longer markers");
  assert.equal(f.status, "failed");
  assert.match(f.result ?? "", /Conflict markers remain in shared\.txt/);
  assert.equal(sh(dir, "rev-parse", branch), head, "nothing was committed");
});

/** A finished solo run in `dir`, its result branch and worktree, and a way to commit to it. */
async function finishedRun(manager: Manager, dir: string) {
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, checkpointOnFinish: true, task: "Edit shared.txt CONFLICT", repo: dir, roles: { agent: ["claude"] }, options: {} }));
  assert.equal(run.status, "done", run.error);
  const wt = run.worktrees[0]!;
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(wt.path, path, ".."), { recursive: true });
      writeFileSync(join(wt.path, path), body);
    }
    sh(wt.path, "add", "-A");
    sh(wt.path, "commit", "-qm", message);
  };
  return { run, branch: run.artifacts[0]!.branch, commit };
}

test("conflict markers count by each file's conflict-marker-size, and ones that belong there merge once you say so", async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const { run, branch, commit } = await finishedRun(manager, dir);
  const example = "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> theirs\n";
  // Files whose own conflicts get 32-character markers can hold git's usual 7 as content.
  commit({ ".gitattributes": "fixtures/** conflict-marker-size=32\n", "fixtures/conflict.txt": example }, "a fixture");
  assert.deepEqual(await addedConflictMarkers(dir, "main", branch), []);
  commit({ "fixtures/real.txt": `${"<".repeat(32)} HEAD\nmine\n${"=".repeat(32)}\ntheirs\n${">".repeat(32)} theirs\n` }, "a real conflict there");
  assert.deepEqual(await addedConflictMarkers(dir, "main", branch), ["fixtures/real.txt"]);

  // A documented example without the attribute: refused, and merged when you confirm.
  commit({ "docs/merging.md": `Git shows a conflict like this:\n\n\`\`\`\n${example}\`\`\`\n` }, "docs");
  const main = sh(dir, "rev-parse", "main");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), (error: Error) => {
    assert.ok(error instanceof ConflictMarkersError);
    assert.deepEqual(error.files, ["docs/merging.md", "fixtures/real.txt"]);
    assert.match(error.message, new RegExp(`^${branch} still has conflict markers in docs/merging\\.md, fixtures/real\\.txt\\. .*you can merge anyway\\.$`));
    return true;
  });
  assert.equal(sh(dir, "rev-parse", "main"), main, "main didn't move");
  const outcome = await manager.merge(run.id, { branch, into: "main", allowConflictMarkers: true });
  assert.ok(outcome.ok);
  assert.match(sh(dir, "show", "main:docs/merging.md"), /^<{7} HEAD$/m);
  assert.equal(run.merges.length, 1);
});

test("a result whose text diff is bigger than git() reads still merges", { timeout: 180_000 }, async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const { run, branch, commit } = await finishedRun(manager, dir);
  // 70 MB of text: its -U0 patch alone is more than the 64 MB git() reads.
  commit({ "big.txt": `${"x".repeat(69)}\n`.repeat(1_000_000) }, "a big file");
  assert.deepEqual(await addedConflictMarkers(dir, "main", branch), []);
  assert.ok((await manager.merge(run.id, { branch, into: "main" })).ok);
  sh(dir, "merge-base", "--is-ancestor", branch, "main");
  assert.equal(sh(dir, "cat-file", "-s", "main:big.txt"), "70000000");
});

test("result branches with a custom prefix are runs' branches, and merging into another run's result is refused", async () => {
  const dir = newRepo();
  const manager = new RunManager(findPattern);
  const start = (extra: Record<string, unknown> = {}) => manager.start({ pattern: findPattern("solo")!, checkpointOnFinish: true, task: "Write something", repo: dir, roles: { agent: ["claude"] }, options: {}, ...extra });
  const custom = await idle(manager, await start({ branchPrefix: "qa-x" }));
  const other = await idle(manager, await start());
  const customBranch = custom.artifacts[0]!.branch;
  assert.equal(customBranch, "qa-x/solo");

  const { branches } = await listBranches(custom.repo, manager.resultBranches(custom.repo));
  const kind = (name: string) => branches.find((b) => b.name === name)?.kind;
  assert.equal(kind("qa-x/solo"), "run");
  assert.equal(kind(other.artifacts[0]!.branch), "run");
  assert.equal(kind("main"), "local");

  const before = sh(dir, "rev-parse", customBranch);
  await assert.rejects(manager.merge(other.id, { branch: other.artifacts[0]!.branch, into: customBranch }), new RegExp(`"qa-x/solo" is the result of another run \\(${custom.id}\\)`));
  assert.equal(sh(dir, "rev-parse", customBranch), before, "the other run's result is unchanged");
  assert.ok((await manager.merge(other.id, { branch: other.artifacts[0]!.branch, into: "main" })).ok, "your own branches still take it");
});

for (const kind of ["binary", "modify-delete"] as const) {
  test(`an untouched ${kind} conflict is refused, but explicitly staged resolution succeeds`, async () => {
    const dir = newRepo({ "asset.bin": "base\0content\n" });
    const manager = new RunManager(findPattern);
    const { run, branch, commit } = await finishedRun(manager, dir);
    const wt = run.worktrees[0]!;
    const path = kind === "binary" ? "asset.bin" : "shared.txt";
    if (kind === "binary") commit({ "asset.bin": "ours\0content\n" }, "change binary");
    sh(dir, "checkout", "-q", "-b", "theirs", "main");
    if (kind === "binary") {
      writeFileSync(join(dir, path), "theirs\0content\n");
      sh(dir, "add", path);
    } else sh(dir, "rm", "-q", path);
    sh(dir, "commit", "-qm", "target conflict");
    sh(dir, "checkout", "-q", "main");
    const head = sh(dir, "rev-parse", branch);
    const failed = await withClaude(async () => ({ ok: true, finalText: "Done", sessionId: "noop" }), () => resolve(manager, run, wt.name));
    assert.equal(failed.status, "failed");
    assert.match(failed.result ?? "", /Unresolved files remain in the index/);
    assert.equal(failed.commit, undefined);
    assert.equal(sh(dir, "rev-parse", branch), head);
    assert.equal(sh(wt.path, "status", "--porcelain"), "");
    const resolved = await withClaude(async opts => {
      if (kind === "binary") {
        writeFileSync(join(opts.cwd, path), "resolved\0content\n");
        sh(opts.cwd, "add", path);
      } else sh(opts.cwd, "rm", "-q", path);
      return { ok: true, finalText: "Resolved and staged", sessionId: "resolved" };
    }, () => resolve(manager, run, wt.name));
    assert.equal(resolved.status, "done", resolved.result);
    assert.ok(resolved.commit);
    assert.equal(sh(wt.path, "ls-files", "-u"), "");
  });
}

test("custom conflict markers shorter than seven characters are checked", async () => {
  const dir = newRepo({ ".gitattributes": "short.txt conflict-marker-size=3\n" });
  sh(dir, "checkout", "-q", "-b", "result");
  writeFileSync(join(dir, "short.txt"), "<<< HEAD\nours\n===\ntheirs\n>>> theirs\n");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "short markers");
  assert.deepEqual(await addedConflictMarkers(dir, "main", "result"), ["short.txt"]);
});
