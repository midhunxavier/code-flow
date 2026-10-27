import { disableRestoredProjectTeam } from "./project-team-model.js";
import { constants } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, link, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { acquireLock } from "./store.js";
import { disableRestoredDeferredRuns } from "./deferred-runs.js";
import { disableRestoredCodeHostActions } from "./code-hosts.js";
import { disableRestoredCoordinatedChanges } from "./repo-coordination.js";
import { StrictRunLogReader } from "./run-log.js";
import { MemoryStore } from "./memory.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAGIC = Buffer.from("CODEFLOW-BACKUP-1\n");
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = Math.ceil(MAX_BYTES * 1.4);
const MAX_FILES = 20000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
// team-connections/ and legacy team-link.json hold this computer's runner credentials: restored elsewhere it would make a second machine with the same runner identity, so it stays out like the other credential files (team/ and team-link/attempts/ hold no credentials and stay in).
const sessionPath = /(^|\/)(integration-secrets|team-connections|ssh-host|remote-worker-private|extension-cache|acp-connections\.json(?:[.-].*)?|shared-accounts\.json(?:[.-].*)?|remote\.json(?:[.-].*)?|phone-devices\.json(?:[.-].*)?|team-link\.json(?:[.-].*)?|processes\.json|sessions?\.json|(?:team[-_])?(?:credentials?|capabilit(?:y|ies))(?:\.[^/]*)?|connection\.json|[^/]*\.(?:pem|key)|\.env(?:\.[^/]*)?)(\/|$)/i;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const validId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
interface BackupEntry { path: string; bytes: number; sha256: string; data: string }
interface BackupManifest { version: 1; createdAt: number; files: BackupEntry[]; omitted: string[] }

async function homePath(path: string) {
  if (!(await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)))?.isDirectory()) throw new Error("Choose an existing code-flow data directory, without a symbolic link.");
  return realpath(path);
}
export async function offline<T>(home: string, action: (home: string) => Promise<T>): Promise<T> {
  const path = await homePath(home);
  const release = await acquireLock(0, path);
  try { return await action(path); } finally { release(); }
}
function validateBackupPassword(password: string) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("Use a backup password of 12 to 1,024 characters in CODEFLOW_BACKUP_PASSWORD.");
}
function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  validateBackupPassword(password);
  return new Promise((accept, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => error ? reject(error) : accept(key)));
}
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Check cheap output mistakes before reading data; the final write still rejects races. */
export async function newMaintenanceOutput(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`${label} folder does not exist. Choose an existing folder.`);
    throw error;
  });
  if (!(await lstat(parent)).isDirectory()) throw new Error(`${label} folder is not a directory. Choose an existing folder.`);
  const output = join(parent, basename(absolute));
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) throw new Error(`${label} file already exists. Choose a new path; existing files are never overwritten.`);
  return output;
}
export async function readMaintenanceInput(path: string, label: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`${label} file not found. Choose an existing file.`);
    throw error;
  });
}
async function writeExclusive(path: string, bytes: Buffer) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temp, path); await syncDirectory(dirname(path));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Backup file already exists. Choose a new path; existing backups are never overwritten."); throw error; }
  finally { await unlink(temp).catch(() => undefined); }
}

/** Encrypted, authenticated backups; no plaintext archive or password is written to disk. */
export async function createEncryptedBackup(input: { home: string; output: string; password: string }) {
  const output = await newMaintenanceOutput(input.output, "Backup");
  validateBackupPassword(input.password);
  return offline(input.home, async (home) => {
    const inside = relative(home, output);
    if (inside !== ".." && !inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside)) throw new Error("Save backups outside the data directory.");
    // Recover an interrupted SQLite transaction before copying the offline database.
    // The memory store uses DELETE journaling and closes every operation, so there is
    // no live WAL to omit or replay separately in the portable archive.
    const memoryFile = join(home, "memory.sqlite");
    const memoryExists = await lstat(memoryFile).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
    if (memoryExists) await new MemoryStore(memoryFile).load();
    const files: BackupEntry[] = [];
    const omitted: string[] = [];
    let bytes = 0;
    const walk = async (folder: string) => {
      for (const entry of await readdir(join(home, folder), { withFileTypes: true })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (sessionPath.test(path)) { omitted.push(`${path} (session or credential material)`); continue; }
        if (path.startsWith("server.lock") || path === "retention-policy.json.lock" || entry.name.endsWith(".tmp")) { omitted.push(path); continue; }
        if (entry.isSymbolicLink()) { omitted.push(`${path} (symbolic link)`); continue; }
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile()) { omitted.push(`${path} (special file)`); continue; }
        if (files.length >= MAX_FILES) throw new Error(`Backup exceeds ${MAX_FILES.toLocaleString()} files.`);
        const handle = await open(join(home, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || bytes + before.size > MAX_BYTES) throw new Error("Backup exceeds the 256 MiB data limit. Archive older runs separately first.");
          const data = await handle.readFile();
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== before.size) throw new Error(`Data changed during backup: ${path}`);
          bytes += data.length;
          files.push({ path, bytes: data.length, sha256: sha256(data), data: data.toString("base64") });
        } finally { await handle.close(); }
      }
    };
    await walk("");
    const manifest: BackupManifest = { version: 1, createdAt: Date.now(), files, omitted };
    const salt = randomBytes(16); const iv = randomBytes(12);
    const header = Buffer.concat([MAGIC, salt, iv]);
    const cipher = createCipheriv("aes-256-gcm", await passwordKey(input.password, salt), iv);
    cipher.setAAD(header);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("Backup metadata exceeds the archive size limit. Archive older runs separately first.");
    const packed = await compress(manifestBytes);
    const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
    await writeExclusive(output, Buffer.concat([header, cipher.getAuthTag(), ciphertext]));
    return { output, files: files.length, bytes, omitted, encrypted: true as const };
  });
}

function validManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid backup manifest.");
  const manifest = value as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || !Array.isArray(manifest.omitted) || manifest.omitted.length > MAX_FILES || manifest.omitted.some((item) => typeof item !== "string" || item.length > 8192) || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) throw new Error("Unsupported or invalid backup manifest.");
  let bytes = 0; const paths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path.length > 4096 || file.path.includes("\\") || file.path.includes("\0") || isAbsolute(file.path) || file.path.split("/").some((part) => !part || part === "." || part === "..") || file.path.startsWith("server.lock") || paths.has(file.path)) throw new Error("Backup contains an unsafe or duplicate file path.");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0 || typeof file.sha256 !== "string") throw new Error("Backup contains invalid file data.");
    const data = Buffer.from(file.data, "base64");
    bytes += data.length;
    if (data.length !== file.bytes || data.toString("base64") !== file.data || sha256(data) !== file.sha256 || bytes > MAX_BYTES) throw new Error("Backup file integrity or size validation failed.");
    paths.add(file.path);
  }
  const privateFiles = manifest.files.filter((file) => sessionPath.test(file.path));
  return { ...manifest, files: manifest.files.filter((file) => !sessionPath.test(file.path)), omitted: [...manifest.omitted, ...privateFiles.map((file) => `${file.path} (session or credential material excluded from restore)`)] };
}

/** Restores to a new directory. Existing data directories are never merged or overwritten. */
export async function restoreEncryptedBackup(input: { input: string; destination: string; password: string }) {
  validateBackupPassword(input.password);
  const source = await lstat(input.input).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error("Backup file not found. Choose an existing file."); throw error; });
  if (!source.isFile() || source.size > MAX_MANIFEST_BYTES + 1024 || source.size < MAGIC.length + 45) throw new Error("Choose a valid backup file under 360 MiB.");
  const archive = await readFile(input.input);
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported backup format.");
  const salt = archive.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = archive.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const headerEnd = MAGIC.length + 28;
  const decipher = createDecipheriv("aes-256-gcm", await passwordKey(input.password, salt), iv);
  decipher.setAAD(archive.subarray(0, headerEnd));
  decipher.setAuthTag(archive.subarray(headerEnd, headerEnd + 16));
  let packed: Buffer;
  try { packed = Buffer.concat([decipher.update(archive.subarray(headerEnd + 16)), decipher.final()]); }
  catch { throw new Error("Backup authentication failed. Check the password and that the file is intact."); }
  let manifest: BackupManifest;
  try { manifest = validManifest(JSON.parse((await decompress(packed, { maxOutputLength: MAX_MANIFEST_BYTES })).toString("utf8"))); }
  catch (error) { throw new Error(`Cannot restore backup: ${(error as Error).message}`); }
  const destination = resolve(input.destination);
  if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) throw new Error("Restore destination already exists. Choose a new directory.");
  const parent = await realpath(dirname(destination));
  const finalPath = join(parent, basename(destination));
  const staging = join(parent, `.${basename(destination)}.restore-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  let disabledAutomations = 0; let disabledNotifications = 0; let cancelledDeferredRuns = 0; let cancelledCoordinatedChanges = 0; let restoredBytes = 0;
  try {
    for (const file of manifest.files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let data = Buffer.from(file.data, "base64");
      if (/^project-teams\/pt-[a-f0-9]{24}\.json$/.test(file.path)) data = Buffer.from(JSON.stringify(disableRestoredProjectTeam(JSON.parse(data.toString("utf8")))));
      if (file.path === "triggers.json") {
        const triggers: unknown = JSON.parse(data.toString("utf8"));
        if (!Array.isArray(triggers) || triggers.some((trigger) => !trigger || typeof trigger !== "object" || Array.isArray(trigger))) throw new Error("Cannot restore invalid automation settings.");
        disabledAutomations = triggers.length;
        data = Buffer.from(JSON.stringify(triggers.map((trigger) => ({ ...trigger, enabled: false, token: randomBytes(24).toString("hex"), nextAt: undefined, queued: [], webhookStarts: [] })), null, 2));
      }
      if (file.path === "notifications.json") {
        const notifications = JSON.parse(data.toString("utf8"));
        if (!notifications || notifications.version !== 1 || !notifications.settings || typeof notifications.settings !== "object" || Array.isArray(notifications.settings) || !Array.isArray(notifications.deliveries)) throw new Error("Cannot restore invalid notification settings.");
        for (const settings of Object.values(notifications.settings)) { if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Cannot restore invalid notification settings."); (settings as { enabled: boolean }).enabled = false; disabledNotifications++; }
        notifications.deliveries = notifications.deliveries.map((delivery: Record<string, unknown>) => { if (!delivery || typeof delivery !== "object") throw new Error("Cannot restore invalid notification deliveries."); return ["pending", "sending"].includes(String(delivery.state)) ? { ...delivery, state: "cancelled", nextAttemptAt: undefined, updatedAt: Date.now(), reason: "Cancelled during backup restore; deliberately re-enable notifications after reviewing destinations." } : delivery; });
        data = Buffer.from(JSON.stringify(notifications, null, 2));
      }
      if (file.path === "deferred-runs.json") {
        const restored = disableRestoredDeferredRuns(JSON.parse(data.toString("utf8")));
        cancelledDeferredRuns = restored.cancelled;
        data = Buffer.from(JSON.stringify(restored.document, null, 2));
      }
      if (file.path === "coordinated-changes.json") {
        const restored = disableRestoredCoordinatedChanges(JSON.parse(data.toString("utf8")));
        cancelledCoordinatedChanges = restored.cancelled;
        data = Buffer.from(JSON.stringify(restored.document, null, 2));
      }
      if (file.path === "code-host-operations.json") data = Buffer.from(JSON.stringify(disableRestoredCodeHostActions(JSON.parse(data.toString("utf8"))), null, 2));
      const handle = await open(target, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(dirname(target));
      restoredBytes += data.length;
    }
    if (await lstat(finalPath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) throw new Error("Restore destination was created during restore. Choose a new directory.");
    await syncDirectory(staging);
    await rename(staging, finalPath);
    await syncDirectory(parent);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { destination: finalPath, files: manifest.files.length, bytes: restoredBytes, createdAt: manifest.createdAt, omitted: manifest.omitted, disabledAutomations, disabledNotifications, cancelledDeferredRuns, cancelledCoordinatedChanges };
}

interface LogData { text: string; lines: string[]; events: Array<Record<string, any>>; snapshot: Record<string, any>; bytes: number; mtimeMs: number }
async function readRunLog(home: string, id: string): Promise<LogData> {
  if (!validId(id)) throw new Error("Choose a valid run id.");
  const missingRun = (error: NodeJS.ErrnoException): never => { if (error.code === "ENOENT") throw new Error(`Run ${id} not found.`); throw error; };
  if (!(await lstat(join(home, "runs")).catch(missingRun)).isDirectory()) throw new Error("Run storage must be a regular directory without a symbolic link.");
  const path = join(home, "runs", `${id}.jsonl`);
  const info = await lstat(path).catch(missingRun);
  if (!info.isFile() || info.size > MAX_LOG_BYTES) throw new Error("Only regular run logs up to 64 MiB can be maintained by this command.");
  const text = await readFile(path, "utf8");
  if (!text.endsWith("\n")) throw new Error("Run log has an incomplete last record; repair or recover it before maintenance.");
  const lines = text.split("\n").filter((line) => line.trim());
  const events = lines.map((line) => JSON.parse(line) as Record<string, any>);
  if (events.some((event) => !event || typeof event !== "object" || Array.isArray(event) || (event.type === "run" && event.run?.id !== id))) throw new Error("Run log contains invalid or mismatched records.");
  const reader = new StrictRunLogReader(id); let snapshot: Record<string, any> | undefined;
  for (const value of events) { const event = reader.decode(value); if (event?.type === "run") snapshot = event.run; }
  if (!snapshot || !["done", "failed", "cancelled"].includes(snapshot.status)) throw new Error("Only completed, failed or cancelled runs can be maintained. Resumable runs are kept.");
  return { text, lines, events, snapshot, bytes: info.size, mtimeMs: info.mtimeMs };
}
export interface RetentionPlan { days: number; cutoff: number; candidates: Array<{ id: string; bytes: number; files: string[] }>; skipped: Array<{ id: string; reason: string }> }
async function retentionPlan(home: string, days: number, now: number): Promise<RetentionPlan> {
  if (!Number.isInteger(days) || days < 1 || days > 36500 || !Number.isFinite(now)) throw new Error("Retention days must be an integer from 1 to 36,500.");
  const result: RetentionPlan = { days, cutoff: now - days * 86400000, candidates: [], skipped: [] };
  const runDirectory = await lstat(join(home, "runs")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!runDirectory) return result;
  if (!runDirectory.isDirectory()) throw new Error("Run storage must be a regular directory without a symbolic link.");
  const entries = await readdir(join(home, "runs")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const file of entries.filter((file) => file.endsWith(".jsonl") && !file.endsWith(".journal.jsonl"))) {
    const id = file.slice(0, -6);
    try {
      const log = await readRunLog(home, id);
      if (log.snapshot.archived !== true || log.mtimeMs >= result.cutoff) continue;
      const files: string[] = []; let bytes = 0;
      for (const name of [`${id}.jsonl`, `${id}.journal.jsonl`, `${id}.checkpoint.json`, `${id}.cold-index.json`, `${id}.cold-detail.json`]) {
        const info = await lstat(join(home, "runs", name)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (info?.isFile()) { files.push(name); bytes += info.size; }
      }
      result.candidates.push({ id, files, bytes });
    } catch (error) { result.skipped.push({ id, reason: (error as Error).message }); }
  }
  return result;
}

/** Legacy age-only report. Deletion now requires the provenance-aware exact retention manifest. */
export function retainArchivedRuns(input: { home: string; days: number; now?: number; apply?: boolean }): Promise<RetentionPlan & { applied: boolean; deletedFiles: number; nextStep: string }> {
  return offline(input.home, async (home) => {
    const plan = await retentionPlan(home, input.days, input.now ?? Date.now());
    if (input.apply) throw new Error("Age-only retention cannot delete data. Save a retention policy, review retention-policy --output PLAN.json, then apply that exact plan with retention-policy --plan PLAN.json --apply.");
    return { ...plan, applied: false, deletedFiles: 0, nextStep: "This legacy age-only report does not assess pins or provenance. Save a retention policy and review retention-policy --output PLAN.json before applying retention-policy --plan PLAN.json --apply." };
  });
}

/** Removes intermediate metadata snapshots, preserving all transcripts, steps and recovery records. */
export function compactRunLog(input: { home: string; runId: string; apply?: boolean }) {
  return offline(input.home, async (home) => {
    const log = await readRunLog(home, input.runId);
    const snapshots = log.events.flatMap((event, index) => event?.type === "run" || event?.type === "run-patch" ? [index] : []);
    const removable = new Set(snapshots.slice(1, -1));
    const last = snapshots.at(-1), lastEvent = last === undefined ? undefined : log.events[last];
    // The final patch may name a removed intermediate snapshot. Keep it as a self-contained
    // full snapshot, retaining every transcript/step record and its original sequence order.
    const finalLine = removable.size && lastEvent?.type === "run-patch" ? JSON.stringify({ seq: lastEvent.seq, ts: lastEvent.ts, runId: input.runId, type: "run", run: log.snapshot }) : undefined;
    let text = log.lines.flatMap((line, index) => removable.has(index) ? [] : [index === last && finalLine ? finalLine : line]).join("\n") + "\n";
    let afterBytes = Buffer.byteLength(text);
    // Already efficient patch logs can grow when materializing the final state. Leave them
    // untouched rather than exceed their original byte bound merely to remove a snapshot.
    if (afterBytes >= log.bytes) { removable.clear(); text = log.text; afterBytes = log.bytes; }
    if (input.apply && removable.size) {
      const path = join(home, "runs", `${input.runId}.jsonl`);
      const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        const current = await lstat(path);
        if (current.size !== log.bytes || current.mtimeMs !== log.mtimeMs || !current.isFile()) throw new Error("Run log changed during compaction; no change was applied.");
        await rename(temp, path); await syncDirectory(dirname(path));
        for (const suffix of [".checkpoint.json", ".cold-index.json", ".cold-detail.json"]) await unlink(join(home, "runs", input.runId + suffix)).catch(() => undefined);
      } finally { await unlink(temp).catch(() => undefined); }
    }
    return { runId: input.runId, applied: input.apply === true, snapshotsRemoved: removable.size, beforeBytes: log.bytes, afterBytes, savedBytes: log.bytes - afterBytes };
  });
}
