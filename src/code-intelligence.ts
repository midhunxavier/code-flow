import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { git, repoRoot } from "./git.js";
import { readEditableFile, type CodeHit } from "./workspace.js";
import { assertContextPathAllowed } from "./context-inspection.js";
import { Slots } from "./slots.js";

const slots = new Slots(1);
export const CODE_INTELLIGENCE_LIMITS = { files: 500, bytes: 8 * 1024 * 1024, hits: 200, timeoutMs: 10_000, memoryMb: 192 };
export interface SymbolHit extends CodeHit { column: number; definition?: boolean; write?: boolean }
export interface CodeIntelligenceResult { hits: SymbolHit[]; scanned: number; truncated: boolean; engine: string; note: string }
type Request = { kind: "symbols"; query: string } | { kind: "references"; file: string; line: number; column: number };

interface WorkerEntry { worker: Worker; sources: Map<string, string>; idle?: ReturnType<typeof setTimeout> }
const pool = new Map<string, WorkerEntry>();
export const codeIntelligenceHealth = { requests: 0, reused: 0, failures: 0 };
export async function closeCodeIntelligence() { const entries = [...pool.values()]; pool.clear(); await Promise.all(entries.map(async (entry) => { clearTimeout(entry.idle); await entry.worker.terminate(); })); }
async function discard(root: string, entry: WorkerEntry) { clearTimeout(entry.idle); if (pool.get(root) === entry) pool.delete(root); await entry.worker.terminate(); }
async function workerFor(root: string): Promise<WorkerEntry> {
  const cached = pool.get(root);
  if (cached) { codeIntelligenceHealth.reused++; clearTimeout(cached.idle); pool.delete(root); pool.set(root, cached); cached.worker.ref(); return cached; }
  if (pool.size >= 2) { const [key, oldest] = pool.entries().next().value!; await discard(key, oldest); }
  const worker = new Worker(new URL("./code-intelligence-worker.mjs", import.meta.url), { workerData: { root }, resourceLimits: { maxOldGenerationSizeMb: CODE_INTELLIGENCE_LIMITS.memoryMb } });
  const entry: WorkerEntry = { worker, sources: new Map() }; pool.set(root, entry);
  worker.on("error", () => { codeIntelligenceHealth.failures++; if (pool.get(root) === entry) pool.delete(root); });
  worker.once("exit", () => { clearTimeout(entry.idle); if (pool.get(root) === entry) pool.delete(root); });
  return entry;
}

/** Isolated language service with a closed in-memory file host and hard resource limits. */
async function inspect(repo: string, request: Request, signal?: AbortSignal): Promise<CodeIntelligenceResult> {
  const release = await slots.acquire(signal);
  let entry: WorkerEntry | undefined, root = "", succeeded = false;
  codeIntelligenceHealth.requests++;
  try {
    root = await realpath(await repoRoot(repo));
    const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, { signal, timeoutMs: 10_000 });
    if (listed.code) throw new Error("Cannot list sources for the language service");
    const candidates = [...new Set(listed.stdout.split("\0").filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)(?:node_modules|vendor|dist|build|coverage|\.git)(\/|$)/.test(path)))].sort();
    const sources: { absolute: string; text: string }[] = []; let bytes = 0, truncated = false;
    for (const path of candidates) {
      signal?.throwIfAborted();
      if (sources.length >= CODE_INTELLIGENCE_LIMITS.files) { truncated = true; break; }
      try { assertContextPathAllowed(path); } catch { continue; }
      const file = await readEditableFile(root, path).catch(() => undefined);
      if (!file) continue;
      if (bytes + file.bytes > CODE_INTELLIGENCE_LIMITS.bytes) { truncated = true; break; }
      bytes += file.bytes; sources.push({ absolute: join(root, path), text: file.text });
    }
    const operation = request.kind === "references" ? { ...request, file: join(root, assertContextPathAllowed(request.file)) } : request;
    signal?.throwIfAborted();
    entry = await workerFor(root);
    const current = new Map(sources.map((file) => [file.absolute, file.text]));
    const changed = sources.filter((file) => entry!.sources.get(file.absolute) !== file.text);
    const removed = [...entry.sources.keys()].filter((name) => !current.has(name));
    const worker = entry.worker;
    const result = await new Promise<Omit<CodeIntelligenceResult, "scanned">>((accept, reject) => {
      const finish = (error?: Error, result?: Omit<CodeIntelligenceResult, "scanned">) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.off("message", message); worker.off("error", fail); worker.off("exit", exited); error ? reject(error) : accept(result!); };
      const abort = () => finish(new Error("Language service inspection cancelled"));
      const fail = (error: Error) => finish(error);
      const exited = () => finish(new Error("Language service exited before returning its bounded result"));
      const message = (value: any) => value.error ? finish(new Error(value.error)) : finish(undefined, value);
      const timer = setTimeout(() => finish(new Error("Language service inspection exceeded its time limit; narrow the repository")), CODE_INTELLIGENCE_LIMITS.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", message); worker.once("error", fail); worker.once("exit", exited);
      if (signal?.aborted) abort(); else worker.postMessage({ sources: changed, removed, request: operation });
    });
    entry.sources = current; succeeded = true;
    return { ...result, scanned: sources.length, truncated: truncated || result.truncated };
  } finally {
    if (entry) {
      if (!succeeded) await discard(root, entry);
      else { const cached = entry; entry.worker.unref(); entry.idle = setTimeout(() => void discard(root, cached), 60_000); entry.idle.unref(); }
    }
    release();
  }
}
export function searchSemanticSymbols(repo: string, query: string, signal?: AbortSignal) {
  if (typeof query !== "string" || !query.trim() || query.length > 300) throw new Error("Enter a symbol query of 1–300 characters");
  return inspect(repo, { kind: "symbols", query: query.trim() }, signal);
}
export function findCodeReferences(repo: string, input: { path: string; line: number; column: number }, signal?: AbortSignal) {
  if (!Number.isInteger(input.line) || input.line < 1 || !Number.isInteger(input.column) || input.column < 1) throw new Error("Reference lookup needs a one-based line and column");
  return inspect(repo, { kind: "references", file: input.path, line: input.line, column: input.column }, signal);
}
