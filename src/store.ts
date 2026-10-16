import { createReadStream, existsSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

/**
 * Runs are persisted as their append-only event log (`<id>.jsonl`): every run snapshot and
 * step update is already in it, so the log is the single source of truth and runs are
 * rebuilt from it on startup. A separate journal (`<id>.journal.jsonl`) records the result
 * of every completed step so an interrupted run can be resumed by replaying them.
 */

export const RUNS_DIR = join(CODEFLOW_HOME, "runs");

/** Journal entries carry this; entries written by a newer code-flow are ignored, not misread. */
export const JOURNAL_VERSION = 2;

let writeQueue: Promise<unknown> = mkdir(RUNS_DIR, { recursive: true }).catch(() => undefined);

/** Failed writes (a full disk, a permissions problem): runs keep going but aren't saved. */
export const writeHealth: { failures: number; lastError?: string; at?: number } = { failures: 0 };

/** Files whose last line was checked this process; a crash mid-write leaves a line without "\n". */
const repaired = new Set<string>();

async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return true; // new file
  try {
    const { size } = await handle.stat();
    if (!size) return true;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** Append a JSON line; writes are queued so each file's lines stay in order. */
export function appendLine(file: string, value: unknown) {
  const line = `${JSON.stringify(value)}\n`;
  writeQueue = writeQueue
    .then(async () => {
      const path = join(RUNS_DIR, file);
      // Close a torn last line first, or this line would be glued to it and both lost.
      const prefix = repaired.has(file) || (await endsWithNewline(path)) ? "" : "\n";
      repaired.add(file);
      await appendFile(path, prefix + line);
    })
    .catch((err: Error) => {
      writeHealth.failures++;
      writeHealth.lastError = err.message;
      writeHealth.at = Date.now();
      if (writeHealth.failures === 1 || writeHealth.failures % 100 === 0) {
        console.error(`code-flow couldn't save run data (${writeHealth.failures} failed writes): ${err.message}`);
      }
    });
}

/** Resolves once everything queued so far is on disk. */
export function flushWrites(): Promise<unknown> {
  return writeQueue;
}

export async function readJsonLines<T = any>(file: string): Promise<T[]> {
  const path = join(RUNS_DIR, file);
  if (!existsSync(path)) return [];
  const out: T[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn line from a crash; skip it
    }
  }
  return out;
}

export async function listRunIds(): Promise<string[]> {
  if (!existsSync(RUNS_DIR)) return [];
  return (await readdir(RUNS_DIR))
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".journal.jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}

export async function loadJournal(runId: string): Promise<Map<string, unknown>> {
  const entries = await readJsonLines<{ key: string; value: unknown; v?: number }>(`${runId}.journal.jsonl`);
  return new Map(entries.filter((e) => (e.v ?? 1) <= JOURNAL_VERSION).map((e) => [e.key, e.value]));
}

export function journalEntry(runId: string, key: string, value: unknown) {
  appendLine(`${runId}.journal.jsonl`, { key, value, v: JOURNAL_VERSION });
}

/**
 * One server per CODEFLOW_HOME: two would append to the same logs with clashing sequence
 * numbers. Waits briefly for a previous instance that is still shutting down (a restart).
 * Returns a release function.
 */
export async function acquireLock(waitMs = 20_000): Promise<() => void> {
  const file = join(CODEFLOW_HOME, "server.lock");
  await mkdir(CODEFLOW_HOME, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (!holder || !alive(holder) || holder === process.pid) {
        await unlink(file).catch(() => undefined); // stale: its server is gone
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Another code-flow server (pid ${holder}) is using ${CODEFLOW_HOME}. Stop it, or set CODEFLOW_HOME to a different folder.`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(file); // synchronous, so it also works from an "exit" handler
    } catch {
      // already gone
    }
  };
  return release;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
