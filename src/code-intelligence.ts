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

/** Isolated language service with a closed in-memory file host and hard resource limits. */
async function inspect(repo: string, request: Request, signal?: AbortSignal): Promise<CodeIntelligenceResult> {
  const release = await slots.acquire(signal);
  let worker: Worker | undefined;
  try {
    const root = await realpath(await repoRoot(repo));
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
    worker = new Worker(new URL("./code-intelligence-worker.mjs", import.meta.url), { workerData: { root, sources, request: operation }, resourceLimits: { maxOldGenerationSizeMb: CODE_INTELLIGENCE_LIMITS.memoryMb } });
    const result = await new Promise<Omit<CodeIntelligenceResult, "scanned">>((accept, reject) => {
      let received = false;
      const timer = setTimeout(() => reject(new Error("Language service inspection exceeded its time limit; narrow the repository or use declaration search")), CODE_INTELLIGENCE_LIMITS.timeoutMs);
      const abort = () => reject(new Error("Language service inspection cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      worker!.once("message", (message) => { received = true; cleanup(); message.error ? reject(new Error(message.error)) : accept(message); });
      worker!.once("error", (error) => { cleanup(); reject(new Error(`Language service failed within its resource boundary: ${error.message}`)); });
      worker!.once("exit", () => { cleanup(); if (!received) reject(new Error("Language service exited before returning its bounded result")); });
      if (signal?.aborted) abort();
    });
    return { ...result, scanned: sources.length, truncated: truncated || result.truncated };
  } finally { if (worker) await worker.terminate(); release(); }
}
export function searchSemanticSymbols(repo: string, query: string, signal?: AbortSignal) {
  if (typeof query !== "string" || !query.trim() || query.length > 300) throw new Error("Enter a symbol query of 1–300 characters");
  return inspect(repo, { kind: "symbols", query: query.trim() }, signal);
}
export function findCodeReferences(repo: string, input: { path: string; line: number; column: number }, signal?: AbortSignal) {
  if (!Number.isInteger(input.line) || input.line < 1 || !Number.isInteger(input.column) || input.column < 1) throw new Error("Reference lookup needs a one-based line and column");
  return inspect(repo, { kind: "references", file: input.path, line: input.line, column: input.column }, signal);
}
