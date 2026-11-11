import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { CODEFLOW_HOME, envNumber, WORKTREE_DIR } from "./config.js";
import { CONTEXT_DIR, ensureCodeflowExcludes, git, gitError, repoRoot, withRepoLock, writeBlobFile } from "./git.js";

/**
 * Folder projects (docs/design/folder-projects.md): Code Flow works on a folder that isn't a Git
 * repository through a mirror, an ordinary repository of its own under CODEFLOW_HOME/folders whose
 * files are a copy of the folder. Runs use the mirror as they use any repository. This module is
 * the boundary: which folders are allowed, creating a mirror, and importing (folder → mirror).
 *
 * Import never runs git with the folder as its work tree and never follows a symbolic link in the
 * folder. Nothing here writes into the folder.
 */

export class FolderError extends Error {
  readonly status = 400;
}

export interface FolderMeta {
  version: 1;
  /** The folder, real path. */
  path: string;
  /** The folder's inode when it was added, to notice a folder that was replaced (checked before writing back). */
  inode: string;
  createdAt: number;
}

export interface SkippedPath {
  path: string;
  reason: "repository" | "too-large" | "outside-link" | "special";
}

export interface FolderImport {
  mirror: string;
  folder: string;
  /** The mirror's HEAD after the import. */
  commit: string;
  /** True when this import made a new snapshot commit. */
  changed: boolean;
  files: number;
  bytes: number;
  skipped: SkippedPath[];
}

/** Never copied, wherever they are in the folder. */
const SKIP_NAMES = new Set(["node_modules", "__pycache__", ".venv", ".DS_Store", "Thumbs.db", CONTEXT_DIR]);
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: "Code Flow", GIT_AUTHOR_EMAIL: "codeflow@localhost", GIT_COMMITTER_NAME: "Code Flow", GIT_COMMITTER_EMAIL: "codeflow@localhost" };

export function folderLimits() {
  return {
    files: envNumber("CODEFLOW_FOLDER_MAX_FILES", 20_000, { min: 1, integer: true }),
    bytes: envNumber("CODEFLOW_FOLDER_MAX_MB", 1024, { min: 1 }) * 1024 * 1024,
    fileBytes: envNumber("CODEFLOW_FOLDER_MAX_FILE_MB", 50, { min: 0.001 }) * 1024 * 1024,
  };
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Where mirrors live. Read each time: tests point CODEFLOW_HOME somewhere of their own. */
export function foldersRoot(): string {
  return join(real(CODEFLOW_HOME), "folders");
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function folderId(folder: string): string {
  return `f-${createHash("sha256").update(folder).digest("hex").slice(0, 16)}`;
}

/** The mirror a folder (real path) has, or would have. */
export function mirrorFor(folder: string): string {
  return join(foldersRoot(), folderId(folder), "source");
}

/** True for a mirror's own path (not for its worktrees, nor for anything else under CODEFLOW_HOME). */
export function isFolderMirror(repo: string): boolean {
  const path = resolve(repo);
  return [foldersRoot(), join(resolve(CODEFLOW_HOME), "folders")].some((root) => {
    const rel = relative(root, path);
    return /^f-[0-9a-f]{16}[\\/]source$/.test(rel);
  });
}

function metaFile(mirror: string): string {
  return join(dirname(mirror), "folder.json");
}

function manifestFile(mirror: string): string {
  return join(dirname(mirror), "manifest.json");
}

/** The folder a mirror copies, or undefined for anything that isn't a mirror. */
export function folderOfMirror(mirror: string): string | undefined {
  if (!isFolderMirror(mirror)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(metaFile(mirror), "utf8")) as Partial<FolderMeta>;
    return typeof meta.path === "string" ? meta.path : undefined;
  } catch { return undefined; }
}

async function readMeta(mirror: string): Promise<FolderMeta> {
  const text = await readFile(metaFile(mirror), "utf8").catch(() => { throw new FolderError(`${mirror} isn't a folder project's copy`); });
  const meta = JSON.parse(text) as FolderMeta;
  if (meta?.version !== 1 || typeof meta.path !== "string" || !isAbsolute(meta.path)) throw new FolderError(`The folder record for ${mirror} can't be read`);
  return meta;
}

/**
 * The folder (real path) if Code Flow may work on it, else a FolderError that says why. Refused:
 * the top of the disk and its first-level folders, the home folder, system folders, anything that
 * holds or sits in CODEFLOW_HOME (its tokens would be copied), and folders in a Git repository.
 */
export async function checkFolder(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new FolderError("Choose a folder by its absolute path");
  let folder: string;
  try { folder = await realpath(path); } catch { throw new FolderError(`${path} doesn't exist`); }
  if (!(await lstat(folder)).isDirectory()) throw new FolderError(`${path} isn't a folder`);
  const home = real(homedir());
  const temp = real(tmpdir());
  const codeflow = real(CODEFLOW_HOME);
  if (folder === dirname(folder) || dirname(folder) === dirname(dirname(folder))) throw new FolderError(`${folder} is too broad to work on. Choose a project folder inside it.`);
  if (folder === home) throw new FolderError("Your home folder is too broad to work on. Choose a project folder inside it.");
  if (within(folder, join(home, "Library"))) throw new FolderError(`${folder} is in your Library folder, which holds app data. Choose a project folder.`);
  const system = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/dev", "/Applications", "/opt", "/cores"];
  const allowed = [temp, "/private/tmp"];
  if (system.some((root) => within(folder, root)) && !allowed.some((root) => within(folder, root))) throw new FolderError(`${folder} is a system folder. Choose a project folder.`);
  if (within(folder, codeflow) || within(codeflow, folder)) throw new FolderError(`${folder} holds Code Flow's own data (${codeflow}). Choose another folder.`);
  const repo = await repoRoot(folder).catch(() => undefined);
  if (repo) throw new FolderError(`${folder} is part of the Git repository ${repo}. Add the repository instead.`);
  return folder;
}

/** The mirror of `path` or of the folder it is in, when Code Flow already has one. */
export async function findFolderMirror(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  let at: string;
  try { at = await realpath(path); } catch { return undefined; }
  for (;;) {
    const mirror = mirrorFor(at);
    if (existsSync(metaFile(mirror)) && folderOfMirror(mirror) === at) return mirror;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/**
 * The mirror for a folder Code Flow may work on. A new mirror gets its first import (so a folder
 * over the limits is refused here); an existing one is returned as it is. `path` can be the
 * mirror itself, the folder, or a folder inside it.
 */
export async function ensureFolderMirror(path: string): Promise<string> {
  if (isFolderMirror(path) && existsSync(metaFile(path))) return path;
  const existing = await findFolderMirror(path);
  if (existing) return existing;
  return (await createMirror(await checkFolder(path))).mirror;
}

/** ensureFolderMirror, then bring the mirror up to date with the folder. */
export async function openFolder(path: string): Promise<FolderImport> {
  if (isFolderMirror(path) && existsSync(metaFile(path))) return importFolder(path);
  const existing = await findFolderMirror(path);
  if (existing) return importFolder(existing);
  return createMirror(await checkFolder(path));
}

async function createMirror(folder: string): Promise<FolderImport> {
  const mirror = mirrorFor(folder);
  await withRepoLock(mirror, async () => {
    if (existsSync(metaFile(mirror))) return;
    await rm(dirname(mirror), { recursive: true, force: true });
    await mkdir(mirror, { recursive: true, mode: 0o700 });
    const ok = async (args: string[]) => { const res = await git(args, mirror); if (res.code !== 0) throw new Error(gitError(args, res)); };
    await ok(["init", "-q"]);
    await ok(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await ok(["config", "core.autocrlf", "false"]);
    await ok(["config", "core.safecrlf", "false"]);
    // Paths as the folder spells them: on macOS git would otherwise report a decomposed name
    // precomposed, and the import would never find it among the folder's own names.
    await ok(["config", "core.precomposeunicode", "false"]);
    await ensureCodeflowExcludes(mirror);
    const meta: FolderMeta = { version: 1, path: folder, inode: String((await lstat(folder, { bigint: true })).ino), createdAt: Date.now() };
    await writeAtomic(metaFile(mirror), JSON.stringify(meta, null, 2));
  });
  try {
    return await importFolder(mirror);
  } catch (err) {
    // A folder over the limits leaves nothing behind; the next try starts again.
    if (err instanceof FolderError && !(await git(["rev-parse", "--verify", "-q", "HEAD"], mirror)).stdout.trim()) await rm(dirname(mirror), { recursive: true, force: true });
    throw err;
  }
}

type Entry = { kind: "file"; size: number; mtimeMs: number; mode: number; ino: string } | { kind: "link"; target: string };
type Manifest = Record<string, [size: number, mtimeMs: number, mode: number, ino: string]>;

/**
 * Copy the folder's current files into its mirror and commit them as a snapshot when anything
 * changed. Skipped: SKIP_NAMES, the mirror's worktree folder name at the top, what the folder's own
 * `.gitignore` files ignore, nested repositories, files over the per-file limit, special files and
 * symbolic links that leave the folder (or are absolute: in a worktree they would still point into
 * your folder). A folder over the file or size limits is refused.
 */
export async function importFolder(mirror: string): Promise<FolderImport> {
  const meta = await readMeta(mirror);
  return withRepoLock(mirror, () => importLocked(mirror, meta.path));
}

/** importFolder, for a caller that already holds the mirror's lock. */
async function importLocked(mirror: string, folder: string): Promise<FolderImport> {
  {
    const info = await lstat(folder).catch(() => undefined);
    if (!info?.isDirectory()) throw new FolderError(`The folder ${folder} no longer exists. Locate it or remove it from the project.`);
    const limits = folderLimits();
    const kept = new Map<string, Entry>();
    const skipped: SkippedPath[] = [];
    const sizes = new Map<string, { files: number; bytes: number }>();
    let bytes = 0;
    let level = [""];
    while (level.length) {
      // A folder's own .gitignore must be in the mirror before its entries are checked against it.
      for (const dir of level) {
        const ignore = join(dir, ".gitignore");
        const st = await lstat(join(folder, ignore)).catch(() => undefined);
        if (st?.isFile()) await copyIn(folder, mirror, ignore, st.mode);
      }
      const children: { rel: string; dir: boolean }[] = [];
      for (const dir of level) {
        const entries = await readdir(join(folder, dir), { withFileTypes: true }).catch(() => []);
        if (dir && entries.some((e) => e.name === ".git")) { skipped.push({ path: dir, reason: "repository" }); continue; }
        for (const e of entries) {
          if (SKIP_NAMES.has(e.name) || e.name === ".git" || (!dir && e.name === WORKTREE_DIR)) continue;
          if (e.name.includes("\n") || e.name.includes("\0")) { skipped.push({ path: join(dir, e.name), reason: "special" }); continue; }
          children.push({ rel: dir ? `${dir}/${e.name}` : e.name, dir: e.isDirectory() });
        }
      }
      const ignored = await ignoredPaths(mirror, children.map((c) => (c.dir ? `${c.rel}/` : c.rel)));
      const next: string[] = [];
      for (const child of children) {
        if (ignored.has(child.dir ? `${child.rel}/` : child.rel)) continue;
        if (child.dir) { next.push(child.rel); continue; }
        const st = await lstat(join(folder, child.rel), { bigint: true }).catch(() => undefined);
        if (!st) continue;
        if (st.isSymbolicLink()) {
          const target = await readlink(join(folder, child.rel));
          const inside = !isAbsolute(target) && within(resolve(folder, dirname(child.rel), target), folder);
          if (inside) kept.set(child.rel, { kind: "link", target });
          else skipped.push({ path: child.rel, reason: "outside-link" });
          continue;
        }
        if (!st.isFile()) { skipped.push({ path: child.rel, reason: "special" }); continue; }
        const size = Number(st.size);
        if (size > limits.fileBytes) { skipped.push({ path: child.rel, reason: "too-large" }); continue; }
        kept.set(child.rel, { kind: "file", size, mtimeMs: Number(st.mtimeMs), mode: Number(st.mode), ino: String(st.ino) });
        bytes += size;
        const top = child.rel.includes("/") ? child.rel.slice(0, child.rel.indexOf("/")) : ".";
        const t = sizes.get(top) ?? { files: 0, bytes: 0 };
        t.files++; t.bytes += size; sizes.set(top, t);
        if (kept.size > limits.files || bytes > limits.bytes) throw overLimits(folder, limits, sizes);
      }
      level = next;
    }

    // Remove what the folder no longer has, then copy what changed.
    const listed = async (args: string[]) => {
      const res = await git(args, mirror);
      if (res.code !== 0) throw new Error(gitError(args, res));
      return res.stdout.split("\0").filter(Boolean);
    };
    const present = new Set([...(await listed(["ls-files", "-z"])), ...(await listed(["ls-files", "--others", "--exclude-standard", "-z"]))]);
    for (const path of present) if (!kept.has(path)) await rm(join(mirror, path), { recursive: true, force: true });
    const manifest = await readManifest(mirror);
    const next: Manifest = {};
    for (const [path, entry] of kept) {
      if (entry.kind === "link") {
        const current = await readlink(join(mirror, path)).catch(() => undefined);
        if (current !== entry.target) {
          await prepare(mirror, path);
          await symlink(entry.target, join(mirror, path));
        }
        continue;
      }
      const was = manifest[path];
      const same = was && was[0] === entry.size && was[1] === entry.mtimeMs && was[2] === entry.mode && was[3] === entry.ino && present.has(path);
      if (!same && !(await copyIn(folder, mirror, path, entry.mode))) continue;
      next[path] = [entry.size, entry.mtimeMs, entry.mode, entry.ino];
    }

    const commitEnv = { ...SNAPSHOT_IDENTITY };
    const add = await git(["add", "-A"], mirror);
    if (add.code !== 0) throw new Error(gitError(["add", "-A"], add));
    const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], mirror)).stdout.trim();
    const staged = (await git(["diff", "--cached", "--quiet"], mirror)).code !== 0;
    let changed = false;
    if (!head || staged) {
      const args = ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Folder snapshot"];
      const res = await git(args, mirror, { env: commitEnv });
      if (res.code !== 0) throw new Error(gitError(args, res));
      changed = true;
    }
    await writeAtomic(manifestFile(mirror), JSON.stringify({ version: 1, files: next }));
    const commit = (await git(["rev-parse", "HEAD"], mirror)).stdout.trim();
    return { mirror, folder, commit, changed, files: kept.size, bytes, skipped };
  }
}

function overLimits(folder: string, limits: ReturnType<typeof folderLimits>, sizes: Map<string, { files: number; bytes: number }>): FolderError {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  const largest = [...sizes].sort((a, b) => b[1].bytes - a[1].bytes || b[1].files - a[1].files).slice(0, 5)
    .map(([name, s]) => `${name === "." ? "(top level)" : `${name}/`} ${s.files} files, ${mb(s.bytes)}`).join("; ");
  return new FolderError(`${folder} is bigger than Code Flow copies (at most ${limits.files} files and ${mb(limits.bytes)}). Largest: ${largest}. Add a .gitignore for what agents don't need, or choose a smaller folder.`);
}

/** The paths git ignores in the mirror under the folder's own .gitignore files (and your global excludes). */
async function ignoredPaths(mirror: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const args = ["check-ignore", "--no-index", "-z", "--stdin"];
  const res = await git(args, mirror, { input: paths.join("\0") + "\0" });
  if (res.code > 1) throw new Error(gitError(args, res));
  return new Set(res.stdout.split("\0").filter(Boolean));
}

/** Make `path` in the mirror writable as a new entry: every parent a real folder, nothing at `path`. */
async function prepare(mirror: string, path: string): Promise<void> {
  let at = mirror;
  for (const part of dirname(path).split("/").filter((p) => p && p !== ".")) {
    at = join(at, part);
    const st = await lstat(at).catch(() => undefined);
    if (st && !st.isDirectory()) await rm(at, { force: true });
    if (!st || !st.isDirectory()) await mkdir(at);
  }
  await rm(join(mirror, path), { recursive: true, force: true });
}

/**
 * Copy one regular file from the folder into the mirror, without following a symbolic link at
 * its name. False when it is no longer a regular file.
 */
async function copyIn(folder: string, mirror: string, path: string, mode: number): Promise<boolean> {
  let source;
  try { source = await open(join(folder, path), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return false; }
  try {
    if (!(await source.stat()).isFile()) return false;
    await prepare(mirror, path);
    const temp = join(mirror, dirname(path), `.codeflow-import-${randomBytes(6).toString("hex")}`);
    try {
      await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(temp, { mode: 0o600 }));
      await chmod(temp, mode & 0o111 ? 0o755 : 0o644);
      await rename(temp, join(mirror, path));
    } finally { await rm(temp, { force: true }); }
    return true;
  } finally { await source.close(); }
}

async function readManifest(mirror: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestFile(mirror), "utf8"));
    return parsed?.version === 1 && parsed.files && typeof parsed.files === "object" ? parsed.files : {};
  } catch { return {}; }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

// ---------------------------------------------------------------------------------------------
// Applying a result to the folder (docs/design/folder-projects.md 4.5).

/** One apply of a run's result to a folder, kept so it can be undone. */
export interface FolderApplyRecord {
  version: 1;
  id: string;
  runId?: string;
  branch: string;
  /** The folder's snapshot the result started from, and the result applied. Pinned under refs/codeflow/applied/<id>/. */
  base: string;
  head: string;
  at: number;
  paths: string[];
  /** Where the files the result deleted were moved. */
  removedTo?: string;
  undoneAt?: number;
}

export type FolderApply =
  | { ok: true; id: string; commit: string; written: string[]; removed: string[] }
  /** `resolvable: false`: merging the folder's latest copy into the result wouldn't fix it (see applyBase). */
  | { ok: false; conflicts: string[]; message: string; resolvable?: false };

interface Change { path: string; oldMode: string; newMode: string; oldId: string; newId: string }
type FolderState = { kind: "none" } | { kind: "file"; id: string; mode: number } | { kind: "link"; id: string } | { kind: "dir" | "other" | "blocked" } | { kind: "unsafe" };

const ABSENT = /^0+$/;
const appliedDir = (mirror: string) => join(dirname(mirror), "applied");

async function gitText(mirror: string, args: string[]): Promise<string> {
  const res = await git(args, mirror);
  if (res.code !== 0) throw new Error(gitError(args, res));
  return res.stdout;
}

/** What changed from `from` to `to`, path by path (no rename detection: each path stands alone). */
async function changesBetween(mirror: string, from: string, to: string): Promise<Change[]> {
  const out = (await gitText(mirror, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-abbrev", from, to])).split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(out[i]!);
    if (m) changes.push({ path: out[i + 1]!, oldMode: m[1]!, newMode: m[2]!, oldId: m[3]!, newId: m[4]! });
  }
  return changes;
}

/** The id git gives a blob: what a file or link in the folder would be, without running git on the folder. */
async function blobId(path: string, link: boolean): Promise<string> {
  const hash = createHash("sha1");
  if (link) {
    const target = Buffer.from(await readlink(path));
    return hash.update(`blob ${target.length}\0`).update(target).digest("hex");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    hash.update(`blob ${(await file.stat()).size}\0`);
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** What the folder has at `path`. A link among its parent folders makes it unsafe to write there. */
async function folderState(folder: string, path: string): Promise<FolderState> {
  let at = folder;
  for (const part of dirname(path).split("/").filter((p) => p && p !== ".")) {
    at = join(at, part);
    const st = await lstat(at).catch(() => undefined);
    if (!st) return { kind: "none" };
    if (st.isSymbolicLink()) return { kind: "unsafe" };
    if (!st.isDirectory()) return { kind: "blocked" };
  }
  const target = join(folder, path);
  const st = await lstat(target).catch(() => undefined);
  if (!st) return { kind: "none" };
  if (st.isSymbolicLink()) return { kind: "link", id: await blobId(target, true) };
  if (st.isFile()) return { kind: "file", id: await blobId(target, false), mode: st.mode & 0o777 };
  return { kind: st.isDirectory() ? "dir" : "other" };
}

/** A path Code Flow writes only inside the folder, never into a repository marker or its own folders. */
function safePath(path: string): boolean {
  const parts = path.split("/");
  return !!path && !isAbsolute(path) && !parts.some((p) => !p || p === "." || p === ".." || p === ".git" || p === CONTEXT_DIR) && parts[0] !== WORKTREE_DIR;
}

/**
 * Apply the change from `from` to `to` to the folder, all or nothing. Before writing anything,
 * every path must hold in the folder exactly what `from` has there (or nothing, where `from` has
 * nothing); any path that doesn't is a conflict and nothing is written. Deleted files are moved to
 * `removedTo`, not deleted. A failure partway puts back what was already written.
 */
async function applyBetween(mirror: string, folder: string, from: string, to: string, removedTo: string): Promise<FolderApply & { paths?: string[] }> {
  const changes = await changesBetween(mirror, from, to);
  const conflicts: string[] = [];
  const unsafe: string[] = [];
  const modes = new Map<string, number>();
  for (const c of changes) {
    if (!safePath(c.path) || c.oldMode === "160000" || c.newMode === "160000") { unsafe.push(c.path); continue; }
    if (c.newMode === "120000") {
      const target = await gitText(mirror, ["cat-file", "blob", c.newId]);
      if (isAbsolute(target) || !within(resolve(folder, dirname(c.path), target), folder)) { unsafe.push(c.path); continue; }
    }
    const state = await folderState(folder, c.path);
    if (state.kind === "unsafe") { unsafe.push(c.path); continue; }
    if (ABSENT.test(c.oldId)) { if (state.kind !== "none") conflicts.push(c.path); continue; }
    const deleting = ABSENT.test(c.newId);
    if (deleting && state.kind === "none") continue;
    const expectLink = c.oldMode === "120000";
    const matches = expectLink ? state.kind === "link" && state.id === c.oldId : state.kind === "file" && state.id === c.oldId;
    if (!matches) conflicts.push(c.path);
    else if (state.kind === "file") modes.set(c.path, state.mode);
  }
  if (unsafe.length) throw new FolderError(`The result changes paths Code Flow won't write into the folder (a link among their folders, a link that leaves the folder, a repository or Code Flow's own folders): ${unsafe.slice(0, 20).join(", ")}. Nothing was written.`);
  if (conflicts.length) return { ok: false, conflicts, message: `These files changed in the folder since the run started, so the result can't be applied without losing your edits: ${conflicts.slice(0, 20).join(", ")}${conflicts.length > 20 ? ` and ${conflicts.length - 20} more` : ""}. Nothing was written. Resolve the conflicts, then apply again.` };

  const done: { change: Change; movedTo?: string }[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  try {
    for (const c of changes) {
      const target = join(folder, c.path);
      if (ABSENT.test(c.newId)) {
        if (!(await lstat(target).catch(() => undefined))) continue;
        const dest = join(removedTo, c.path);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await moveAside(target, dest);
        done.push({ change: c, movedTo: dest });
        removed.push(c.path);
        continue;
      }
      await writeEntry(mirror, folder, c.path, c.newMode, c.newId, modes.get(c.path));
      done.push({ change: c });
      written.push(c.path);
    }
  } catch (err) {
    const failed: string[] = [];
    for (const { change: c, movedTo } of done.reverse()) {
      try {
        if (movedTo) await moveAside(movedTo, join(folder, c.path));
        else if (ABSENT.test(c.oldId)) await rm(join(folder, c.path), { force: true });
        else await writeEntry(mirror, folder, c.path, c.oldMode, c.oldId, modes.get(c.path));
      } catch { failed.push(c.path); }
    }
    const back = failed.length ? ` These couldn't be put back: ${failed.join(", ")}; their earlier versions are in the snapshot ${from.slice(0, 12)}.` : " The folder was put back as it was.";
    throw new FolderError(`Applying stopped: ${(err as Error).message}.${back}`);
  }
  return { ok: true, id: "", commit: "", written, removed, paths: changes.map((c) => c.path) };
}

/** Write one entry into the folder: its parent folders made as needed, then a temporary file renamed over it. */
async function writeEntry(mirror: string, folder: string, path: string, mode: string, id: string, current?: number): Promise<void> {
  let at = folder;
  for (const part of dirname(path).split("/").filter((p) => p && p !== ".")) {
    at = join(at, part);
    const st = await lstat(at).catch(() => undefined);
    if (!st) await mkdir(at);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dirname(path)} is no longer a folder`);
  }
  const target = join(folder, path);
  const temp = join(dirname(target), `.codeflow-apply-${randomBytes(6).toString("hex")}`);
  try {
    if (mode === "120000") await symlink(await gitText(mirror, ["cat-file", "blob", id]), temp);
    else {
      await writeBlobFile(mirror, id, temp);
      const base = current ?? 0o644;
      await chmod(temp, mode === "100755" ? base | 0o111 : base & ~0o111);
    }
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}

/** Move a file, or copy it and remove the original when the two are on different disks. */
async function moveAside(from: string, to: string): Promise<void> {
  try { await rename(from, to); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { force: true });
  }
}

/** The folder must still be the one the mirror was made for (see FolderMeta.inode). */
async function assertSameFolder(meta: FolderMeta): Promise<void> {
  const info = await lstat(meta.path, { bigint: true }).catch(() => undefined);
  if (!info?.isDirectory()) throw new FolderError(`The folder ${meta.path} no longer exists. Locate it or remove it from the project.`);
  if (String(info.ino) !== meta.inode) throw new FolderError(`The folder at ${meta.path} was replaced since Code Flow first copied it, so nothing is written into it. Remove it from the project and add it again.`);
}

/** Record the folder as it is after an apply, as a merge of the result: the next apply of that result only brings what's new. */
async function snapshotAfterApply(mirror: string, folder: string, head: string): Promise<string> {
  await importLocked(mirror, folder);
  const tree = (await gitText(mirror, ["rev-parse", "HEAD^{tree}"])).trim();
  const main = (await gitText(mirror, ["rev-parse", "HEAD"])).trim();
  const args = ["commit-tree", tree, "-p", main, "-p", head, "-m", "Folder snapshot after applying a result"];
  const res = await git(args, mirror, { env: SNAPSHOT_IDENTITY });
  if (res.code !== 0) throw new Error(gitError(args, res));
  const commit = res.stdout.trim();
  await gitText(mirror, ["update-ref", "refs/heads/main", commit, main]);
  return commit;
}

/**
 * Apply `branch` (a run's result in the mirror) to the folder: import first, so edits made during
 * the run count, then write the change from where the result started to the result. Conflicts
 * come back as `ok: false` with nothing written; after an import the mirror's main holds the
 * folder as it is now, so merging main into the result resolves them like any merge conflict.
 */
export async function applyToFolder(mirror: string, branch: string, opts: { runId?: string } = {}): Promise<FolderApply> {
  const meta = await readMeta(mirror);
  return withRepoLock(mirror, async () => {
    await assertSameFolder(meta);
    await importLocked(mirror, meta.path);
    const head = (await gitText(mirror, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
    const { base, afterUndo } = await applyBase(mirror, head);
    if (base === head) throw new FolderError(`Nothing to apply: the folder already has everything on ${branch}`);
    const id = `a-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    await gitText(mirror, ["update-ref", `refs/codeflow/applied/${id}/base`, base]);
    await gitText(mirror, ["update-ref", `refs/codeflow/applied/${id}/head`, head]);
    const removedTo = join(dirname(mirror), "removed", id);
    const result = await applyBetween(mirror, meta.path, base, head, removedTo);
    if (!result.ok) {
      await gitText(mirror, ["update-ref", "-d", `refs/codeflow/applied/${id}/base`]);
      await gitText(mirror, ["update-ref", "-d", `refs/codeflow/applied/${id}/head`]);
      // After an undo, main still has the result in its history: merging main into the result would
      // fast-forward it to the undone state and lose the run's changes, so that fix isn't offered.
      return afterUndo ? { ...result, resolvable: false, message: `These files changed in the folder since you undid the earlier apply: ${result.conflicts.slice(0, 20).join(", ")}. Nothing was written. Put them back as they were, then apply again.` } : result;
    }
    const record: FolderApplyRecord = { version: 1, id, ...(opts.runId ? { runId: opts.runId } : {}), branch, base, head, at: Date.now(), paths: result.paths ?? [], ...(result.removed.length ? { removedTo } : {}) };
    await mkdir(appliedDir(mirror), { recursive: true, mode: 0o700 });
    await writeAtomic(join(appliedDir(mirror), `${id}.json`), JSON.stringify(record, null, 2));
    const commit = await snapshotAfterApply(mirror, meta.path, head);
    return { ok: true, id, commit, written: result.written, removed: result.removed };
  });
}

/**
 * Where an apply of `head` starts from. Usually the merge base with main, the folder's latest
 * snapshot. But the snapshot after an apply keeps the result as a parent, and undoing it doesn't
 * take that out of main's history: when the newest apply of this result (or of an earlier commit of
 * it) was undone, start from what the folder had before that apply.
 */
async function applyBase(mirror: string, head: string): Promise<{ base: string; afterUndo: boolean }> {
  const base = (await gitText(mirror, ["merge-base", "refs/heads/main", head])).trim();
  for (const record of await folderApplies(mirror)) {
    if (!(await isAncestorCommit(mirror, record.head, head))) continue;
    if (!record.undoneAt) break;
    const before = await gitText(mirror, ["rev-parse", "--verify", `refs/codeflow/applied/${record.id}/base^{commit}`]).then((t) => t.trim(), () => "");
    if (before && (await isAncestorCommit(mirror, before, head))) return { base: before, afterUndo: true };
    break;
  }
  return { base, afterUndo: false };
}

async function isAncestorCommit(mirror: string, ancestor: string, commit: string): Promise<boolean> {
  return gitText(mirror, ["merge-base", "--is-ancestor", ancestor, commit]).then(() => true, () => false);
}

/** The applies to a folder, newest first. */
export async function folderApplies(mirror: string): Promise<FolderApplyRecord[]> {
  const names = await readdir(appliedDir(mirror)).catch(() => [] as string[]);
  const records: FolderApplyRecord[] = [];
  for (const name of names.filter((n) => /^a-[a-z0-9]+-[0-9a-f]{6}\.json$/.test(n))) {
    try { records.push(JSON.parse(await readFile(join(appliedDir(mirror), name), "utf8"))); } catch { /* unreadable: left out */ }
  }
  return records.sort((a, b) => b.at - a.at);
}

/**
 * Undo an apply: put back what the folder had before it, path by path, with the same checks the
 * other way round. A file you changed since the apply is a conflict, and nothing is written.
 */
export async function undoFolderApply(mirror: string, id: string): Promise<FolderApply> {
  if (!/^a-[a-z0-9]+-[0-9a-f]{6}$/.test(id)) throw new FolderError("Choose an apply to undo");
  const meta = await readMeta(mirror);
  return withRepoLock(mirror, async () => {
    const file = join(appliedDir(mirror), `${id}.json`);
    const record = JSON.parse(await readFile(file, "utf8").catch(() => { throw new FolderError("That apply isn't recorded for this folder"); })) as FolderApplyRecord;
    if (record.undoneAt) throw new FolderError("That apply was already undone");
    await assertSameFolder(meta);
    await importLocked(mirror, meta.path);
    const head = (await gitText(mirror, ["rev-parse", "--verify", `refs/codeflow/applied/${id}/head`])).trim();
    const base = (await gitText(mirror, ["rev-parse", "--verify", `refs/codeflow/applied/${id}/base`])).trim();
    const result = await applyBetween(mirror, meta.path, head, base, join(dirname(mirror), "removed", `${id}-undo`));
    if (!result.ok) return { ...result, message: result.message.replace("since the run started, so the result can't be applied", "since the apply, so it can't be undone") };
    await writeAtomic(file, JSON.stringify({ ...record, undoneAt: Date.now() }, null, 2));
    const commit = (await importLocked(mirror, meta.path)).commit;
    return { ok: true, id, commit, written: result.written, removed: result.removed };
  });
}
