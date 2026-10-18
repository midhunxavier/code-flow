import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function syncWorkerDirectory(path: string) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); }
}

/** Persist every new directory entry, including newly created parents, before acknowledging a claim. */
export async function durableWorkerDirectory(path: string, synchronize = syncWorkerDirectory) {
  const destination = resolve(path), missing: string[] = []; let current = destination;
  for (;;) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info) { if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker state must use a regular directory"); break; }
    missing.push(current); const parent = dirname(current); if (parent === current) throw new Error("Worker directory has no existing ancestor"); current = parent;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const info = await lstat(destination); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker state must use a regular directory");
  for (const directory of new Set(missing.length ? [...missing, current] : [destination, dirname(destination)])) await synchronize(directory);
}
