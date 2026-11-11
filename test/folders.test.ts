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

test("a run on a folder works in the mirror's worktree from a fresh import, and can't be merged back yet", async () => {
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
  await assert.rejects(manager.merge(run.id, { branch: run.worktrees[0]!.branch, into: "main" }), /copy of a folder/);
});
