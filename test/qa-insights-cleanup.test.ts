// Insights' Clean up (RunManager.cleanUp) removes a run's worktrees only where its branches hold
// everything: uncommitted or untracked files, locked worktrees, hidden tracked changes, a chat
// workspace other tabs share, and a run that's working are kept. What it does remove, it tidies
// the way Archive… does, and it says it archived the run. Agents are in-test stubs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-qa-cleanup-home-"));
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { removeWorktrees, unsavedWork } = await import("../src/ship.js");
type Run = import("../src/engine.js").Run;
type Pattern = import("../src/engine.js").Pattern;
type Manager = InstanceType<typeof RunManager>;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
const oneTurn: Pattern = {
  id: "one-turn",
  name: "One turn",
  summary: "",
  description: "",
  roles: [{ id: "agent", label: "Agent", description: "", default: ["claude"] }],
  options: [],
  async run(ctx) {
    const wt = await ctx.worktree("work");
    await ctx.ask({ title: "Work", role: "agent", agent: ctx.agent("agent"), mode: "write", cwd: wt, prompt: ctx.task });
    await ctx.commit(wt, "work");
    return "Done.";
  },
};
const patterns = (id: string) => (id === oneTurn.id ? oneTurn : findPattern(id));
const original = { claude: adapters.claude.run, codex: adapters.codex.run };
let release: () => void = () => {};
let repo: string;
let manager: Manager;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-qa-cleanup-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "Fixture\n");
  sh(repo, "add", ".");
  sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // Nothing the agents write: each worktree is exactly its branch until a test changes it.
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stub = async (opts: { prompt: string }) => {
    if (opts.prompt.includes("HOLD")) {
      const alive = setInterval(() => {}, 1000);
      await gate.finally(() => clearInterval(alive));
    }
    return { ok: true, finalText: "Done." };
  };
  adapters.claude.run = stub as typeof adapters.claude.run;
  adapters.codex.run = stub as typeof adapters.codex.run;
  manager = new RunManager(patterns);
});
after(() => {
  release();
  adapters.claude.run = original.claude;
  adapters.codex.run = original.codex;
});

async function idle(run: Run): Promise<Run> {
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.status, "done", run.error);
  return run;
}
const finished = async (task: string) => idle(await manager.start({ pattern: oneTurn, task, repo, roles: { agent: ["claude"] }, options: {} }));
const logs = async (run: Run) => (await manager.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const registered = () => sh(repo, "worktree", "list", "--porcelain");

test("worktrees holding uncommitted, untracked, hidden or locked work are kept, with the reason, and their runs stay unarchived", async () => {
  const untracked = await finished("Untracked notes");
  writeFileSync(join(untracked.worktrees[0]!.path, "notes.txt"), "Not committed anywhere\n");
  const modified = await finished("Edited README");
  appendFileSync(join(modified.worktrees[0]!.path, "README.md"), "A user edit\n");
  const locked = await finished("Locked worktree");
  sh(repo, "worktree", "lock", "--reason", "keep: debugging", locked.worktrees[0]!.path);
  const hidden = await finished("Assume-unchanged edit");
  sh(hidden.worktrees[0]!.path, "update-index", "--assume-unchanged", "README.md");
  appendFileSync(join(hidden.worktrees[0]!.path, "README.md"), "Hidden from git status\n");

  const expected: [Run, RegExp][] = [[untracked, /work has uncommitted changes/], [modified, /work has uncommitted changes/], [locked, /work is locked/], [hidden, /work has files git is told not to check/]];
  for (const [run, reason] of expected) {
    const result = await manager.cleanUp(run.id);
    assert.match(result.kept ?? "", reason, run.task);
    assert.deepEqual(result.removed, []);
    assert.equal(result.archived, false);
    assert.equal(run.archived, false, `${run.task} stays where you left it`);
    assert.ok(existsSync(run.worktrees[0]!.path), `${run.task}: worktree kept`);
  }
  assert.equal(readFileSync(join(untracked.worktrees[0]!.path, "notes.txt"), "utf8"), "Not committed anywhere\n");
  assert.match(readFileSync(join(modified.worktrees[0]!.path, "README.md"), "utf8"), /A user edit/);
  assert.match(registered(), /locked keep: debugging/, "the lock is still there");

  // Once the work is committed (or the lock lifted), the same run is cleaned.
  sh(repo, "worktree", "unlock", locked.worktrees[0]!.path);
  const result = await manager.cleanUp(locked.id);
  assert.equal(result.kept, undefined);
  assert.deepEqual(result.removed, [locked.worktrees[0]!.path]);
  assert.equal(locked.archived, true);
});

test("a clean run loses its worktree and folder, keeps its branch, is archived, and its log says so", async () => {
  const run = await finished("Clean result");
  const tree = run.worktrees[0]!;
  // A scratch checkout an interrupted proof left behind: a full checkout too.
  sh(repo, "worktree", "add", "-q", "--detach", join(run.worktreeDir, ".repro-check"), run.baseRef);
  const result = await manager.cleanUp(run.id);
  assert.deepEqual(result, { removed: [tree.path], archived: true, folder: true, failed: [] });
  assert.ok(!existsSync(run.worktreeDir), "the run's folder is tidied as Archive… tidies it");
  assert.ok(!registered().includes(".repro-check"), "the scratch checkout is unregistered too");
  assert.equal(sh(repo, "branch", "--list", tree.branch).replace("*", "").trim(), tree.branch, "the branch is kept");
  assert.equal(run.archived, true);
  assert.match(await logs(run), /Cleaned up: removed 1 worktree\(s\) and archived the run; branches kept; removed the run's folder/);

  // Cleaned before this fix (worktrees gone, folder left): a later Clean up tidies it.
  const earlier = await finished("Cleaned by an older version");
  await manager.archive(earlier.id, { cleanup: false });
  await removeWorktrees(repo, earlier.worktrees, false);
  sh(repo, "worktree", "add", "-q", "--detach", join(earlier.worktreeDir, ".base-check"), earlier.baseRef);
  const tidied = await manager.cleanUp(earlier.id);
  assert.deepEqual(tidied, { removed: [], archived: false, folder: true, failed: [] });
  assert.ok(!existsSync(earlier.worktreeDir));

  // An unarchived run whose worktrees are gone is none of Clean up's business.
  const gone = await finished("Worktree removed by hand");
  await removeWorktrees(repo, gone.worktrees, false);
  assert.deepEqual(await manager.cleanUp(gone.id), { removed: [], archived: false, folder: false, failed: [] });
  assert.equal(gone.archived, false);
});

test("chats sharing a workspace keep it, whichever of them Clean up reaches first", async () => {
  const source = await idle(await manager.start({ pattern: findPattern("solo")!, repo, task: "Owner chat", roles: { agent: ["codex"] }, options: {}, trust: "standard" }));
  const tab = await idle(await manager.startProviderChat(source.id, { agent: "claude", message: "Second tab" }));
  const tree = source.worktrees[0]!;
  assert.equal(tab.worktrees[0]!.path, tree.path, "the tab works in the owner's worktree");
  writeFileSync(join(tree.path, "unsaved.txt"), "Do not lose this");
  for (const run of [tab, source]) {
    const result = await manager.cleanUp(run.id);
    assert.match(result.kept ?? "", /shared with other chats/);
    assert.equal(run.archived, false);
  }
  // Even with nothing uncommitted: the other tab still works there.
  rmSync(join(tree.path, "unsaved.txt"));
  assert.match((await manager.cleanUp(tab.id)).kept ?? "", /shared with other chats/);
  assert.match((await manager.cleanUp(source.id)).kept ?? "", /shared with other chats/);
  assert.ok(existsSync(join(tree.path, ".git")));
});

test("a run that's working is skipped instead of losing its worktree mid-turn", async () => {
  const run = await manager.start({ pattern: oneTurn, task: "HOLD while I write", repo, roles: { agent: ["claude"] }, options: {} });
  const deadline = Date.now() + 15000;
  while (!run.worktrees.some((w) => existsSync(w.path)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await manager.cleanUp(run.id);
  assert.equal(result.kept, "it's working");
  assert.ok(existsSync(run.worktrees[0]!.path));
  release();
  await idle(run);
  assert.equal(run.archived, false);
});

test("removeWorktrees with keepUnsaved leaves dirty and locked worktrees in place and says why", async () => {
  const dirty = await finished("Dirty for ship");
  writeFileSync(join(dirty.worktrees[0]!.path, "scratch.txt"), "mine\n");
  const locked = await finished("Locked for ship");
  sh(repo, "worktree", "lock", locked.worktrees[0]!.path);
  assert.equal(await unsavedWork(repo, dirty.worktrees[0]!.path), "has uncommitted changes");
  assert.equal(await unsavedWork(repo, locked.worktrees[0]!.path), "is locked");
  const result = await removeWorktrees(repo, [...dirty.worktrees, ...locked.worktrees], false, { keepUnsaved: true });
  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0]!, /has uncommitted changes/);
  assert.match(result.failed[1]!, /is locked/);
  assert.ok(existsSync(join(dirty.worktrees[0]!.path, "scratch.txt")));
  assert.ok(existsSync(locked.worktrees[0]!.path));
  sh(repo, "worktree", "unlock", locked.worktrees[0]!.path);
});

test("commits made on a detached HEAD that no branch holds keep the worktree; once a branch holds them it goes", async () => {
  const run = await finished("Detached work");
  const tree = run.worktrees[0]!;
  sh(tree.path, "checkout", "-q", "--detach");
  writeFileSync(join(tree.path, "detached-work.txt"), "On no branch\n");
  sh(tree.path, "add", "detached-work.txt");
  sh(tree.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "detached work");
  const head = sh(tree.path, "rev-parse", "HEAD");
  assert.equal(sh(tree.path, "status", "--porcelain"), "", "nothing uncommitted: only HEAD holds the commit");
  assert.equal(await unsavedWork(repo, tree.path), "has commits no branch holds (its HEAD is detached)");
  const result = await manager.cleanUp(run.id);
  assert.match(result.kept ?? "", /work has commits no branch holds/);
  assert.equal(run.archived, false);
  assert.ok(existsSync(join(tree.path, "detached-work.txt")));
  const kept = await removeWorktrees(repo, run.worktrees, false, { keepUnsaved: true });
  assert.deepEqual(kept.removed, [], "removal itself checks again");
  assert.match(kept.failed[0]!, /commits no branch holds/);

  // Detached where a branch already is: nothing to lose.
  const plain = await finished("Detached on its own commit");
  sh(plain.worktrees[0]!.path, "checkout", "-q", "--detach");
  assert.equal(await unsavedWork(repo, plain.worktrees[0]!.path), undefined);

  sh(repo, "branch", "saved-detached", head);
  const cleaned = await manager.cleanUp(run.id);
  assert.equal(cleaned.kept, undefined);
  assert.deepEqual(cleaned.removed, [tree.path]);
  assert.equal(sh(repo, "rev-parse", "saved-detached"), head, "the branch made for it still holds the work");
});

// An archived run kept on disk (RunColdStore) is in the run list without being in memory.
const settled = async () => {
  const deadline = Date.now() + 45000;
  while (manager.inspectStorage().pending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (manager.inspectStorage().pending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};
const onDisk = (id: string) => manager.list().find((r) => r.id === id)?.cold === true;
const coldNow = async (run: Run) => {
  const deadline = Date.now() + 45000;
  while (!onDisk(run.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(onDisk(run.id), `${run.task} is kept on disk once archived`);
};

test("archived runs Clean up has nothing to do for stay on disk instead of being loaded into memory", async () => {
  const gone = await finished("Archived with its worktrees removed");
  await manager.archive(gone.id, { cleanup: true });
  const unsaved = await finished("Archived with unsaved work in its worktree");
  writeFileSync(join(unsaved.worktrees[0]!.path, "notes.txt"), "Only here\n");
  await manager.archive(unsaved.id, { cleanup: false });
  const scratch = await finished("Archived with a scratch checkout left");
  await manager.archive(scratch.id, { cleanup: true });
  await coldNow(gone); await coldNow(unsaved); await coldNow(scratch);
  // Left by an interrupted proof after archiving: something for Clean up to tidy.
  sh(repo, "worktree", "add", "-q", "--detach", join(scratch.worktreeDir, ".repro-check"), scratch.baseRef);
  await settled();

  const before = manager.inspectStorage();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await manager.cleanUp(gone.id), { removed: [], archived: false, folder: false, failed: [] });
    assert.match((await manager.cleanUp(unsaved.id)).kept ?? "", /uncommitted changes/);
  }
  await settled();
  const after = manager.inspectStorage();
  assert.equal(after.hot, before.hot, "no run was loaded into memory");
  assert.equal(after.cold.records, before.cold.records);
  assert.ok(onDisk(gone.id) && onDisk(unsaved.id));
  assert.ok(existsSync(join(unsaved.worktrees[0]!.path, "notes.txt")));

  // The one it tidies is loaded to record that, then goes back on disk.
  assert.deepEqual(await manager.cleanUp(scratch.id), { removed: [], archived: false, folder: true, failed: [] });
  assert.ok(!existsSync(scratch.worktreeDir));
  await coldNow(scratch);
  await settled();
  assert.equal(manager.inspectStorage().hot, before.hot);
  assert.match(await logs(scratch), /Cleaned up: removed the run's folder/);
});
