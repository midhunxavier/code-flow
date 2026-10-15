import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
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

let writeQueue: Promise<unknown> = mkdir(RUNS_DIR, { recursive: true }).catch(() => undefined);

/** Append a JSON line; writes are queued so each file's lines stay in order. */
export function appendLine(file: string, value: unknown) {
  const line = `${JSON.stringify(value)}\n`;
  writeQueue = writeQueue.then(() => appendFile(join(RUNS_DIR, file), line)).catch(() => undefined);
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
      // a torn last line from a crash; skip it
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
  const entries = await readJsonLines<{ key: string; value: unknown }>(`${runId}.journal.jsonl`);
  return new Map(entries.map((e) => [e.key, e.value]));
}

export function journalEntry(runId: string, key: string, value: unknown) {
  appendLine(`${runId}.journal.jsonl`, { key, value });
}
