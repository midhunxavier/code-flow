import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { git, repoRoot, resolveCommit, withRepoLock, type GitCwd } from "./git.js";
import { normalizeRepoPath } from "./repo-tree.js";
import { assertProjectFileAccess } from "./filesystem-policy.js";

const MAX_EDIT_BYTES = 512 * 1024;
export class WorkspaceConflictError extends Error { constructor(readonly currentHash: string, message = "This file changed since it was loaded. Reload and compare your draft before saving.") { super(message); } }
/** A checkpoint tool's observed HEAD is no longer the worktree's. */
export const CHECKPOINT_HEAD_MOVED = "The worktree HEAD changed since checkpoints were loaded. Load checkpoints again and retry.";
/** Restoring a path that is absent from the checkpoint deletes it; the caller confirms that first. */
export class CheckpointDeletionError extends Error {
  constructor(readonly paths: string[], source: string) { super(`${paths.length === 1 ? "This file isn't" : `These ${paths.length} files aren't`} in checkpoint ${source.slice(0, 8)}, so applying it deletes ${paths.length === 1 ? "it" : "them"} from the worktree: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}.`); }
}
/** The path names no file (a missing component, or a file used as a folder). Never carries the absolute path. */
export class WorkspaceFileMissingError extends Error { constructor(message = "File not found") { super(message); } }
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const folderOf = (repo: GitCwd) => typeof repo === "string" ? repo : repo.path;
const rootOf = (repo: GitCwd) => typeof repo === "string" ? repoRoot(repo) : Promise.resolve(repo.path);

/** Editing refuses Git internals and every symlink component, including links inside the repo. */
async function editablePath(repo: GitCwd, path: string): Promise<{ root: string; path: string; absolute: string }> {
  const root = await realpath(await rootOf(repo));
  const rel = normalizeRepoPath(path);
  if (!rel || rel.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error("Choose a regular repository file outside .git");
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => { throw missing(error) ? new WorkspaceFileMissingError() : error; });
    if (info.isSymbolicLink()) throw new Error("Editing symbolic links is refused; open the regular file instead");
  }
  const canonical = await realpath(current).catch((error) => { throw missing(error) ? new WorkspaceFileMissingError() : error; });
  if (!canonical.startsWith(root + sep)) throw new Error("The file leaves the repository");
  const info = await lstat(canonical);
  if (!info.isFile() || info.size > MAX_EDIT_BYTES) throw new Error("Edit a regular text file under 512 KB");
  return { root, path: rel, absolute: canonical };
}

export async function readEditableFile(repo: GitCwd, path: string) {
  await assertProjectFileAccess(folderOf(repo), path, "read");
  const file = await editablePath(repo, path);
  const text = await readFile(file.absolute, "utf8");
  if (text.includes("\0")) throw new Error("Binary files cannot be edited as text");
  await assertProjectFileAccess(folderOf(repo), path, "read");
  return { path: file.path, text, hash: hash(text), bytes: Buffer.byteLength(text) };
}

export async function saveEditableFile(repo: GitCwd, path: string, text: string, expectedHash: string) {
  await assertProjectFileAccess(folderOf(repo), path, "write");
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_EDIT_BYTES || text.includes("\0")) throw new Error("The file must be text under 512 KB without binary NUL characters");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Saving needs the hash of the loaded version");
  return withRepoLock(await rootOf(repo), async () => {
    const file = await editablePath(repo, path).catch((error) => { throw error instanceof WorkspaceFileMissingError ? new WorkspaceFileMissingError("This file no longer exists. Copy your draft before reloading.") : error; });
    const before = await readEditableFile(repo, path);
    if (before.hash !== expectedHash) throw new WorkspaceConflictError(before.hash);
    const temp = join(dirname(file.absolute), `.codeflow-edit-${randomBytes(8).toString("hex")}`);
    const mode = (await lstat(file.absolute)).mode & 0o777;
    try {
      await writeFile(temp, text, { flag: "wx", mode });
      // Recheck after creating the draft, before replacing the loaded file.
      const current = await readEditableFile(repo, path);
      if (current.hash !== expectedHash) throw new WorkspaceConflictError(current.hash);
      await assertProjectFileAccess(folderOf(repo), path, "write");
      await rename(temp, file.absolute);
      return { path: file.path, hash: hash(text), bytes: Buffer.byteLength(text), savedAt: Date.now() };
    } finally { await unlink(temp).catch(() => undefined); }
  });
}

export interface CodeHit { path: string; line: number; text: string; symbol?: string; kind?: string }
const definition = /^\s*(?:(?:export|default|public|private|protected|static|async|declare|abstract)\s+)*(?:(function|class|interface|type|enum|def|struct|fn|trait)\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=)/;

export async function searchCode(repo: GitCwd, query: string, mode: "text" | "symbols" = "text") {
  const root = await rootOf(repo);
  const at = typeof repo === "string" ? root : repo;
  const listing = await git(["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], at);
  if (listing.code !== 0) throw new Error("Cannot list repository files");
  const files = [...new Set(listing.stdout.split("\0").filter(Boolean))];
  const needle = query.trim().toLowerCase();
  if (!needle && mode === "text") return { hits: [] as CodeHit[], truncated: false, scanned: 0 };
  if (query.length > 300) throw new Error("Search is limited to 300 characters");
  const hits: CodeHit[] = [];
  let scanned = 0, bytes = 0, truncated = false;
  for (const path of files) {
    if (scanned >= 2000 || bytes > 8 * 1024 * 1024 || hits.length >= 200) { truncated = true; break; }
    if (/(^|\/)(?:node_modules|vendor|dist|build|\.git)\//.test(path)) continue;
    const file = await readEditableFile(at, path).catch(() => undefined);
    if (!file) continue;
    scanned++; bytes += file.bytes;
    const lines = file.text.split("\n");
    for (let index = 0; index < lines.length && hits.length < 200; index++) {
      const text = lines[index]!;
      const match = mode === "symbols" ? definition.exec(text) : null;
      const symbol = match?.[2] ?? match?.[3];
      if (mode === "symbols" ? symbol && (!needle || symbol.toLowerCase().includes(needle)) : text.toLowerCase().includes(needle)) hits.push({ path, line: index + 1, text: text.slice(0, 500), ...(symbol ? { symbol, kind: match?.[1] ?? "variable" } : {}) });
    }
  }
  return { hits, scanned, truncated: truncated || hits.length >= 200 };
}

export async function dependencyGraph(repo: GitCwd) {
  const root = await rootOf(repo);
  const at = typeof repo === "string" ? root : repo;
  const listed = await git(["ls-files", "-z"], at);
  if (listed.code !== 0) throw new Error("Cannot list repository files");
  const all = new Set(listed.stdout.split("\0").filter((path) => /\.[cm]?[jt]sx?$/.test(path)));
  const nodes = [...all].slice(0, 500), edges: { from: string; to: string; specifier: string }[] = [];
  for (const path of nodes) {
    const file = await readEditableFile(at, path).catch(() => undefined);
    if (!file) continue;
    for (const match of file.text.matchAll(/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:require|import)\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const base = posix.normalize(posix.join(posix.dirname(path), specifier));
      const stem = base.replace(/\.[cm]?js$/, "");
      const target = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`].find((candidate) => all.has(candidate));
      if (target) edges.push({ from: path, to: target, specifier });
    }
  }
  return { nodes, edges, truncated: all.size > nodes.length, language: "JavaScript/TypeScript relative imports" };
}

/** With a run's `base`, each checkpoint says whether it is `owned`: the base or a commit descending from it, which a fork may start from. */
export async function checkpoints(repo: GitCwd, ref = "HEAD", base?: string): Promise<{ sha: string; at: number; subject: string; owned?: boolean }[]> {
  const commit = await resolveCommit(repo, ref);
  const log = await git(["log", "--max-count=50", "--format=%H%x00%at%x00%s", commit], repo);
  if (log.code !== 0) throw new Error("Cannot read checkpoints");
  const list = log.stdout.trim().split("\n").filter(Boolean).map((line) => { const [sha, at, subject] = line.split("\0"); return { sha: sha!, at: Number(at) * 1000, subject: subject! }; });
  if (!base) return list;
  const start = await resolveCommit(repo, base);
  const descendants = await git(["rev-list", "--ancestry-path", `${start}..${commit}`], repo);
  if (descendants.code !== 0) throw new Error("Cannot read this run's checkpoints");
  const owned = new Set([start, ...descendants.stdout.split("\n").filter(Boolean)]);
  return list.map((item) => ({ ...item, owned: owned.has(item.sha) }));
}

/**
 * Selective application requires a clean result worktree and an exact observed HEAD. A tracked path the
 * checkpoint lacks is deleted (Git's restore semantics), so that needs `confirmDeletes` and is reported.
 */
export async function applyCheckpoint(repo: GitCwd, input: { source: string; paths: string[]; expectedHead: string; confirmDeletes?: boolean }) {
  return withRepoLock(folderOf(repo), async () => {
    const head = await resolveCommit(repo);
    if (head !== input.expectedHead) throw new WorkspaceConflictError(head, CHECKPOINT_HEAD_MOVED);
    if ((await git(["status", "--porcelain"], repo)).stdout.trim()) throw new Error("Commit or save existing changes before applying a checkpoint");
    const source = await resolveCommit(repo, input.source);
    const paths = [...new Set(input.paths.map(normalizeRepoPath))];
    if (!paths.length || paths.length > 100 || paths.some((path) => !path || path.split("/").some((part) => part.toLowerCase() === ".git"))) throw new Error("Choose 1–100 repository paths");
    const absent = await git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", head, source, "--", ...paths], repo);
    if (absent.code !== 0) throw new Error(absent.stderr.trim() || "Could not compare the selected paths");
    const deleted = absent.stdout.split("\0").filter(Boolean);
    if (deleted.length && input.confirmDeletes !== true) throw new CheckpointDeletionError(deleted, source);
    const applied = await git(["--literal-pathspecs", "restore", `--source=${source}`, "--worktree", "--", ...paths], repo);
    if (applied.code !== 0) throw new Error(applied.stderr.trim() || "Could not apply the selected paths");
    return { head, source, paths, deleted, staged: false };
  });
}
