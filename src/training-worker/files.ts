import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "../ml/model.js";
export const exec = promisify(execFile);
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export async function syncDir(path: string) { const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); } }
export async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`, fd = await open(temp, "wx", 0o600);
  try {
    try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, path); await syncDir(dirname(path));
  } finally { await rm(temp, { force: true }); }
}
export async function json<T>(path: string, optional = false): Promise<T> {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Invalid worker record"); return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined as T; throw error; }
}
export async function identity(pid = process.pid): Promise<ProcessIdentity | undefined> {
  let started: string;
  try {
    started = (await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 3000 })).stdout.trim();
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return;
    throw error; // A failed identity probe is not evidence that a lock owner died.
  }
  if (!started) return;
  const boot = process.platform === "linux" ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() : (await exec("sysctl", ["-n", "kern.boottime"], { timeout: 3000 })).stdout.trim();
  if (!boot) throw new Error("Cannot establish boot identity");
  return { pid, started, boot };
}
export async function alive(expected?: ProcessIdentity) { return !!expected && canonical(await identity(expected.pid)) === canonical(expected); }
/** Concurrent control processes serialize admission. Ambiguous abandoned locks fail closed. */
export async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".control-lock");
  const owner = await identity(); if (!owner) throw new Error("Cannot establish worker process identity");
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never remove an ambiguous or live lock. A verified dead owner can be fenced by rename.
      const prior = await json<ProcessIdentity>(join(path, "owner.json"), true);
      if (prior && !await alive(prior)) {
        // Serialize recovery and re-read after acquiring it: two rescuers must not
        // rename the next live owner's replacement lock using an old observation.
        const recovery = join(root, ".lock-recovery");
        const acquired = await mkdir(recovery, { mode: 0o700 }).then(() => true, () => false);
        if (acquired) try {
          const latest = await json<ProcessIdentity>(join(path, "owner.json"), true);
          if (latest && !await alive(latest)) { const abandoned = path + "." + randomUUID(); await rename(path, abandoned); await rm(abandoned, { recursive: true }); }
        } finally { await rm(recovery, { recursive: true }); }
      }
      if (attempt >= 100) throw new Error("Worker control is busy or its lock needs inspection");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { await atomic(join(path, "owner.json"), owner); return await work(); }
  finally {
    // Inference may hand authority to its independent supervisor. A lost control
    // connection must not release that live supervisor's compute reservation.
    const current = await json<ProcessIdentity>(join(path, "owner.json"), true);
    if (canonical(current ?? null) === canonical(owner) || current && !await alive(current)) await rm(path, { recursive: true });
  }
}
