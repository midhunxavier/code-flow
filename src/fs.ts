import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface DirEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  isRepo: boolean;
  entries: DirEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 500;

const isRepo = (path: string) => existsSync(join(path, ".git"));

export function directoryPath(path?: string, home = homedir()): string {
  const typed = path?.trim() || home;
  return resolve(typed === "~" ? home : typed.startsWith("~/") ? join(home, typed.slice(2)) : typed);
}

/** Subdirectories of `path` (default: home), for the UI's folder picker. Names only, never file contents. */
export async function listDirectories(path?: string, showHidden = false): Promise<DirListing> {
  const target = directoryPath(path);
  if (!(await stat(target)).isDirectory()) throw new Error(`${target} is not a directory`);

  const dirents = await readdir(target, { withFileTypes: true });
  const dirs = dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .filter((d) => showHidden || !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const entries: DirEntry[] = [];
  for (const name of dirs.slice(0, MAX_ENTRIES)) {
    const full = join(target, name);
    // Symlinks only count if they point at a directory.
    const ok = await stat(full).then((s) => s.isDirectory(), () => false);
    if (ok) entries.push({ name, path: full, isRepo: isRepo(full) });
  }

  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: homedir(),
    isRepo: isRepo(target),
    entries,
    truncated: dirs.length > MAX_ENTRIES,
  };
}

/**
 * Write `contents` to `rel` inside `root` without following a symbolic link anywhere on the way.
 * For files whose path comes from an agent (a reviewer's test), written into a checkout of code
 * someone else may control: a tracked `tests -> ../../..` would otherwise send the write outside
 * the checkout, to your own files. Folders that don't exist are created one at a time. Returns
 * why it refused (a link, a file where a folder should be, a path that leaves `root`), or
 * undefined once it's written.
 */
export async function writeFileInside(root: string, rel: string, contents: string): Promise<string | undefined> {
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return `\`${rel}\` isn't a path inside the checkout`;
  const realRoot = await realpath(root);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const info = await lstat(dir).catch(() => undefined);
    if (!info) await mkdir(dir);
    else if (info.isSymbolicLink()) return `\`${rel}\` goes through a symbolic link (\`${part}\`)`;
    else if (!info.isDirectory()) return `\`${rel}\` goes through \`${part}\`, which isn't a folder`;
  }
  // Checked part by part above; this catches a link that appeared in between.
  const realDir = await realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) return `\`${rel}\` leads outside the checkout`;
  const target = join(dir, parts[parts.length - 1]!);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) return `\`${rel}\` is a symbolic link`;
  if (existing && !existing.isFile()) return `\`${rel}\` isn't a file`;
  // O_NOFOLLOW: if a link shows up at the last moment, opening fails instead of following it.
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
  return undefined;
}
