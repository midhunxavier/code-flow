import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { git, gitWithInput } from "./git.js";

export interface TreeEntry {
  name: string;
  /** Repo-relative, "/"-separated. */
  path: string;
  type: "file" | "dir";
  /** M = has uncommitted changes, U = untracked, A = added (staged). */
  status?: "M" | "U" | "A";
}

const MAX_ENTRIES = 1_000;

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

/** Immediate children of a repo folder, minus .git and anything git ignores. */
export async function listTree(repo: string, relDir = ""): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  const rel = normalizeRepoPath(relDir);
  const abs = await resolveInsideRepo(repo, rel);
  const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => d.name !== ".git");

  const candidates = await Promise.all(
    dirents.map(async (d) => {
      const path = rel ? `${rel}/${d.name}` : d.name;
      const isDir = d.isDirectory() || (d.isSymbolicLink() && (await stat(join(abs, d.name)).then((s) => s.isDirectory(), () => false)));
      return { name: d.name, path, type: (isDir ? "dir" : "file") as TreeEntry["type"] };
    }),
  );

  const ignored = await ignoredPaths(repo, candidates.map((c) => (c.type === "dir" ? `${c.path}/` : c.path)));
  const statuses = await childStatuses(repo, rel);

  const entries = candidates
    .filter((c) => !ignored.has(c.type === "dir" ? `${c.path}/` : c.path))
    .map((c) => ({ ...c, status: statuses.get(c.name) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.type === "dir" ? -1 : 1));

  return { path: rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

/** Files (tracked and untracked, not ignored) whose path contains `query`; filename matches first. */
export async function searchFiles(repo: string, query: string, limit = 100): Promise<TreeEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const res = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], repo);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git ls-files failed");
  const unique = [...new Set(res.stdout.split("\0").filter(Boolean))];
  const nameHits: string[] = [];
  const pathHits: string[] = [];
  for (const path of unique) {
    const lower = path.toLowerCase();
    if (basename(lower).includes(q)) nameHits.push(path);
    else if (lower.includes(q)) pathHits.push(path);
  }
  return [...nameHits, ...pathHits].slice(0, limit).map((path) => ({ name: basename(path), path, type: "file" as const }));
}

async function ignoredPaths(repo: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // Exit 0 = some ignored, 1 = none ignored; anything else means git couldn't tell.
  const res = await gitWithInput(["check-ignore", "-z", "--stdin"], repo, paths.join("\0") + "\0");
  if (res.code !== 0 && res.code !== 1) return new Set();
  return new Set(res.stdout.split("\0").filter(Boolean));
}

/** Map of child name → status, rolled up from `git status` for everything under `rel`. */
async function childStatuses(repo: string, rel: string): Promise<Map<string, TreeEntry["status"]>> {
  const res = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rel || "."], repo);
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
