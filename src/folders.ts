import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { CODEFLOW_HOME, envNumber, WORKTREE_DIR } from "./config.js";
import { CONTEXT_DIR, ensureCodeflowExcludes, git, gitError, repoRoot, withRepoLock } from "./git.js";

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
  const folder = meta.path;
  return withRepoLock(mirror, async () => {
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
  });
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
