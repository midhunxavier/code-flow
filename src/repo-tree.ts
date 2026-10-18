import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { git, type GitCwd } from "./git.js";
import { assertProjectDirectoryAccess, assertProjectFileAccess, filePolicyMetadataOnly, filePolicyRegistryActive, filterAllowedProjectEntries } from "./filesystem-policy.js";

export interface TreeEntry {
  name: string;
  /** Repo-relative, "/"-separated. */
  path: string;
  type: "file" | "dir";
  /** M = has uncommitted changes, U = untracked, A = added (staged). */
  status?: "M" | "U" | "A";
}

const MAX_ENTRIES = 1_000;

/**
 * The Files panel waits on these: in a huge repo, or one another git is busy with, it says so
 * after this long instead of loading forever. Every call goes through `git()`, so none of them
 * prompts or takes the optional locks your own git needs. A run's worktree is passed as a
 * Checkout (see worktreeGit): its `.git` is the agents' to rewrite, and a `git status` there
 * would otherwise run the filters a config of theirs names.
 */
const PANEL_TIMEOUT_MS = 30_000;

/** Normalize a repo-relative path from the client and refuse anything that leaves the repo. */
export function normalizeRepoPath(raw: string): string {
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`Path "${raw}" must stay inside the repository`);
  return parts.join("/");
}

/** Absolute path for a repo-relative path, verified (through symlinks) to be inside the repo. */
export async function resolveInsideRepo(repo: string, rel: string): Promise<string> {
  const abs = rel ? join(repo, ...rel.split("/")) : repo;
  const [real, realRepo] = await Promise.all([realpath(abs), realpath(repo)]);
  if (real !== realRepo && !real.startsWith(realRepo + sep)) {
    throw new Error(`Path "${rel}" points outside the repository`);
  }
  return abs;
}

const folderOf = (repo: GitCwd) => (typeof repo === "string" ? repo : repo.path);

/** Immediate children of a repo folder, minus .git and anything git ignores. */
export async function listTree(repo: GitCwd, relDir = ""): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  const rel = normalizeRepoPath(relDir);
  await assertProjectDirectoryAccess(folderOf(repo), rel || ".");
  const abs = await resolveInsideRepo(folderOf(repo), rel);
  const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => d.name !== ".git" && (!filePolicyRegistryActive() || !d.isSymbolicLink()));

  const candidates = await Promise.all(
    dirents.map(async (d) => {
      const path = rel ? `${rel}/${d.name}` : d.name;
      const isDir = d.isDirectory() || (d.isSymbolicLink() && (await stat(join(abs, d.name)).then((s) => s.isDirectory(), () => false)));
      return { name: d.name, path, type: (isDir ? "dir" : "file") as TreeEntry["type"] };
    }),
  );

  const ignored = await ignoredPaths(repo, candidates.map((c) => (c.type === "dir" ? `${c.path}/` : c.path)));
  // git status may run repository fsmonitor and clean filters. Restricted browsing omits decoration.
  const statuses = filePolicyMetadataOnly() ? new Map<string, TreeEntry["status"]>() : await childStatuses(repo, rel);

  const entries = (await filterAllowedProjectEntries(folderOf(repo), candidates))
    .filter((c) => !ignored.has(c.type === "dir" ? `${c.path}/` : c.path))
    .map((c) => ({ ...c, status: statuses.get(c.name) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.type === "dir" ? -1 : 1));

  return { path: rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

/** Files (tracked and untracked, not ignored) whose path contains `query`; filename matches first. */
export async function searchFiles(repo: GitCwd, query: string, limit = 100): Promise<TreeEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const res = await git(["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], repo, { timeoutMs: PANEL_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git ls-files failed");
  const unique = [...new Set(res.stdout.split("\0").filter(Boolean))];
  const nameHits: string[] = [];
  const pathHits: string[] = [];
  for (const path of unique) {
    const lower = path.toLowerCase();
    if (basename(lower).includes(q)) nameHits.push(path);
    else if (lower.includes(q)) pathHits.push(path);
  }
  return (await filterAllowedProjectEntries(folderOf(repo), [...nameHits, ...pathHits].map((path) => ({ name: basename(path), path, type: "file" as const })))).slice(0, limit);
}

async function ignoredPaths(repo: GitCwd, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // Exit 0 = some ignored, 1 = none ignored; anything else means git couldn't tell.
  const res = await git(["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"], repo, { input: paths.join("\0") + "\0", timeoutMs: PANEL_TIMEOUT_MS });
  // A timeout also exits 1; listing everything as not ignored would show node_modules and co.
  if (res.timedOut) throw new Error(res.stderr.split("\n")[0]);
  if (res.code !== 0 && res.code !== 1) return new Set();
  return new Set(res.stdout.split("\0").filter(Boolean));
}

/** Map of child name → status, rolled up from `git status` for everything under `rel`. */
async function childStatuses(repo: GitCwd, rel: string): Promise<Map<string, TreeEntry["status"]>> {
  const res = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rel || "."], repo, { timeoutMs: PANEL_TIMEOUT_MS });
  const statuses = new Map<string, TreeEntry["status"]>();
  if (res.code !== 0) return statuses;

  const records = res.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // renames carry the old path as an extra record
    const inside = rel ? (path.startsWith(`${rel}/`) ? path.slice(rel.length + 1) : null) : path;
    if (!inside) continue;
    const child = inside.split("/")[0]!;
    const status: TreeEntry["status"] = xy === "??" ? "U" : xy === "A " ? "A" : "M";
    const previous = statuses.get(child);
    // A folder mixing untracked and changed files shows as M.
    statuses.set(child, previous && previous !== status ? "M" : status);
  }
  return statuses;
}

export interface FileContent {
  path: string;
  size: number;
  /** The file's text; absent for a binary file. */
  text?: string;
  binary: boolean;
  /** Only the first part of a long file is here. */
  truncated: boolean;
}

/** How much of a file the side panel's viewer gets; longer files are cut, not refused. */
const MAX_FILE_BYTES = 512 * 1024;

/** A file's contents for the Files tab: text up to a limit, or that it's binary. */
export async function readRepoFile(repo: GitCwd, relPath: string): Promise<FileContent> {
  await assertProjectFileAccess(folderOf(repo), relPath, "read");
  const rel = normalizeRepoPath(relPath);
  if (!rel) throw new Error("Name a file");
  const abs = await resolveInsideRepo(folderOf(repo), rel);
  const info = await stat(abs);
  if (info.isDirectory()) throw new Error(`"${rel}" is a folder`);
  const handle = await open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    await assertProjectFileAccess(folderOf(repo), relPath, "read");
    const head = buf.subarray(0, Math.min(bytesRead, 8_000));
    if (head.includes(0)) return { path: rel, size: info.size, binary: true, truncated: false };
    return { path: rel, size: info.size, text: buf.subarray(0, bytesRead).toString("utf8"), binary: false, truncated: info.size > bytesRead };
  } finally {
    await handle.close();
  }
}
