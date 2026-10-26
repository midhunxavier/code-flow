import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CODEFLOW_HOME, WORKTREE_DIR } from "./config.js";
import { acquireLock, acquireStateLock } from "./store.js";
import { git } from "./git.js";
import { readOnlyGitMetadata } from "./agent-container.js";
import { MemoryStore, validateDocument, type MemoryMaintenanceEntry, type MemoryRef } from "./memory.js";
import { validateDeferredDocument } from "./deferred-runs.js";
import { validateCodeHostDocument } from "./code-hosts.js";
import { validateCoordinationDocument } from "./repo-coordination.js";
import { StrictRunLogReader } from "./run-log.js";

export type RetentionKind = "archivedRuns" | "attachments" | "memory" | "worktrees";
export interface RetentionPolicy { version: 1; revision: number; days: Record<RetentionKind, number | null>; keepRunIds: string[]; keepMemoryIds: string[] }
export interface RetentionFile { path: string; bytes: number; fingerprint: string }
export interface RetentionTarget { id: string; kind: RetentionKind; runId: string; path?: string; repo?: string; branch?: string; memory?: MemoryRef; files?: RetentionFile[]; fingerprint: string; bytes: number; detail: string }
export interface RetentionPreview {
  version: 1; home: string; createdAt: number; expiresAt: number; policyRevision: number; policy: RetentionPolicy;
  cutoffs: Record<RetentionKind, number | null>; targets: RetentionTarget[];
  protected: { kind: RetentionKind; id: string; reason: string }[];
  sources: Record<string, string>; truncated: boolean; fingerprint: string;
  summary: { archivedRuns: number; attachments: number; memory: number; worktrees: number; bytes: number };
}
export class RetentionPolicyConflictError extends Error { readonly status = 409; constructor(readonly current: RetentionPolicy) { super("Retention settings changed. Reload before saving."); } }
export const RETENTION_LIMITS = { runs: 2000, memory: 50_000, targets: 1000, files: 100_000, readBytes: 256 * 1024 * 1024, logBytes: 64 * 1024 * 1024, planAgeMs: 24 * 60 * 60_000 };
const KINDS: RetentionKind[] = ["archivedRuns", "attachments", "memory", "worktrees"];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: any) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
const inside = (parent: string, path: string) => { const rel = relative(parent, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const policyQueues = new Map<string, Promise<unknown>>();
const defaults = (): RetentionPolicy => ({ version: 1, revision: 0, days: { archivedRuns: null, attachments: null, memory: null, worktrees: null }, keepRunIds: [], keepMemoryIds: [] });
function validatePolicy(value: unknown, revision: number): RetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose valid retention settings");
  const raw = value as Record<string, any>;
  if (Object.keys(raw).some((key) => !["version", "revision", "days", "keepRunIds", "keepMemoryIds"].includes(key)) || !raw.days || typeof raw.days !== "object" || Array.isArray(raw.days) || Object.keys(raw.days).some((key) => !KINDS.includes(key as RetentionKind))) throw new Error("Unsupported retention policy fields");
  const result = defaults(); result.revision = revision;
  for (const kind of KINDS) { const days = raw.days[kind]; if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) throw new Error("Retention days must be 1–36,500, or null to keep that data"); result.days[kind] = days; }
  for (const field of ["keepRunIds", "keepMemoryIds"] as const) { if (!Array.isArray(raw[field]) || raw[field].length > 1000 || raw[field].some((id: unknown) => !validId(id))) throw new Error(`Choose at most 1,000 valid ${field}`); result[field] = [...new Set<string>(raw[field])].sort(); }
  return result;
}
async function atomicJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true }); await safeParents(file); const temp = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); } await rename(temp, file); if (process.platform !== "win32") { const folder = await open(dirname(file), "r"); try { await folder.sync(); } finally { await folder.close(); } } }
  finally { await rm(temp, { force: true }); }
}
export class RetentionPolicyStore {
  readonly file: string;
  constructor(file = join(CODEFLOW_HOME, "retention-policy.json")) { this.file = resolve(file); }
  async get(): Promise<RetentionPolicy> { await policyQueues.get(this.file); return readPolicy(this.file); }
  set(value: unknown, expectedRevision: number): Promise<RetentionPolicy> {
    const work = (policyQueues.get(this.file) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(this.file), { recursive: true }); await safeParents(this.file);
      const release = await acquireStateLock(`${this.file}.lock`, 5000, () => "Retention settings are being saved by another process. Retry after it finishes.");
      try { const previous = await readPolicy(this.file); if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== previous.revision) throw new RetentionPolicyConflictError(previous); const next = validatePolicy(value, previous.revision + 1); await atomicJson(this.file, next); return structuredClone(next); }
      finally { release(); }
    });
    const tail = work.then(() => undefined, () => undefined); policyQueues.set(this.file, tail); void tail.then(() => { if (policyQueues.get(this.file) === tail) policyQueues.delete(this.file); }); return work;
  }
}
async function readPolicy(file: string): Promise<RetentionPolicy> {
  try {
    await safeParents(file); const info = await lstat(file, { bigint: true }); if (!info.isFile() || info.size > BigInt(512 * 1024)) throw new Error("Policy must be a regular file under 512 KiB");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const before = await handle.stat({ bigint: true }); if (identity(before) !== identity(info)) throw new Error("Policy changed during inspection"); const bytes = await handle.readFile(); if (identity(before) !== identity(await handle.stat({ bigint: true })) || bytes.length !== Number(before.size)) throw new Error("Policy changed during inspection"); const raw = JSON.parse(bytes.toString("utf8")); if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error("Unsupported retention policy version"); return validatePolicy(raw, raw.revision); }
    finally { await handle.close(); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(); throw new Error(`Retention policy cannot be read: ${retentionError(error)}`); }
}


function retentionError(error: unknown): string {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOENT": return "Data is no longer available. Refresh the retention preview.";
    case "EACCES": case "EPERM": return "Code-flow cannot inspect this data with its current permissions.";
    case "ENOTDIR": case "ELOOP": return "A data path is not a regular directory or contains a symbolic link.";
    default: return error instanceof Error ? error.message : "Data could not be inspected.";
  }
}

interface Budget { files: number; bytes: number }
interface RunRecord { run: Record<string, any>; log: RetentionFile; mtime: number }
const exists = async (path: string) => lstat(path).then((info) => info, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
async function safeParents(path: string) {
  for (let folder = dirname(path); ; folder = dirname(folder)) { const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A destination ancestor is a symbolic link or not a directory"); if (folder === dirname(folder)) break; }
}
function identity(info: import("node:fs").BigIntStats) { return [String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)].join(":"); }
async function readFingerprint(path: string, budget: Budget, maximum = RETENTION_LIMITS.logBytes): Promise<{ file: RetentionFile; text: string; mtime: number }> {
  await safeParents(path); const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maximum)) throw new Error("Only bounded regular files without symbolic links can be retained");
  if (++budget.files > RETENTION_LIMITS.files || budget.bytes + Number(info.size) > RETENTION_LIMITS.readBytes) throw new Error("Retention scan reached its file or byte limit");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const before = await handle.stat({ bigint: true }); if (identity(before) !== identity(info)) throw new Error("File changed during retention inspection"); const bytes = await handle.readFile(); budget.bytes += bytes.length; const after = await handle.stat({ bigint: true }); if (identity(before) !== identity(after) || bytes.length !== Number(before.size)) throw new Error("File changed during retention inspection"); return { file: { path, bytes: bytes.length, fingerprint: sha(identity(before) + ":" + sha(bytes)) }, text: bytes.toString("utf8"), mtime: Number(before.mtimeMs) }; }
  finally { await handle.close(); }
}
async function inventory(path: string, budget: Budget): Promise<{ fingerprint: string; bytes: number; newest: number }> {
  await safeParents(path); const root = await lstat(path, { bigint: true }); if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Workspace must be a regular directory without symbolic links");
  const items: string[] = []; let bytes = 0, newest = 0;
  const walk = async (folder: string) => {
    const before = await lstat(folder, { bigint: true }); items.push(`${relative(path, folder)}:${identity(before)}`); newest = Math.max(newest, Number(before.mtimeMs));
    for (const name of (await readdir(folder)).sort()) {
      const file = join(folder, name), info = await lstat(file, { bigint: true }); if (++budget.files > RETENTION_LIMITS.files) throw new Error("Retention scan reached its file limit");
      if (name === ".git" && file !== join(path, ".git")) throw new Error("A nested Git repository or submodule protects this workspace");
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) { items.push(`${relative(path, file)}:${identity(info)}`); bytes += Number(info.size); newest = Math.max(newest, Number(info.mtimeMs)); }
      else if (info.isSymbolicLink()) items.push(`${relative(path, file)}:${identity(info)}:link:${await readlink(file)}`);
      else throw new Error("A special file protects this workspace");
    }
    if (identity(before) !== identity(await lstat(folder, { bigint: true }))) throw new Error("Workspace changed during retention inspection");
  };
  await walk(path); return { fingerprint: sha(items.join("\n")), bytes, newest };
}
async function runRecord(home: string, id: string, budget: Budget): Promise<RunRecord> {
  const log = await readFingerprint(join(home, "runs", `${id}.jsonl`), budget);
  if (!log.text.endsWith("\n")) throw new Error("Incomplete run log; recovery may still need its sources");
  let run: Record<string, any> | undefined;
  const reader = new StrictRunLogReader(id);
  for (let start = 0; start < log.text.length;) {
    const end = log.text.indexOf("\n", start), line = log.text.slice(start, end < 0 ? log.text.length : end); start = end < 0 ? log.text.length : end + 1;
    if (!line.trim()) continue;
    const value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run event");
    const event = reader.decode(value); if (event?.type === "run") run = event.run;
  }
  if (!run) throw new Error("No authoritative run snapshot"); return { run, log: log.file, mtime: log.mtime };
}
async function managedRoot(run: Record<string, any>): Promise<string | undefined> {
  if (!validId(run.id) || typeof run.repo !== "string" || !isAbsolute(run.repo) || typeof run.worktreeDir !== "string") throw new Error("Managed workspace ownership is unavailable");
  const repo = await realpath(run.repo), expected = resolve(repo, WORKTREE_DIR, run.id);
  if (resolve(run.worktreeDir) !== expected) throw new Error("Recorded workspace is outside its managed run directory");
  await safeParents(join(repo, WORKTREE_DIR));
  const parent = await exists(dirname(expected));
  if (!parent) return undefined;
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Managed workspace parent is a symbolic link or not a directory");
  const info = await exists(expected);
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed run directory is not a regular directory");
  return expected;
}
function terminal(run: Record<string, any>) { return ["done", "failed", "cancelled"].includes(run.status) && run.archived === true && !run.pinned && !run.retentionPinned && !run.retention?.pinned && !run.followUps?.some((follow: any) => ["pending", "running"].includes(follow.status)) && !Object.values(run.watches ?? {}).some((watch: any) => !["closed", "stopped"].includes(watch.state)); }
function memoryReferences(run: Record<string, any>): string[] {
  return [...(run.memoryManifest?.included ?? []).map((ref: MemoryRef) => ref.id), ...(run.team?.contextManifests ?? []).flatMap((manifest: any) => (manifest.memoryIds ?? []).map((id: string) => String(id).split("@")[0]!))];
}

/** Read-only online preview. No deleted bodies or private text enter the returned manifest. */
export async function previewRetention(input: { home: string; now?: number }): Promise<RetentionPreview> {
  const homeInfo = await lstat(input.home); if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error("Choose a regular application data directory");
  const home = await realpath(input.home), now = input.now ?? Date.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid retention preview time");
  const policy = await new RetentionPolicyStore(join(home, "retention-policy.json")).get();
  const cutoffs = Object.fromEntries(KINDS.map((kind) => [kind, policy.days[kind] === null ? null : now - policy.days[kind]! * 86400000])) as RetentionPreview["cutoffs"];
  const plan: RetentionPreview = { version: 1, home, createdAt: now, expiresAt: now + RETENTION_LIMITS.planAgeMs, policyRevision: policy.revision, policy, cutoffs, targets: [], protected: [], sources: {}, truncated: false, fingerprint: "", summary: { archivedRuns: 0, attachments: 0, memory: 0, worktrees: 0, bytes: 0 } };
  const budget: Budget = { files: 0, bytes: 0 }, records = new Map<string, RunRecord>(), heldRuns = new Map<string, string>(), heldMemory = new Map<string, string>();
  const protect = (kind: RetentionKind, id: string, reason: string) => { if (plan.protected.length < 5000) plan.protected.push({ kind, id, reason: reason.slice(0, 500) }); };
  const incomplete = (kind: RetentionKind, id: string, error: unknown) => { plan.truncated = true; protect(kind, id, retentionError(error)); };
  const target = (value: RetentionTarget) => { if (plan.targets.length >= RETENTION_LIMITS.targets) { plan.truncated = true; protect(value.kind, value.id, "Retention target limit reached"); } else plan.targets.push(value); };
  const runDirectory = await exists(join(home, "runs"));
  if (runDirectory) {
    if (!runDirectory.isDirectory() || runDirectory.isSymbolicLink()) throw new Error("Run storage must be a regular directory without a symbolic link");
    const files = (await readdir(join(home, "runs"))).filter((file) => file.endsWith(".jsonl") && !file.endsWith(".journal.jsonl")).sort();
    if (files.length > RETENTION_LIMITS.runs) plan.truncated = true;
    plan.sources["run-directory"] = sha(files.join("\n"));
    for (const file of files.slice(0, RETENTION_LIMITS.runs)) {
      const id = file.slice(0, -6); if (!validId(id)) { incomplete("archivedRuns", id, new Error("Invalid run log name")); continue; }
      try { const record = await runRecord(home, id, budget); records.set(id, record); plan.sources[record.log.path] = record.log.fingerprint; }
      catch (error) { incomplete("archivedRuns", id, error); }
    }
  }
  let memory: MemoryMaintenanceEntry[] = [];
  try {
    const file = join(home, "memory.sqlite"), legacy = join(home, "memory.json");
    if (await exists(file)) {
      const before = (await readFingerprint(file, budget)).file.fingerprint;
      memory = await new MemoryStore(file).maintenanceEntries();
      const after = (await readFingerprint(file, budget)).file.fingerprint;
      if (before !== after) throw new Error("Memory changed during retention inspection");
      plan.sources[file] = after;
    } else if (await exists(legacy)) {
      // Preview remains read-only for users who have not yet migrated.
      const data = await readFingerprint(legacy, budget, 32 * 1024 * 1024);
      plan.sources[legacy] = data.file.fingerprint;
      memory = validateDocument(data.text).entries;
    }
    memory = memory.filter((entry) => entry.status !== "deleted");
    if (memory.length > RETENTION_LIMITS.memory) { plan.truncated = true; memory = memory.slice(0, RETENTION_LIMITS.memory); }
  } catch (error) { incomplete("memory", "memory-store", error); }
  for (const id of policy.keepRunIds) heldRuns.set(id, "Kept by the saved retention policy");
  for (const id of policy.keepMemoryIds) heldMemory.set(id, "Kept by the saved retention policy");
  for (const { run } of records.values()) {
    if (run.parentRunId) heldRuns.set(run.parentRunId, `Source of retained child run ${run.id}`);
    if (run.teamRerun?.parentRunId) heldRuns.set(run.teamRerun.parentRunId, `Pinned baseline for retained rerun ${run.id}`);
    if (!terminal(run) || policy.keepRunIds.includes(run.id)) for (const id of memoryReferences(run)) heldMemory.set(id, `Referenced by active, resumable or kept run ${run.id}`);
  }
  for (const entry of memory) for (const source of entry.derivedFrom) heldMemory.set(source.id, `Provenance source for retained memory ${entry.id}`);
  try {
    const file = join(home, "deferred-runs.json"); if (await exists(file)) { const data = await readFingerprint(file, budget, 32 * 1024 * 1024); plan.sources[file] = data.file.fingerprint; for (const job of validateDeferredDocument(JSON.parse(data.text)).jobs) if (["queued", "waiting-time", "waiting-provider", "claimed", "unknown"].includes(job.status) && job.run.parentRunId) heldRuns.set(job.run.parentRunId, `Source of pending deferred job ${job.id}`); }
    const triggerFile = join(home, "triggers.json"); if (await exists(triggerFile)) { const data = await readFingerprint(triggerFile, budget, 16 * 1024 * 1024); plan.sources[triggerFile] = data.file.fingerprint; const triggers = JSON.parse(data.text); if (!Array.isArray(triggers)) throw new Error("Invalid automation settings"); for (const trigger of triggers) if (trigger?.enabled && typeof trigger.run?.parentRunId === "string") heldRuns.set(trigger.run.parentRunId, "Source of an enabled automation"); }
    const coordinationFile = join(home, "coordinated-changes.json"); if (await exists(coordinationFile)) { const data = await readFingerprint(coordinationFile, budget, 32 * 1024 * 1024); plan.sources[coordinationFile] = data.file.fingerprint; for (const job of validateCoordinationDocument(JSON.parse(data.text)).jobs) for (const node of job.nodes) for (const runId of [node.runId, node.result?.runId, ...(node.dependencies ?? []).map((receipt) => receipt.runId)].filter((id): id is string => !!id)) heldRuns.set(runId, `Exact launch, dependency or shipping receipt for retained coordinated change ${job.id}`); }
    const codeHostFile = join(home, "code-host-operations.json"); if (await exists(codeHostFile)) { const data = await readFingerprint(codeHostFile, budget, 512_000); plan.sources[codeHostFile] = data.file.fingerprint; for (const receipt of validateCodeHostDocument(JSON.parse(data.text)).operations) if (receipt.runId) heldRuns.set(receipt.runId, `Exact code host action receipt ${receipt.id}`); }
  } catch (error) { incomplete("archivedRuns", "pending-launch-sources", error); }
  for (const entry of memory) {
    const owner = entry.runId ? records.get(entry.runId)?.run : undefined;
    let reason = entry.scope === "project" ? "Project knowledge requires individual review and is never bulk-deleted" : entry.tags.includes("pinned") ? "Pinned memory" : heldMemory.get(entry.id);
    if (!reason && (!owner || !terminal(owner) || heldRuns.has(owner.id))) reason = "Its owner run is active, resumable, kept or unavailable";
    if (!reason && (cutoffs.memory === null || entry.updatedAt >= cutoffs.memory)) reason = "Memory retention is disabled or this revision is recent";
    if (reason) protect("memory", entry.id, reason);
    else { const ref = { id: entry.id, revision: entry.revision }; target({ id: `memory:${entry.id}`, kind: "memory", runId: entry.runId!, memory: ref, fingerprint: sha(canonical(entry)), bytes: 0, detail: "Erase this old private/team body, retaining its provenance tombstone" }); }
  }
  const retiringMemory = new Set(plan.targets.filter((item) => item.kind === "memory").map((item) => item.memory!.id));
  for (const entry of memory.filter((entry) => !retiringMemory.has(entry.id))) for (const id of [entry.runId, ...entry.origins.map((origin) => origin.runId)].filter((id): id is string => !!id)) heldRuns.set(id, `Provenance for retained ${entry.scope} memory ${entry.id}`);
  for (const [id, { run, log, mtime }] of records) {
    const reason = !terminal(run) ? "Run is active, resumable, unarchived, pinned or still watched" : heldRuns.get(id);
    if (reason) { for (const kind of ["archivedRuns", "attachments", "worktrees"] as RetentionKind[]) protect(kind, id, reason); continue; }
    if (cutoffs.archivedRuns !== null && mtime < cutoffs.archivedRuns) {
      try {
        const files = [log]; for (const suffix of [".journal.jsonl", ".checkpoint.json", ".cold-index.json", ".cold-detail.json"]) { const path = join(home, "runs", id + suffix); if (await exists(path)) { const file = await readFingerprint(path, budget); if (!suffix.startsWith(".cold-") && file.mtime >= cutoffs.archivedRuns) throw new Error("A recovery record was updated after the retention cutoff"); files.push(file.file); } }
        target({ id: `archivedRuns:${id}`, kind: "archivedRuns", runId: id, files, fingerprint: sha(canonical(files)), bytes: files.reduce((sum, file) => sum + file.bytes, 0), detail: "Delete this archived terminal log, journal and optional checkpoint" });
      } catch (error) { incomplete("archivedRuns", id, error); }
    } else protect("archivedRuns", id, "Run-log retention is disabled or the run was recently updated");
    if (cutoffs.attachments === null && cutoffs.worktrees === null) continue;
    let managed: string | undefined;
    try { managed = await managedRoot(run); }
    catch (error) { protect("attachments", id, retentionError(error)); protect("worktrees", id, retentionError(error)); continue; }
    if (!managed) continue;
    const trees = Array.isArray(run.worktrees) ? run.worktrees : [];
    if (cutoffs.worktrees !== null) for (const tree of trees) {
      try {
        if (typeof tree.path !== "string" || dirname(resolve(tree.path)) !== managed || typeof tree.branch !== "string") throw new Error("Workspace is outside this run's managed directory");
        if (!(await exists(tree.path))) continue;
        readOnlyGitMetadata(tree.path);
        const [listing, status, parentTracked, head, flags] = await Promise.all([git(["worktree", "list", "--porcelain", "-z"], run.repo, { timeoutMs: 5000 }), git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], tree.path, { timeoutMs: 5000 }), inside(run.repo, tree.path) ? git(["--literal-pathspecs", "ls-files", "-z", "--", relative(run.repo, tree.path)], run.repo, { timeoutMs: 5000 }) : Promise.resolve({ code: 0, stdout: "" }), git(["rev-parse", "--verify", "HEAD"], tree.path, { timeoutMs: 5000 }), git(["ls-files", "-v", "-z"], tree.path, { timeoutMs: 5000 })]);
        const record = listing.stdout.split("\0\0").find((record) => record.split("\0").includes(`worktree ${tree.path}`));
        if (listing.code || !record || !record.split("\0").includes(`branch refs/heads/${tree.branch}`) || record.split("\0").some((field) => /^locked|^prunable/.test(field)) || status.code || status.stdout.trim() || parentTracked.code || parentTracked.stdout.trim() || head.code || flags.code || flags.stdout.split("\0").some((file) => /^[a-zS] /.test(file))) throw new Error("Workspace is dirty, untracked, locked, nested, hides tracked changes or no longer owns its branch");
        const view = await inventory(tree.path, budget); if (Math.max(mtime, view.newest) >= cutoffs.worktrees) { protect("worktrees", tree.path, "Workspace files or run metadata were updated after the cutoff"); continue; }
        target({ id: `worktrees:${id}:${tree.name ?? tree.branch}`, kind: "worktrees", runId: id, path: tree.path, repo: run.repo, branch: tree.branch, fingerprint: sha(view.fingerprint + ":" + head.stdout.trim()), bytes: view.bytes, detail: "Remove this clean linked workspace without force; its Git branch is preserved" });
      } catch (error) { protect("worktrees", String(tree.path ?? id), retentionError(error)); if (/limit|changed during/.test(retentionError(error))) plan.truncated = true; }
    }
    if (cutoffs.attachments !== null) {
      const folders = [join(managed, ".context", "attachments"), join(managed, ".context", "messages"), ...trees.filter((tree: any) => typeof tree.path === "string" && dirname(resolve(tree.path)) === managed).flatMap((tree: any) => [join(tree.path, ".codeflow-context", "attachments"), join(tree.path, ".codeflow-context", "messages")])];
      for (const folder of folders) {
        try {
          const info = await exists(folder); if (!info) continue; await safeParents(join(folder, "placeholder")); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Attachment storage is not a regular directory");
          for (const name of (await readdir(folder)).sort()) {
            const path = join(folder, name); if (plan.targets.some((item) => item.kind === "worktrees" && path.startsWith(item.path! + sep))) continue;
            const data = await readFingerprint(path, budget, 10 * 1024 * 1024); if (Math.max(mtime, data.mtime) >= cutoffs.attachments) { protect("attachments", path, "Attachment or run metadata is recent"); continue; }
            const owner = trees.find((tree: any) => typeof tree.path === "string" && inside(tree.path, path))?.path ?? run.repo;
            const tracked = inside(owner, path) ? await git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative(owner, path)], owner, { timeoutMs: 5000 }) : { code: 1 };
            if (tracked.code !== 1) { protect("attachments", path, "Tracked or unverified repository material is preserved"); continue; }
            target({ id: `attachments:${id}:${relative(managed, path)}`, kind: "attachments", runId: id, path, files: [data.file], fingerprint: data.file.fingerprint, bytes: data.file.bytes, detail: "Delete this staged upload/message attachment or generated workspace copy" });
          }
        } catch (error) { protect("attachments", folder, retentionError(error)); if (/limit|changed during/.test(retentionError(error))) plan.truncated = true; }
      }
    }
  }
  plan.targets.sort((a, b) => a.id.localeCompare(b.id)); plan.protected.sort((a, b) => `${a.kind}:${a.id}:${a.reason}`.localeCompare(`${b.kind}:${b.id}:${b.reason}`));
  for (const item of plan.targets) { plan.summary[item.kind]++; plan.summary.bytes += item.bytes; }
  plan.fingerprint = sha(canonical({ ...plan, fingerprint: "" })); return plan;
}

/** Explicit offline apply uses a freshly rebuilt manifest, never caller-supplied paths. */
export async function applyRetention(input: { home: string; plan: RetentionPreview; now?: number }) {
  const now = input.now ?? Date.now(), supplied = input.plan;
  if (!supplied || supplied.version !== 1 || !Number.isSafeInteger(supplied.createdAt) || supplied.createdAt > now + 5000 || now - supplied.createdAt > RETENTION_LIMITS.planAgeMs || supplied.expiresAt !== supplied.createdAt + RETENTION_LIMITS.planAgeMs || !/^[a-f0-9]{64}$/.test(supplied.fingerprint)) throw new Error("Choose a valid retention preview from the last 24 hours");
  const info = await lstat(input.home); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Application data directory must be regular"); const home = await realpath(input.home); if (home !== supplied.home) throw new Error("Retention preview belongs to a different data directory");
  const release = await acquireLock(0, home);
  try {
    const plan = await previewRetention({ home, now: supplied.createdAt });
    if (plan.truncated || supplied.truncated) throw new Error("Incomplete retention scans cannot be applied; resolve the protected scan limits or invalid data first");
    if (plan.fingerprint !== supplied.fingerprint || canonical(plan) !== canonical(supplied)) throw new Error("Data, ownership or policy changed after preview. No changes applied; create and review another preview.");
    const applied: string[] = [], failed: { id: string; reason: string }[] = [];
    const memory = plan.targets.filter((item) => item.kind === "memory");
    if (memory.length) { await new MemoryStore(join(home, "memory.sqlite")).retireMaintenance(memory.map((item) => item.memory!)); applied.push(...memory.map((item) => item.id)); }
    for (const item of [...plan.targets.filter((item) => item.kind === "worktrees"), ...plan.targets.filter((item) => item.kind === "attachments"), ...plan.targets.filter((item) => item.kind === "archivedRuns")]) {
      try {
        if (item.kind === "worktrees") { await safeParents(item.path!); readOnlyGitMetadata(item.path!); const current = await inventory(item.path!, { files: 0, bytes: 0 }), head = await git(["rev-parse", "--verify", "HEAD"], item.path!, { timeoutMs: 5000 }); if (head.code || sha(current.fingerprint + ":" + head.stdout.trim()) !== item.fingerprint) throw new Error("Workspace changed before removal; stopped applying this plan"); const removed = await git(["worktree", "remove", "--", item.path!], item.repo!, { timeoutMs: 30_000 }); if (removed.code) throw new Error(removed.stderr.trim() || "Git refused workspace removal"); }
        else for (const file of item.files ?? []) { await safeParents(file.path); const current = await readFingerprint(file.path, { files: 0, bytes: 0 }); if (current.file.fingerprint !== file.fingerprint) throw new Error("File changed before deletion; stopped applying this plan"); await unlink(file.path); }
        applied.push(item.id);
      } catch (error) { failed.push({ id: item.id, reason: retentionError(error) }); break; }
    }
    return { fingerprint: plan.fingerprint, applied, failed, remaining: plan.targets.filter((item) => !applied.includes(item.id)).map((item) => item.id) };
  } finally { release(); }
}
