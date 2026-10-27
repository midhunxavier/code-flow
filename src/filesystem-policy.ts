import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CODEFLOW_HOME } from "./config.js";
import { sensitiveContextPath, sensitiveDirectoryPath } from "./context-inspection.js";
import type { DiffFile } from "./ship.js";

export type FileOperation = "read" | "write";
export interface FileRules { allow: string[]; deny: string[] }
export interface FilePolicySnapshot { version: 1; projectId: string; revision: number; read: FileRules; write: FileRules; hash: string; updatedAt: number }
export class FilePolicyError extends Error { constructor(message: string, readonly status = 403, readonly current?: FilePolicySnapshot) { super(message); } }
type Activation = (commit: () => Promise<void>, next: FilePolicySnapshot, previous: FilePolicySnapshot) => Promise<void>;
const queues = new Map<string, Promise<unknown>>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function normalizePolicyPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500 || /[\\\x00-\x1f\x7f*?\[\]{}]/.test(raw) || raw.startsWith("/") || /^[a-z]:/i.test(raw)) throw new FilePolicyError("Policy paths must be literal relative repository paths", 400);
  if (raw === ".") return ".";
  const path = raw.replace(/\/$/, ""); if (!path || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new FilePolicyError("Paths must stay inside the repository; traversal, empty components and Git internals are not allowed", 400);
  return path;
}
function rules(raw: unknown): FileRules {
  if (!object(raw) || Object.keys(raw).some((key) => !["allow", "deny"].includes(key))) throw new FilePolicyError("Choose explicit allow and deny path lists", 400);
  const list = (value: unknown) => { if (!Array.isArray(value) || value.length > 100) throw new FilePolicyError("Use at most 100 literal paths per list", 400); return [...new Set(value.map(normalizePolicyPath))].sort(); };
  return { allow: list(raw.allow), deny: list(raw.deny) };
}
function snapshot(projectId: string, revision: number, read: FileRules, write: FileRules, updatedAt: number): FilePolicySnapshot { const base = { version: 1 as const, projectId, revision, read, write, updatedAt }; return { ...base, hash: sha(base) }; }
function defaults(projectId: string) { return snapshot(projectId, 0, { allow: ["."], deny: [] }, { allow: ["."], deny: [] }, 0); }
export function validateFilePolicySnapshot(raw: unknown): FilePolicySnapshot {
  if (!object(raw) || Object.keys(raw).some((key) => !["version", "projectId", "revision", "read", "write", "hash", "updatedAt"].includes(key)) || raw.version !== 1 || typeof raw.projectId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.projectId) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0) throw new FilePolicyError("Invalid filesystem policy snapshot", 503);
  const value = snapshot(raw.projectId, raw.revision as number, rules(raw.read), rules(raw.write), raw.updatedAt as number); if (value.hash !== raw.hash) throw new FilePolicyError("Filesystem policy snapshot hash changed", 503); return value;
}
const contains = (root: string, path: string) => root === "." || path === root || path.startsWith(`${root}/`);
// Conservative denial avoids case/canonical-Unicode bypasses on case-insensitive filesystems.
const folded = (path: string) => path.normalize("NFKC").toUpperCase().toLowerCase();
export function policyIsRestrictive(policy: FilePolicySnapshot): boolean { return ([policy.read, policy.write]).some((rules) => rules.allow.length !== 1 || rules.allow[0] !== "." || rules.deny.length > 0); }
export function allowsFilePolicy(policy: FilePolicySnapshot, operation: FileOperation, rawPath: string): boolean {
  let path: string; try { path = normalizePolicyPath(rawPath); } catch { return false; }
  if (path !== "." && sensitiveContextPath(path)) return false;
  const rules = policy[operation];
  return rules.allow.some((root) => contains(root, path)) && !rules.deny.some((root) => contains(folded(root), folded(path)));
}
/** Whether a folder may be walked to reach readable files. Only its rules and Git-internal/credential-store components count: the credential file-name pattern belongs to the files inside, which allowsFilePolicy checks one by one. */
export function allowsFilePolicyDirectory(policy: FilePolicySnapshot, rawPath: string): boolean {
  let path: string; try { path = normalizePolicyPath(rawPath); } catch { return false; }
  if (path !== "." && sensitiveDirectoryPath(path)) return false;
  return !policy.read.deny.some((root) => contains(folded(root), folded(path))) && policy.read.allow.some((root) => contains(root, path) || root.startsWith(`${path}/`));
}
export function assertPolicyExecution(policies: readonly FilePolicySnapshot[], surface: string) {
  const restricted = policies.filter(policyIsRestrictive); if (restricted.length) throw new FilePolicyError(`${surface} cannot enforce this project's filesystem restrictions. Host, native CLI, Docker and SSH execution remain disabled until an enforcing filtered backend is available. Review the policy deliberately before choosing unrestricted execution.`, 409);
}
export function filterPolicyDiff(policies: readonly FilePolicySnapshot[], files: readonly DiffFile[]): DiffFile[] { return files.filter((file) => policies.every((policy) => allowsFilePolicy(policy, "read", file.path) && (!file.oldPath || allowsFilePolicy(policy, "read", file.oldPath)))); }
let resolver: ((repo: string) => Promise<readonly FilePolicySnapshot[]>) | undefined;
let suppressRepositoryCommands: (() => boolean) | undefined;
export function configureFilePolicyResolver(next: (repo: string) => Promise<readonly FilePolicySnapshot[]>, options: { suppressRepositoryCommands?: () => boolean } = {}): () => void { resolver = next; suppressRepositoryCommands = options.suppressRepositoryCommands; return () => { if (resolver === next) { resolver = undefined; suppressRepositoryCommands = undefined; } }; }
export function filePolicyRegistryActive() { return !!resolver; }
export function filePolicyMetadataOnly() { return suppressRepositoryCommands?.() ?? false; }
export async function filterAllowedProjectEntries<T extends { path: string; type?: "file" | "dir" }>(repo: string, entries: T[]): Promise<T[]> {
  if (!resolver) return entries;
  const policies = await resolver(repo);
  return entries.filter((entry) => !sensitiveContextPath(entry.path) && policies.every((policy) => allowsFilePolicy(policy, "read", entry.path) || entry.type === "dir" && policy.read.allow.some((root) => root.startsWith(`${entry.path}/`)) && !policy.read.deny.some((root) => contains(folded(root), folded(entry.path)))));
}
async function assertNoSymbolicAncestor(repo: string, path: string) {
  const root = await realpath(repo); let target = root;
  for (const part of path === "." ? [] : path.split("/")) { target = join(target, part); let info; try { info = await lstat(target); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; } if (info.isSymbolicLink()) throw new FilePolicyError("Symbolic paths cannot bypass filesystem policy"); }
}
export async function assertProjectFileAccess(repo: string, rawPath: string, operation: FileOperation): Promise<void> {
  if (!resolver) return;
  const path = normalizePolicyPath(rawPath), policies = await resolver(repo);
  if (path !== "." && sensitiveContextPath(path) || policies.some((policy) => !allowsFilePolicy(policy, operation, path))) throw new FilePolicyError(`This project's filesystem policy denies ${operation} access to this path`);
  await assertNoSymbolicAncestor(repo, path);
}
export async function assertProjectDirectoryAccess(repo: string, rawPath: string): Promise<void> {
  if (!resolver) return;
  const path = normalizePolicyPath(rawPath), policies = await resolver(repo);
  const traversable = (policy: FilePolicySnapshot) => !policy.read.deny.some((root) => contains(folded(root), folded(path))) && (allowsFilePolicy(policy, "read", path) || policy.read.allow.some((root) => path === "." || root.startsWith(`${path}/`)));
  if (path !== "." && sensitiveContextPath(path) || policies.some((policy) => !traversable(policy))) throw new FilePolicyError("This project's filesystem policy denies directory access to this path");
  await assertNoSymbolicAncestor(repo, path);
}

/** Revision/hash snapshots can be pinned to runs. Tightening never weakens a pinned policy. */
export class ProjectFilePolicies {
  private listeners = new Set<(next: FilePolicySnapshot, previous: FilePolicySnapshot) => void>();
  constructor(private readonly home = CODEFLOW_HOME) {}
  private path(projectId: string) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)) throw new FilePolicyError("Invalid project identity", 400); return resolve(this.home, "filesystem-policies", `${projectId}.json`); }
  onChange(listener: (next: FilePolicySnapshot, previous: FilePolicySnapshot) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async get(projectId: string): Promise<FilePolicySnapshot> { return this.read(projectId, this.path(projectId)); }
  /** The saved snapshot when `input` names its revision and the same rules: saving it again would change nothing. */
  async unchanged(projectId: string, input: { revision: unknown; read: unknown; write: unknown }): Promise<FilePolicySnapshot | undefined> {
    const previous = await this.get(projectId);
    if (input.revision !== previous.revision) return undefined;
    try { return sha([rules(input.read), rules(input.write)]) === sha([previous.read, previous.write]) ? previous : undefined; } catch { return undefined; }
  }
  async set(projectId: string, input: { revision: unknown; read: unknown; write: unknown }, activate: Activation = async (commit) => commit()): Promise<FilePolicySnapshot> {
    const file = this.path(projectId);
    const work = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await this.read(projectId, file);
      if (!Number.isSafeInteger(input.revision) || input.revision !== previous.revision) throw new FilePolicyError("Filesystem policy changed; reload before saving", 409, previous);
      const next = snapshot(projectId, previous.revision + 1, rules(input.read), rules(input.write), Date.now()); let committed = false;
      await activate(async () => {
        if (committed) throw new FilePolicyError("Policy activation may commit only once", 409);
        const latest = await this.read(projectId, file); if (latest.hash !== previous.hash) throw new FilePolicyError("Filesystem policy changed during activation", 409, latest);
        await this.write(file, next); committed = true;
        for (const listener of this.listeners) { try { listener(structuredClone(next), structuredClone(previous)); } catch { /* Authorization observers cannot undo durable activation. */ } }
      }, structuredClone(next), structuredClone(previous));
      if (!committed) throw new FilePolicyError("Filesystem policy was not activated", 409);
      return structuredClone(next);
    }); queues.set(file, work); try { return await work; } finally { if (queues.get(file) === work) queues.delete(file); }
  }
  private async read(projectId: string, file: string): Promise<FilePolicySnapshot> {
    try {
      await this.safeParent(file); const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const info = await handle.stat(); if (!info.isFile() || info.size > 256 * 1024) throw new Error("Policy must be a bounded regular file"); const raw: unknown = JSON.parse(await handle.readFile("utf8")); if (!object(raw) || Object.keys(raw).some((key) => !["version", "projectId", "revision", "read", "write", "hash", "updatedAt"].includes(key)) || raw.version !== 1 || raw.projectId !== projectId || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || !Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0) throw new Error("Invalid policy version or metadata"); const value = snapshot(projectId, raw.revision as number, rules(raw.read), rules(raw.write), raw.updatedAt as number); if (raw.hash !== value.hash) throw new Error("Policy content hash changed"); return value; }
      finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(projectId); throw new FilePolicyError(`Filesystem policy cannot be read; restricted operations are unavailable: ${(error as Error).message}`, 503); }
  }
  private async safeParent(file: string) { const parent = dirname(file); let info; try { info = await lstat(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Policy storage cannot be a symbolic directory"); }
  private async write(file: string, value: FilePolicySnapshot) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await this.safeParent(file); const temp = `${file}.${randomUUID()}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } await rename(temp, file); if (process.platform !== "win32") { const parent = await open(dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); } } }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
}
