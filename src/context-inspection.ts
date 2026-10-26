import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { git, repoRoot, resolveCommit } from "./git.js";
import { normalizeRepoPath } from "./repo-tree.js";
import { childEnv } from "./env.js";
import { redactText } from "./privacy.js";
import { validateContextBudget, type ContextBudget } from "./context-budget.js";
export { validateContextBudget, type ContextBudget } from "./context-budget.js";
import { sensitiveContextPath } from "./sensitive-paths.js";
export { sensitiveContextPath, sensitiveDirectoryPath } from "./sensitive-paths.js";
export const CONTEXT_INSPECTION_LIMITS = { selections: 50, files: 200, scanned: 5000, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024, previewCharacters: 3000 };
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export class ContextInspectionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

/** Shared by preview and actual context preparation; credential selections are never staged. */
export function assertContextPathAllowed(raw: string): string {
  if (typeof raw !== "string" || isAbsolute(raw) || /^[a-z]:/i.test(raw) || /[\x00-\x1f]/.test(raw) || raw.length > 1000) throw new ContextInspectionError("Context paths must stay inside the repository.");
  const path = normalizeRepoPath(raw);
  if (!path) throw new ContextInspectionError("Select a repository file or folder.");
  if (sensitiveContextPath(path)) throw new ContextInspectionError(`Potential credential or Git-internal path is not allowed as explicit context: ${path}`);
  return path;
}
export async function assertNoContextSymlinks(repo: string, path: string, baseRef?: string): Promise<void> {
  const root = await realpath(repo); let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) break;
    if (info.isSymbolicLink()) throw new ContextInspectionError(`Symbolic context paths are refused: ${path}`);
  }
  if (baseRef) { const mode = await git(["--literal-pathspecs", "ls-tree", "--format=%(objectmode)", baseRef, "--", path], root, { timeoutMs: 10000 }); if (mode.code !== 0) throw new ContextInspectionError("Cannot validate the selected base context path."); if (/^(?:120000|160000)$/m.test(mode.stdout.trim())) throw new ContextInspectionError(`Symbolic links and submodules are refused as explicit context: ${path}`); }
}
export interface InspectedContextFile { path: string; source: "working-copy" | "base-ref"; selectedBy: string; bytes?: number; approximateTokens?: number; hash?: string; preview?: string; redacted?: boolean; truncated?: boolean; sensitive?: boolean; omitted?: string }
export interface ContextInspection { inspectedAt: number; baseRef: string; files: InspectedContextFile[]; attachments: { name: string; bytes: number; approximateTokens?: number; omitted?: string }[]; fileBytes: number; omittedBytes: number; attachmentBytes: number; bytes: number; approximateTokens: number; unknownTokenAttachments: number; truncated: boolean; scanned: number; note: string }
interface TreeObject { path: string; mode: string; type: string; object: string; bytes: number }
const treeObjects = (text: string): TreeObject[] => text.split("\0").filter(Boolean).map((record) => { const tab = record.indexOf("\t"); const [mode, type, object, size] = record.slice(0, tab).split(/\s+/); return { path: record.slice(tab + 1), mode: mode!, type: type!, object: object!, bytes: Number(size) }; });
function gitBlob(repo: string, object: string, signal?: AbortSignal): Promise<Buffer> {
  if (!/^[a-f0-9]{40,64}$/.test(object)) return Promise.reject(new ContextInspectionError("Invalid context object."));
  return new Promise((resolve, reject) => execFile("git", ["cat-file", "blob", object], { cwd: repo, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }), timeout: 10000, maxBuffer: CONTEXT_INSPECTION_LIMITS.fileBytes + 1, encoding: "buffer", signal }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function workingFile(repo: string, path: string): Promise<Buffer | undefined> {
  await assertNoContextSymlinks(repo, path);
  const handle = await open(join(repo, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!handle) return undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ContextInspectionError("Not a regular text file.");
    if (before.size > CONTEXT_INSPECTION_LIMITS.fileBytes) throw new ContextInspectionError("File exceeds the 512 KiB inspection limit.");
    const buffer = Buffer.alloc(before.size); let offset = 0;
    while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new ContextInspectionError("File changed while being inspected. Inspect again.", 409);
    return buffer;
  } finally { await handle.close(); }
}
export async function inspectContext(input: { repo: string; baseRef?: string; paths: string[]; attachments?: { name: string; size: number }[]; signal?: AbortSignal }): Promise<ContextInspection> {
  if (!Array.isArray(input.paths) || input.paths.length > CONTEXT_INSPECTION_LIMITS.selections || input.paths.some((path) => typeof path !== "string")) throw new ContextInspectionError("Choose at most 50 repository context selections.");
  const repo = await realpath(await repoRoot(input.repo)); const baseRef = await resolveCommit(repo, input.baseRef || "HEAD");
  const files: InspectedContextFile[] = []; const seen = new Set<string>(); let fileBytes = 0; let scanned = 0; let truncated = false;
  const add = async (path: string, selectedBy: string, source: InspectedContextFile["source"], object?: TreeObject) => {
    if (seen.has(path)) return; seen.add(path); scanned++;
    if (files.length >= CONTEXT_INSPECTION_LIMITS.files || scanned > CONTEXT_INSPECTION_LIMITS.scanned) { truncated = true; return; }
    const result: InspectedContextFile = { path, selectedBy, source };
    if (sensitiveContextPath(path)) { files.push({ ...result, sensitive: true, omitted: "Potential credential or Git-internal file; not included in the preview." }); return; }
    try {
      assertContextPathAllowed(path); await assertNoContextSymlinks(repo, path);
      if (object && Number.isFinite(object.bytes) && object.bytes >= 0) result.bytes = object.bytes;
      if (source === "working-copy") { const info = await lstat(join(repo, path)).catch(() => undefined); if (info?.isFile()) result.bytes = info.size; }
      if (object && (object.type !== "blob" || object.mode === "120000")) throw new ContextInspectionError("Symbolic links and submodules are not inspected.");
      if (object && object.bytes > CONTEXT_INSPECTION_LIMITS.fileBytes) throw new ContextInspectionError("File exceeds the 512 KiB inspection limit.");
      const local = source === "working-copy" ? await workingFile(repo, path) : undefined;
      const buffer = local ?? (object ? await gitBlob(repo, object.object, input.signal) : undefined);
      if (!local && object) result.source = "base-ref";
      if (!buffer) throw new ContextInspectionError("File was not found in the working copy or selected base.");
      if (fileBytes + buffer.length > CONTEXT_INSPECTION_LIMITS.totalBytes) { truncated = true; throw new ContextInspectionError("Aggregate file inspection exceeds 8 MiB."); }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (text.includes("\0")) throw new ContextInspectionError("Binary file; token and text previews are unavailable.");
      if (text.startsWith("version https://git-lfs.github.com/spec/v1")) throw new ContextInspectionError("Git LFS pointer; materialized file contents are not included in this estimate.");
      const preview = redactText(text.slice(0, CONTEXT_INSPECTION_LIMITS.previewCharacters));
      fileBytes += buffer.length;
      files.push({ ...result, bytes: buffer.length, approximateTokens: Math.ceil(buffer.length / 4), hash: hash(buffer), preview, redacted: preview !== text.slice(0, CONTEXT_INSPECTION_LIMITS.previewCharacters), truncated: text.length > CONTEXT_INSPECTION_LIMITS.previewCharacters });
    } catch (error) { files.push({ ...result, omitted: error instanceof TypeError ? "Binary or invalid UTF-8 file; no text preview." : (error as Error).message }); }
  };
  for (const raw of input.paths) {
    if (input.signal?.aborted) throw new ContextInspectionError("Context inspection cancelled.", 409);
    let path: string;
    try { path = assertContextPathAllowed(raw); await assertNoContextSymlinks(repo, path); }
    catch (error) { if (files.length < CONTEXT_INSPECTION_LIMITS.files) files.push({ path: raw, selectedBy: raw, source: "working-copy", sensitive: sensitiveContextPath(raw), omitted: (error as Error).message }); continue; }
    const exact = await git(["--literal-pathspecs", "ls-tree", "-l", "-z", baseRef, "--", path], repo, { timeoutMs: 10000, signal: input.signal });
    if (exact.code !== 0) throw new ContextInspectionError("Cannot inspect the selected base tree.");
    const entry = treeObjects(exact.stdout).find((entry) => entry.path === path);
    if (entry?.type === "tree") {
      const listing = await git(["--literal-pathspecs", "ls-tree", "-r", "-l", "-z", baseRef, "--", path], repo, { timeoutMs: 10000, signal: input.signal });
      if (listing.code !== 0) throw new ContextInspectionError("Cannot expand the selected context directory.");
      const entries = treeObjects(listing.stdout);
      for (const file of entries.slice(0, CONTEXT_INSPECTION_LIMITS.scanned)) { if (files.length >= CONTEXT_INSPECTION_LIMITS.files) { truncated = true; break; } await add(file.path, path, "base-ref", file); }
      if (entries.length > CONTEXT_INSPECTION_LIMITS.scanned) truncated = true;
    } else await add(path, path, "working-copy", entry);
  }
  const rawAttachments = input.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 20 || rawAttachments.some((entry) => !entry || typeof entry.name !== "string" || entry.name.length > 500 || /[\x00-\x1f]/.test(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 10 * 1024 * 1024)) throw new ContextInspectionError("Attachment metadata must describe at most 20 files of up to 10 MiB each.");
  const attachments: ContextInspection["attachments"] = rawAttachments.map((entry) => ({ name: entry.name, bytes: entry.size, ...(sensitiveContextPath(basename(entry.name)) ? { omitted: "Potential credential attachment; actual dispatch rejects this selection." } : /\.(?:txt|md|json|csv|ya?ml|[cm]?[jt]sx?|py|go|rs|html|css|xml|toml)$/i.test(entry.name) ? { approximateTokens: Math.ceil(entry.size / 4) } : {}) }));
  const attachmentBytes = attachments.reduce((sum, entry) => sum + entry.bytes, 0); if (attachmentBytes > 25 * 1024 * 1024) throw new ContextInspectionError("Attachment metadata exceeds the 25 MiB context limit.");
  const omittedBytes = files.reduce((sum, file) => sum + (file.omitted ? file.bytes ?? 0 : 0), 0);
  return { inspectedAt: Date.now(), baseRef, files, attachments, fileBytes, omittedBytes, attachmentBytes, bytes: fileBytes + omittedBytes + attachmentBytes, approximateTokens: files.reduce((sum, file) => sum + (file.approximateTokens ?? 0), 0) + attachments.reduce((sum, entry) => sum + (entry.approximateTokens ?? 0), 0), unknownTokenAttachments: attachments.filter((entry) => entry.approximateTokens === undefined).length, truncated, scanned, note: "Folders expand committed base files only. Explicit files show current copies; local files missing from the base need individual selection. Reference contents are not pasted into prompts. Byte totals include known omitted-file sizes; unscanned files remain unknown. Token estimates cover known text only; hidden CLI history/system prompts, later file reads and image tokens are excluded." };
}

export interface PromptContextEvidence { scope: "assembled-invocation-input"; measuredAt: number; promptBytes: number; schemaBytes: number; bytes: number; approximateTokens: number; hash: string; resumed: boolean; excluded: string[]; policy?: ContextBudget["policy"]; exceeded: boolean; violations: { limit: "maxPromptBytes" | "maxApproximateTokens"; actual: number; ceiling: number }[] }
export class ContextBudgetError extends Error { constructor(readonly evidence: PromptContextEvidence) { super(`Explicit invocation context exceeds its configured budget: ${evidence.violations.map((entry) => `${entry.limit} ${entry.actual.toLocaleString()} > ${entry.ceiling.toLocaleString()}`).join("; ")}. Hidden provider context is not included in this measurement.`); this.name = "ContextBudgetError"; } }
export function measurePromptContext(input: { prompt: string; jsonSchema?: object; resumeSessionId?: string }, rawBudget?: ContextBudget): PromptContextEvidence {
  if (typeof input.prompt !== "string") throw new ContextInspectionError("Measure the assembled invocation prompt text.");
  const budget = validateContextBudget(rawBudget); const schema = input.jsonSchema === undefined ? "" : JSON.stringify(input.jsonSchema); const promptBytes = Buffer.byteLength(input.prompt); const schemaBytes = Buffer.byteLength(schema); const bytes = promptBytes + schemaBytes; const approximateTokens = Math.ceil(bytes / 4);
  const violations: PromptContextEvidence["violations"] = [];
  if (budget?.maxPromptBytes !== undefined && bytes > budget.maxPromptBytes) violations.push({ limit: "maxPromptBytes", actual: bytes, ceiling: budget.maxPromptBytes });
  if (budget?.maxApproximateTokens !== undefined && approximateTokens > budget.maxApproximateTokens) violations.push({ limit: "maxApproximateTokens", actual: approximateTokens, ceiling: budget.maxApproximateTokens });
  return { scope: "assembled-invocation-input", measuredAt: Date.now(), promptBytes, schemaBytes, bytes, approximateTokens, hash: hash(JSON.stringify([input.prompt, schema])), resumed: !!input.resumeSessionId, excluded: ["CLI system instructions", "Earlier conversation history", "Tool output and later file reads", "Image/audio tokenization", "Provider transport wrappers"], ...(budget ? { policy: budget.policy } : {}), exceeded: !!violations.length, violations };
}
export function enforceContextBudget(input: { prompt: string; jsonSchema?: object; resumeSessionId?: string }, budget?: ContextBudget): PromptContextEvidence { const evidence = measurePromptContext(input, budget); if (evidence.exceeded && evidence.policy === "block") throw new ContextBudgetError(evidence); return evidence; }
