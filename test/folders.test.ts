import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-folders-home-"));

const { checkFolder, ensureFolderMirror, findFolderMirror, folderOfMirror, importFolder, isFolderMirror, mirrorFor, openFolder, foldersRoot } = await import("../src/folders.js");
const { Projects } = await import("../src/projects.js");
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let root: string;
before(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-folders-"))); });

function folder(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tracked = (mirror: string) => execFileSync("git", ["ls-files"], { cwd: mirror }).toString().trim().split("\n").filter(Boolean).sort();
const commits = (mirror: string) => Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: mirror }).toString().trim());

test("only project folders are allowed: not too broad, not system, not Code Flow's own data, not part of a repository", async () => {
  await assert.rejects(checkFolder("relative/path"), /absolute path/);
  await assert.rejects(checkFolder(join(root, "missing")), /doesn't exist/);
  await assert.rejects(checkFolder("/"), /too broad/);
  await assert.rejects(checkFolder(dirname(realpathSync(homedir()))), /too broad/, "a first-level folder such as /Users");
  await assert.rejects(checkFolder(homedir()), /home folder/);
  await assert.rejects(checkFolder("/usr/bin"), /system folder/);
  await assert.rejects(checkFolder(process.env.CODEFLOW_HOME!), /Code Flow's own data/);
  // A folder that holds CODEFLOW_HOME would copy its tokens into the mirror.
  await assert.rejects(checkFolder(dirname(process.env.CODEFLOW_HOME!)), /Code Flow's own data/);
  const repo = folder("repo", { "a.txt": "a" });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "sub"));
  await assert.rejects(checkFolder(join(repo, "sub")), /part of the Git repository/);
  assert.equal(await checkFolder(folder("plain")), join(root, "plain"));
  const file = join(root, "a-file");
  writeFileSync(file, "x");
  await assert.rejects(checkFolder(file), /isn't a folder/);
});

test("a folder's first import copies what agents need into a private mirror and writes nothing into the folder", async () => {
  const dir = folder("docs", {
    "notes.md": "# notes\n",
    "src/run.sh": "echo hi\n",
    ".gitignore": "*.log\nbuild/\n",
    "debug.log": "noise",
    "build/out.bin": "binary",
    "node_modules/pkg/index.js": "x",
    ".DS_Store": "x",
    "nested/.git/HEAD": "ref: refs/heads/main\n",
    "nested/inner.txt": "inside another repository",
    "sub/.gitignore": "secret.txt\n",
    "sub/secret.txt": "hidden",
    "sub/kept.txt": "kept",
    "big.dat": "x".repeat(4096),
  });
  execFileSync("chmod", ["+x", join(dir, "src/run.sh")]);
  symlinkSync("notes.md", join(dir, "link-inside"));
  symlinkSync("../outside.txt", join(dir, "link-outside"));
  symlinkSync("/etc/hosts", join(dir, "link-absolute"));
  process.env.CODEFLOW_FOLDER_MAX_FILE_MB = String(2048 / 1024 / 1024);
  try {
    const first = await openFolder(dir);
    assert.equal(first.folder, dir);
    assert.equal(first.mirror, mirrorFor(dir));
    assert.ok(first.mirror.startsWith(foldersRoot()));
    assert.ok(isFolderMirror(first.mirror));
    assert.equal(folderOfMirror(first.mirror), dir);
    assert.equal(first.changed, true);
    assert.deepEqual(tracked(first.mirror), [".gitignore", "link-inside", "notes.md", "src/run.sh", "sub/.gitignore", "sub/kept.txt"]);
    assert.deepEqual(first.skipped.map((s) => [s.path, s.reason]).sort(), [["big.dat", "too-large"], ["link-absolute", "outside-link"], ["link-outside", "outside-link"], ["nested", "repository"]]);
    assert.equal(readlinkSync(join(first.mirror, "link-inside")), "notes.md");
    assert.match(execFileSync("git", ["ls-files", "-s", "src/run.sh"], { cwd: first.mirror }).toString(), /^100755/, "the executable bit is kept");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: first.mirror }).toString().trim(), "main");
    assert.equal(existsSync(join(dir, ".git")), false, "the folder gets no .git");
    assert.equal(execFileSync("git", ["log", "-1", "--format=%an %s"], { cwd: first.mirror }).toString().trim(), "Code Flow Folder snapshot");
  } finally { delete process.env.CODEFLOW_FOLDER_MAX_FILE_MB; }
});

test("later imports copy only what changed, record removals, and make no commit when nothing changed", async () => {
  const dir = folder("incremental", { "a.txt": "one", "b.txt": "two", "keep/c.txt": "three" });
  const mirror = (await openFolder(dir)).mirror;
  assert.equal(commits(mirror), 1);
  const same = await importFolder(mirror);
  assert.equal(same.changed, false);
  assert.equal(commits(mirror), 1);

  writeFileSync(join(dir, "a.txt"), "one, edited");
  unlinkSync(join(dir, "b.txt"));
  writeFileSync(join(dir, "d.txt"), "four");
  rmSync(join(dir, "keep"), { recursive: true });
  writeFileSync(join(dir, "keep"), "a file where a folder was");
  const next = await importFolder(mirror);
  assert.equal(next.changed, true);
  assert.equal(commits(mirror), 2);
  assert.deepEqual(tracked(mirror), ["a.txt", "d.txt", "keep"]);
  assert.equal(readFileSync(join(mirror, "a.txt"), "utf8"), "one, edited");
  assert.equal(readFileSync(join(mirror, "keep"), "utf8"), "a file where a folder was");

  // A path inside the folder finds the same mirror; a new .gitignore drops what it ignores.
  mkdirSync(join(dir, "deep"));
  assert.equal(await findFolderMirror(join(dir, "deep")), mirror);
  assert.equal(await ensureFolderMirror(join(dir, "deep")), mirror);
  writeFileSync(join(dir, ".gitignore"), "d.txt\n");
  await importFolder(mirror);
  assert.deepEqual(tracked(mirror), [".gitignore", "a.txt", "keep"]);
  // Code Flow's own folders in the mirror are never treated as the folder's files.
  mkdirSync(join(mirror, ".worktrees", "run-1"), { recursive: true });
  writeFileSync(join(mirror, ".worktrees", "run-1", "x"), "agent work");
  assert.equal((await importFolder(mirror)).changed, false);
  assert.equal(existsSync(join(mirror, ".worktrees", "run-1", "x")), true);
});

test("a decomposed Unicode name is copied as the folder spells it and stays put across imports", async () => {
  const decomposed = "Re\u0301sume\u0301.md";
  const dir = folder("unicode", { [decomposed]: "one" });
  const mirror = (await openFolder(dir)).mirror;
  assert.deepEqual(execFileSync("git", ["ls-files", "-z"], { cwd: mirror }).toString().split("\0").filter(Boolean), [decomposed]);
  assert.equal((await importFolder(mirror)).changed, false, "nothing is removed and copied again");
  assert.equal(commits(mirror), 1);
});

test("a folder over the limits is refused with its largest parts named, leaving no mirror behind", async () => {
  const dir = folder("too-many", { "a/1": "1", "a/2": "2", "a/3": "3", "b": "b" });
  process.env.CODEFLOW_FOLDER_MAX_FILES = "3";
  try {
    await assert.rejects(openFolder(dir), /bigger than Code Flow copies \(at most 3 files.*a\/ 3 files/);
    assert.equal(existsSync(dirname(mirrorFor(dir))), false);
  } finally { delete process.env.CODEFLOW_FOLDER_MAX_FILES; }
  // A folder that disappears can't be imported, and says so.
  const gone = folder("gone", { "x": "x" });
  const mirror = (await openFolder(gone)).mirror;
  rmSync(gone, { recursive: true });
  await assert.rejects(importFolder(mirror), /no longer exists/);
});

test("a project takes a folder as its mirror, named after the folder, and lists the folder it copies", async () => {
  const projects = new Projects(join(mkdtempSync(join(tmpdir(), "codeflow-folders-projects-")), "projects.json"));
  await projects.load();
  const dir = folder("Thesis", { "chapter1.md": "intro" });
  const project = await projects.create({ name: "Writing", repos: [dir] });
  const mirror = mirrorFor(dir);
  assert.deepEqual(project.repos, [mirror]);
  assert.deepEqual(project.folders, [{ mirror, path: dir }]);
  assert.equal(JSON.parse(readFileSync((projects as any).file, "utf8"))[0].folders, undefined, "the folder list isn't saved: the mirror records it");
  const placed = await new Projects(join(mkdtempSync(join(tmpdir(), "codeflow-folders-projects-")), "projects.json"));
  await placed.load();
  assert.equal((await placed.place(mirror)).project.name, "Thesis", "a new project for a folder is named after the folder");
  await assert.rejects(projects.create({ name: "Too broad", repos: [homedir()] }), /home folder/);
});

function finished(m: Manager, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && run.endedAt !== undefined && resolve(run);
    m.subscribe(run.id, check);
    check();
  });
}

test("a run on a folder works in the mirror's worktree from a fresh import", async () => {
  const dir = folder("run-folder", { "plan.md": "first" });
  await ensureFolderMirror(dir);
  writeFileSync(join(dir, "plan.md"), "edited before the run");
  const manager = new RunManager(findPattern);
  const roles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
  const run = await finished(manager, await manager.start({ pattern: findPattern("pipeline")!, task: "Read the plan", repo: dir, roles, options: {} }));
  const mirror = mirrorFor(dir);
  assert.equal(run.repo, mirror, "the run records the mirror as its repository");
  assert.ok(run.worktrees.length > 0);
  assert.ok(run.worktrees.every((w) => w.path.startsWith(mirror)), "worktrees live in the mirror, not the folder");
  assert.equal(execFileSync("git", ["show", `${run.worktrees[0]!.branch}:plan.md`], { cwd: mirror }).toString(), "edited before the run", "the run starts from the folder as it was at the start");
  assert.equal(readFileSync(join(dir, "plan.md"), "utf8"), "edited before the run", "the folder is untouched");
});

// ---- Applying results to the folder (slice 2)

const { applyToFolder, undoFolderApply, folderApplies } = await import("../src/folders.js");

/** A result branch in the mirror, made the way an agent's worktree would: from main, with `edit` applied, committed. */
function resultBranch(mirror: string, name: string, edit: (dir: string) => void): string {
  const wt = mkdtempSync(join(tmpdir(), "codeflow-folders-wt-"));
  rmSync(wt, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: mirror });
  g("worktree", "add", "-q", "-b", name, wt, "main");
  edit(wt);
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "result"], { cwd: wt });
  g("worktree", "remove", "--force", wt);
  return name;
}

test("applying a result writes its changes into the folder, moves deletions aside, and an apply can be undone", async () => {
  const dir = folder("apply", { "keep.md": "keep", "edit.md": "before", "gone.md": "delete me", "tool.sh": "echo" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-1", (wt) => {
    writeFileSync(join(wt, "edit.md"), "after");
    rmSync(join(wt, "gone.md"));
    mkdirSync(join(wt, "new/deep"), { recursive: true });
    writeFileSync(join(wt, "new/deep/file.bin"), Buffer.from([0, 255, 1, 254]));
    execFileSync("chmod", ["+x", join(wt, "tool.sh")]);
    symlinkSync("keep.md", join(wt, "alias.md"));
  });
  // You keep working on another file while the run works: that's not a conflict.
  writeFileSync(join(dir, "keep.md"), "keep, edited by you");
  const applied = await applyToFolder(mirror, branch, { runId: "r-1" });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  if (!applied.ok) return;
  assert.deepEqual([...applied.written].sort(), ["alias.md", "edit.md", "new/deep/file.bin", "tool.sh"]);
  assert.deepEqual(applied.removed, ["gone.md"]);
  assert.equal(readFileSync(join(dir, "edit.md"), "utf8"), "after");
  assert.deepEqual([...readFileSync(join(dir, "new/deep/file.bin"))], [0, 255, 1, 254], "binary files byte for byte");
  assert.equal(readlinkSync(join(dir, "alias.md")), "keep.md");
  assert.ok((execFileSync("stat", ["-f", "%p", join(dir, "tool.sh")]).toString().trim().endsWith("755")), "the executable bit is applied");
  assert.equal(existsSync(join(dir, "gone.md")), false);
  assert.equal(readFileSync(join(dirname(mirror), "removed", applied.id, "gone.md"), "utf8"), "delete me", "a deleted file is moved aside");
  assert.equal(readFileSync(join(dir, "keep.md"), "utf8"), "keep, edited by you", "your own edit stays");
  assert.equal(existsSync(join(dir, ".git")), false);
  const parents = execFileSync("git", ["rev-list", "--parents", "-n1", "main"], { cwd: mirror }).toString().trim().split(" ");
  assert.equal(parents.length, 3, "the snapshot after an apply merges the result, so only newer work applies next time");
  await assert.rejects(applyToFolder(mirror, branch), /Nothing to apply/);
  assert.equal((await folderApplies(mirror))[0]!.runId, "r-1");

  const undone = await undoFolderApply(mirror, applied.id);
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(readFileSync(join(dir, "edit.md"), "utf8"), "before");
  assert.equal(readFileSync(join(dir, "gone.md"), "utf8"), "delete me");
  assert.equal(existsSync(join(dir, "new/deep/file.bin")), false);
  assert.equal(existsSync(join(dir, "alias.md")), false);
  assert.equal(readFileSync(join(dir, "keep.md"), "utf8"), "keep, edited by you", "undo leaves your own edits alone");
  await assert.rejects(undoFolderApply(mirror, applied.id), /already undone/);

  // An undone apply can be applied again, though main still has the result in its history.
  writeFileSync(join(dir, "edit.md"), "yours now");
  const blocked = await applyToFolder(mirror, branch);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) { assert.deepEqual(blocked.conflicts, ["edit.md"]); assert.equal(blocked.resolvable, false, "merging main wouldn't fix this one"); }
  assert.equal(existsSync(join(dir, "new/deep/file.bin")), false, "nothing written");
  writeFileSync(join(dir, "edit.md"), "before");
  const again = await applyToFolder(mirror, branch);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(readFileSync(join(dir, "edit.md"), "utf8"), "after");
  assert.equal(existsSync(join(dir, "gone.md")), false);
  await assert.rejects(applyToFolder(mirror, branch), /Nothing to apply/);
});

test("a file you changed during the run is a conflict, and nothing at all is written", async () => {
  const dir = folder("conflict", { "a.md": "a", "b.md": "b" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-c", (wt) => { writeFileSync(join(wt, "a.md"), "agent a"); writeFileSync(join(wt, "b.md"), "agent b"); writeFileSync(join(wt, "c.md"), "agent c"); });
  writeFileSync(join(dir, "b.md"), "yours");
  writeFileSync(join(dir, "c.md"), "also yours");
  const result = await applyToFolder(mirror, branch);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.conflicts.sort(), ["b.md", "c.md"]);
  assert.match(result.message, /Nothing was written/);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "a", "not even the file without a conflict");
  // The mirror's main now holds the folder as it is, so merging it into the result resolves the conflict.
  assert.equal(execFileSync("git", ["show", "main:b.md"], { cwd: mirror }).toString(), "yours");
  assert.deepEqual(await folderApplies(mirror), []);

  // An apply after you undo your edits goes through; undo after you edit an applied file is a conflict.
  writeFileSync(join(dir, "b.md"), "b");
  rmSync(join(dir, "c.md"));
  const applied = await applyToFolder(mirror, branch);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  writeFileSync(join(dir, "a.md"), "edited after the apply");
  const undo = await undoFolderApply(mirror, applied.id);
  assert.equal(undo.ok, false);
  if (!undo.ok) { assert.deepEqual(undo.conflicts, ["a.md"]); assert.match(undo.message, /since the apply, so it can't be undone/); }
  assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "agent b", "a refused undo writes nothing");
});

test("results that would write outside the folder or through a link are refused before anything is written", async () => {
  const dir = folder("unsafe", { "real/x.md": "x", "plain.md": "p" });
  const outside = folder("unsafe-outside");
  const mirror = (await openFolder(dir)).mirror;
  const escaping = resultBranch(mirror, "result-link", (wt) => { writeFileSync(join(wt, "plain.md"), "changed"); symlinkSync("../../unsafe-outside", join(wt, "out")); });
  await assert.rejects(applyToFolder(mirror, escaping), /won't write into the folder.*out/);
  assert.equal(readFileSync(join(dir, "plain.md"), "utf8"), "p");
  // A folder of yours replaced by a link after the run started: the result isn't written through it.
  const through = resultBranch(mirror, "result-through", (wt) => writeFileSync(join(wt, "real/x.md"), "agent"));
  rmSync(join(dir, "real"), { recursive: true });
  symlinkSync(outside, join(dir, "real"));
  writeFileSync(join(outside, "x.md"), "x");
  await assert.rejects(applyToFolder(mirror, through), /won't write into the folder.*real\/x\.md/);
  assert.equal(readFileSync(join(outside, "x.md"), "utf8"), "x");
});

test("a folder that was replaced since it was added gets nothing written into it", async () => {
  const dir = folder("replaced", { "a.md": "a" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-r", (wt) => writeFileSync(join(wt, "a.md"), "agent"));
  rmSync(dir, { recursive: true });
  folder("replaced", { "a.md": "a" });
  await assert.rejects(applyToFolder(mirror, branch), /was replaced/);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "a");
});

test("merging a folder run applies its result to the folder; pull requests stay refused; the apply can be undone", async () => {
  const dir = folder("run-apply", { "notes.md": "notes" });
  await ensureFolderMirror(dir); // the server makes a new folder's mirror; the engine uses one that exists
  const manager = new RunManager(findPattern);
  const roles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
  const run = await finished(manager, await manager.start({ pattern: findPattern("pipeline")!, task: "Write something", repo: dir, roles, options: {} }));
  const mirror = mirrorFor(dir);
  const tree = run.worktrees[0]!;
  // What the agents left, as a commit on the result branch (the fake agents may leave nothing).
  writeFileSync(join(tree.path, "agent.md"), "from the run");
  execFileSync("git", ["add", "-A"], { cwd: tree.path });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work"], { cwd: tree.path });
  await assert.rejects(manager.merge(run.id, { branch: tree.branch, into: "other" }), /applied to the folder/);
  await assert.rejects(manager.pullRequest(run.id, { branch: tree.branch, into: "main" }), /no branches or pull requests/);
  const outcome = await manager.merge(run.id, { branch: tree.branch, into: "main" });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(readFileSync(join(dir, "agent.md"), "utf8"), "from the run");
  const entry = manager.get(run.id)!.merges.at(-1)!;
  assert.ok(entry.folderApply);
  assert.equal((await manager.undoFolderApply(run.id, entry.folderApply!)).ok, true);
  assert.equal(existsSync(join(dir, "agent.md")), false);
  assert.ok(manager.get(run.id)!.merges.at(-1)!.undoneAt);
  assert.equal((await manager.merge(run.id, { branch: tree.branch, into: "main" })).ok, true, "an undone apply can be applied again");
  assert.equal(readFileSync(join(dir, "agent.md"), "utf8"), "from the run");
});

test("resolving a conflict the usual way (merging main into the result) lets the apply go through without undoing your edits", async () => {
  const dir = folder("resolve", { "shared.md": "base\n", "mine.md": "mine\n" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-x", (wt) => { writeFileSync(join(wt, "shared.md"), "agent\n"); writeFileSync(join(wt, "mine.md"), "agent too\n"); });
  writeFileSync(join(dir, "mine.md"), "edited by you\n");
  const first = await applyToFolder(mirror, branch);
  assert.equal(first.ok, false);
  // What the resolve-conflicts follow-up does: merge main into the result, keeping your side of mine.md.
  const wt = mkdtempSync(join(tmpdir(), "codeflow-folders-resolve-"));
  rmSync(wt, { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", wt, branch], { cwd: mirror });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-X", "theirs", "-m", "resolve", "main"], { cwd: wt });
  execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: mirror });
  const second = await applyToFolder(mirror, branch);
  assert.equal(second.ok, true, JSON.stringify(second));
  if (second.ok) assert.deepEqual(second.written, ["shared.md"], "only the result's own change is written");
  assert.equal(readFileSync(join(dir, "shared.md"), "utf8"), "agent\n");
  assert.equal(readFileSync(join(dir, "mine.md"), "utf8"), "edited by you\n");
});

test("a result that turns a file into a folder, or a folder into a file, applies and undoes; your own file in that folder is a conflict", async () => {
  const dir = folder("swap", { "foo": "a file", "bar/one.md": "1", "bar/sub/two.md": "2", "keep.md": "k" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-swap", (wt) => {
    rmSync(join(wt, "foo"));
    mkdirSync(join(wt, "foo"));
    writeFileSync(join(wt, "foo/inner.md"), "now a folder");
    rmSync(join(wt, "bar"), { recursive: true });
    writeFileSync(join(wt, "bar"), "now a file");
  });
  const applied = await applyToFolder(mirror, branch);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  if (!applied.ok) return;
  assert.equal(readFileSync(join(dir, "foo/inner.md"), "utf8"), "now a folder");
  assert.equal(readFileSync(join(dir, "bar"), "utf8"), "now a file");
  const undone = await undoFolderApply(mirror, applied.id);
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(readFileSync(join(dir, "foo"), "utf8"), "a file");
  assert.equal(readFileSync(join(dir, "bar/sub/two.md"), "utf8"), "2");

  // A file of yours inside the folder the result replaces with a file: nothing is written.
  writeFileSync(join(dir, "bar/yours.md"), "mine");
  const blocked = await applyToFolder(mirror, branch);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.deepEqual(blocked.conflicts, ["bar"]);
  assert.equal(readFileSync(join(dir, "foo"), "utf8"), "a file", "nothing written");
  assert.equal(readFileSync(join(dir, "bar/yours.md"), "utf8"), "mine");
});

test("an apply that can't be recorded (the folder is over a limit afterwards) puts the folder back and leaves no record", async () => {
  const dir = folder("unrecorded", { "a.md": "a", "b.md": "b" });
  const mirror = (await openFolder(dir)).mirror;
  const branch = resultBranch(mirror, "result-big", (wt) => { writeFileSync(join(wt, "a.md"), "changed"); writeFileSync(join(wt, "c.md"), "c"); writeFileSync(join(wt, "d.md"), "d"); rmSync(join(wt, "b.md")); });
  process.env.CODEFLOW_FOLDER_MAX_FILES = "2";
  try { await assert.rejects(applyToFolder(mirror, branch), /can't be applied.*put back as it was/s); }
  finally { delete process.env.CODEFLOW_FOLDER_MAX_FILES; }
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "a");
  assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "b");
  assert.equal(existsSync(join(dir, "c.md")), false);
  assert.deepEqual(await folderApplies(mirror), []);
  assert.equal((await applyToFolder(mirror, branch)).ok, true, "and it applies once the limit allows");
});

test("a mirror is a SHA-1 repository even when the environment asks git for SHA-256", async () => {
  const dir = folder("hash", { "a.md": "a" });
  process.env.GIT_DEFAULT_HASH = "sha256";
  let mirror: string;
  try { mirror = (await openFolder(dir)).mirror; } finally { delete process.env.GIT_DEFAULT_HASH; }
  assert.equal(execFileSync("git", ["rev-parse", "--show-object-format"], { cwd: mirror }).toString().trim(), "sha1");
});
