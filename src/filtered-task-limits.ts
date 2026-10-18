import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

/** Live limits allow bounded temporary rewrite files; final imports have tighter bounds. */
export const FILTERED_WORKSPACE_LIMITS = { entries: 2000, depth: 32, logicalBytes: 32 * 1024 * 1024, allocatedBytes: 64 * 1024 * 1024, scanMs: 5000 };
export class FilteredWorkspaceLimitError extends Error {}

/** Inspect metadata only. Known symbolic links are never traversed and paths never enter errors. */
export async function inspectFilteredWorkspace(root: string, stopped: () => boolean = () => false) {
  const stats = { entries: 0, logicalBytes: 0, allocatedBytes: 0 }, started = Date.now();
  const fail = (reason: string): never => { throw new FilteredWorkspaceLimitError(`Filtered workspace ${reason}; stop the task and inspect its bounded output`); };
  const walk = async (directory: string, depth: number) => {
    if (stopped()) return;
    if (depth > FILTERED_WORKSPACE_LIMITS.depth) fail("directory depth exceeds its live limit");
    const before = await lstat(directory); if (!before.isDirectory() || before.isSymbolicLink()) fail("contains a symbolic or non-directory ancestor");
    const handle = await opendir(directory, { bufferSize: 32 });
    try {
      // Refuse a replacement before enumerating any entries from the opened path.
      const current = await lstat(directory); if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) fail("directory changed during inspection");
      for await (const entry of handle) {
        if (stopped()) return;
        if (depth === 0 && entry.name === ".git") continue; // immutable synthetic metadata is mounted read-only
        if (++stats.entries > FILTERED_WORKSPACE_LIMITS.entries) fail("entry count exceeds its live limit");
        if (Date.now() - started > FILTERED_WORKSPACE_LIMITS.scanMs) fail("inspection exceeded its deadline");
        if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/\x00-\x1f\x7f]/.test(entry.name)) fail("contains an unsupported entry name");
        const path = join(directory, entry.name); let info;
        try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (info.isSymbolicLink()) fail("contains a symbolic link");
        if (!info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1) fail("contains a special or hard-linked file");
        stats.logicalBytes += info.isFile() ? info.size : 0;
        stats.allocatedBytes += typeof info.blocks === "number" ? info.blocks * 512 : Math.ceil(info.size / 4096) * 4096;
        if (stats.logicalBytes > FILTERED_WORKSPACE_LIMITS.logicalBytes || stats.allocatedBytes > FILTERED_WORKSPACE_LIMITS.allocatedBytes) fail("bytes exceed its live limit");
        if (info.isDirectory()) await walk(path, depth + 1);
      }
    } finally { await handle.close().catch((error: NodeJS.ErrnoException) => { if (error.code !== "ERR_DIR_CLOSED") throw error; }); }
  };
  try { await walk(root, 0); } catch (error) { if (stopped()) return stats; if (error instanceof FilteredWorkspaceLimitError) throw error; throw new FilteredWorkspaceLimitError("Filtered workspace could not be safely inspected; stop the task and inspect its output"); }
  return stats;
}

/** Polling bounds observed output; it is not an OS disk quota and may overshoot between scans. */
export function monitorFilteredWorkspace(root: string, options: { signal: AbortSignal; onExceeded: (error: Error) => void; intervalMs?: number }): { stop(): Promise<void> } {
  const interval = Number.isFinite(options.intervalMs) ? Math.max(20, Math.min(5000, options.intervalMs!)) : 250;
  let stopped = options.signal.aborted, timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> = Promise.resolve();
  const abort = () => { stopped = true; clearTimeout(timer); };
  options.signal.addEventListener("abort", abort, { once: true });
  const scan = () => {
    if (stopped) return;
    pending = inspectFilteredWorkspace(root, () => stopped).then(() => { if (!stopped) { timer = setTimeout(scan, interval); timer.unref(); } }, (error: Error) => { if (!stopped) { stopped = true; try { options.onExceeded(error); } catch { /* The owning service retains responsibility for daemon cancellation. */ } } });
  };
  scan();
  return { async stop() { abort(); options.signal.removeEventListener("abort", abort); await pending; } };
}
