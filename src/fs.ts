import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** Subdirectories of `path` (default: home), for the UI's folder picker. Names only, never file contents. */
export async function listDirectories(path?: string, showHidden = false): Promise<DirListing> {
  const target = resolve(path?.trim() || homedir());
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
