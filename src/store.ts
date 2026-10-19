import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, unlinkSync, type Stats } from "node:fs";
import { appendFile, link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { childEnv } from "./env.js";
import { logError, logWarn } from "./log.js";
import { WorkQueue } from "./work-queue.js";

/**
 * Runs are persisted as their append-only event log (`<id>.jsonl`): every run snapshot and
 * step update is already in it, so the log is the single source of truth and runs are
 * rebuilt from it on startup. A separate journal (`<id>.journal.jsonl`) records the result
 * of every completed step so an interrupted run can be resumed by replaying them.
 */

export const RUNS_DIR = join(CODEFLOW_HOME, "runs");

/** Newer versions are rejected by strict recovery; legacy readers skip them. */
export const JOURNAL_VERSION = 2;

const ready = mkdir(RUNS_DIR, { recursive: true });
const writes = new WorkQueue(4), checkpoints = new WorkQueue(1);
const runKey = (file: string) => file.replace(/(?:\.journal)?\.jsonl$/, "");
let queuedBytes = 0;
export const WRITE_BUFFER_BYTES = 64 * 1024 * 1024;
export const writeQueueStats = () => ({ writes: { ...writes.stats, bytes: queuedBytes }, checkpoints: checkpoints.stats });
interface AppendBatch { file: string; text: string; bytes: number; count: number; promise: Promise<void> }
const appendBatches = new Map<string, AppendBatch>();

/** Failed writes: event projections are best-effort; authoritative callers fail closed. */
export const writeHealth: { failures: number; lastError?: string; at?: number } = { failures: 0 };
/** Checkpoints accelerate startup; their failure never changes journal write health. */
export const checkpointHealth: { failures: number; lastError?: string; at?: number } = { failures: 0 };
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const checkpointId = (file: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.jsonl$/.test(file) && !file.endsWith(".journal.jsonl") ? file.slice(0, -6) : undefined;
interface CheckpointSource { size: string; mtimeNs: string; ctimeNs: string; dev: string; ino: string }
const sourceIdentity = (info: import("node:fs").BigIntStats): CheckpointSource => ({ size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), dev: String(info.dev), ino: String(info.ino) });
const checksum = (text: string) => createHash("sha256").update(text).digest("hex");

async function writeRunCheckpoint(file: string, seq: number, runJson: string, source: CheckpointSource) {
  const id = checkpointId(file);
  if (!id) return;
  const payload = `${JSON.stringify({ version: 1, source, seq }).slice(0, -1)},"run":${runJson}}`;
  const text = `${payload.slice(0, -1)},"checksum":"${checksum(payload)}"}\n`;
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) return;
  const path = join(RUNS_DIR, `${id}.checkpoint.json`);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    if (JSON.stringify(sourceIdentity(await stat(join(RUNS_DIR, file), { bigint: true }))) !== JSON.stringify(source)) return;
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => undefined); }
}

/** A bounded optional projection. Missing, damaged or stale checkpoints fall back to the log. */
export async function readRunCheckpoint<T = unknown>(id: string): Promise<{ run: T; seq: number } | undefined> {
  if (checkpointId(`${id}.jsonl`) !== id) return undefined;
  const sourcePath = join(RUNS_DIR, `${id}.jsonl`);
  try {
    const before = sourceIdentity(await stat(sourcePath, { bigint: true }));
    const handle = await open(join(RUNS_DIR, `${id}.checkpoint.json`), "r");
    let text: string;
    try {
      const size = (await handle.stat()).size;
      if (size === 0 || size > MAX_CHECKPOINT_BYTES) return undefined;
      text = await handle.readFile("utf8");
    } finally { await handle.close(); }
    if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) return undefined;
    const cached = JSON.parse(text);
    if (cached?.version !== 1 || !Number.isSafeInteger(cached.seq) || cached.seq < 0 || !cached.source || typeof cached.checksum !== "string" || !cached.run || typeof cached.run !== "object" || Array.isArray(cached.run) || cached.run.id !== id || !Array.isArray(cached.run.steps)) return undefined;
    const payload = JSON.stringify({ version: cached.version, source: cached.source, seq: cached.seq, run: cached.run });
    if (checksum(payload) !== cached.checksum) return undefined;
    const after = sourceIdentity(await stat(sourcePath, { bigint: true }));
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(cached.source) !== JSON.stringify(after)) return undefined;
    return { run: cached.run as T, seq: cached.seq };
  } catch { return undefined; }
}

/**
 * Files whose last write this process succeeded, so they end in "\n". Anything else is checked
 * first: a crash, or a failed write (a full disk), can leave a line without its "\n".
 */
const repaired = new Set<string>();

/** Files appended to since the last `flushWrites`, which fsyncs them. */
const unsynced = new Set<string>();

/** First synced append also persists the journal's directory entry. */
const directorySynced = new Set<string>();

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

async function appendSynced(path: string, text: string) {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!directorySynced.has(path)) {
    // Directory handles cannot be fsynced on Windows; file fsync still applies there.
    if (process.platform !== "win32") {
      const directory = await open(RUNS_DIR, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    directorySynced.add(path);
  }
}

/** A partial authoritative record was never committed; do not turn it into a bad full line. */
async function truncateIncompleteTail(path: string): Promise<void> {
  const handle = await open(path, "r+").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!handle) return;
  try {
    const { size } = await handle.stat();
    if (!size) return;
    let end = size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const length = end - start;
      await handle.read(buffer, 0, length, start);
      const newline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (newline >= 0) {
        const boundary = start + newline + 1;
        if (boundary !== size) { await handle.truncate(boundary); await handle.sync(); }
        return;
      }
      end = start;
    }
    await handle.truncate(0);
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Append a JSON line; writes are queued so each file's lines stay in order. `sync` waits for
 * the line to reach the disk (fsync) before the next write: for lines that must survive a
 * power loss, not for every event (`flushWrites` syncs those at shutdown).
 */
export function appendLine(file: string, value: unknown, opts: { sync?: boolean; strict?: boolean; checkpoint?: { seq: number; run: unknown }; onFailed?: () => void } = {}): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  let checkpointWork: Promise<void> | undefined;
  // Capture now, alongside the event: the live run may change before its queued write executes.
  let checkpoint: { seq: number; runJson: string } | undefined;
  if (opts.checkpoint && Number.isSafeInteger(opts.checkpoint.seq) && opts.checkpoint.seq >= 0 && typeof value === "object" && value && "seq" in value && value.seq === opts.checkpoint.seq) {
    try {
      const runJson = JSON.stringify(opts.checkpoint.run);
      if (runJson && Buffer.byteLength(runJson) <= MAX_CHECKPOINT_BYTES) checkpoint = { seq: opts.checkpoint.seq, runJson };
    } catch { /* The event log remains authoritative if a projection cannot be serialized. */ }
  }
  const key = runKey(file), size = Buffer.byteLength(line);
  const previous = appendBatches.get(key);
  const batchable = !opts.sync && !opts.strict && !opts.checkpoint;
  let written: Promise<void>;
  if (queuedBytes + size > WRITE_BUFFER_BYTES) {
    appendBatches.delete(key);
    written = Promise.reject(new Error("Run write buffer is full; storage cannot keep up"));
  } else if (batchable && previous?.file === file && previous.bytes + size <= 256 * 1024 && previous.count < 128) {
    previous.text += line; previous.bytes += size; previous.count++; queuedBytes += size; written = previous.promise;
  } else {
    appendBatches.delete(key);
    const batch: AppendBatch = { file, text: line, bytes: size, count: 1, promise: Promise.resolve() };
    queuedBytes += size;
    written = writes.run(key, async () => {
      if (appendBatches.get(key) === batch) appendBatches.delete(key);
      await ready;
      const path = join(RUNS_DIR, file);
      if (opts.strict && !repaired.has(file)) await truncateIncompleteTail(path);
      // Close a torn last line first, or this line would be glued to it and both lost.
      const prefix = repaired.has(file) || (await endsWithNewline(path)) ? "" : "\n";
      try {
        if (opts.sync) await appendSynced(path, prefix + batch.text);
        else await appendFile(path, prefix + batch.text);
      } catch (err) {
        // Part of the line may have been written: look at the end of the file again next time.
        repaired.delete(file);
        throw err;
      }
      repaired.add(file);
      if (opts.sync) unsynced.delete(file);
      else unsynced.add(file);
      if (checkpoint && checkpoints.stats.bytes + Buffer.byteLength(checkpoint.runJson) <= 32 * 1024 * 1024) {
        const captured = checkpoint;
        const source = await stat(path, { bigint: true }).then(sourceIdentity).catch(() => undefined);
        // Optional checkpoints cannot hold up later authoritative appends.
        if (source) checkpointWork = checkpoints.run(key, () => writeRunCheckpoint(file, captured.seq, captured.runJson, source), Buffer.byteLength(captured.runJson)).catch((error: Error) => {
          checkpointHealth.failures++; checkpointHealth.lastError = error.message; checkpointHealth.at = Date.now();
          if (checkpointHealth.failures === 1 || checkpointHealth.failures % 100 === 0) logWarn("couldn't save optional run checkpoint", { file, error: error.message });
        });
      }
    }, size).finally(() => { queuedBytes -= batch.bytes; });
    batch.promise = written;
    if (batchable) appendBatches.set(key, batch);
  }
  // Preserve callers' checkpoint completion contract without holding the append queue.
  const complete = written.then(() => checkpointWork);
  const observed = complete.catch((err: Error) => {
      opts.onFailed?.();
      writeHealth.failures++;
      writeHealth.lastError = err.message;
      writeHealth.at = Date.now();
      if (writeHealth.failures === 1 || writeHealth.failures % 100 === 0) {
        logError(`couldn't save run data (${writeHealth.failures} failed writes)`, err, { file });
      }
    });
  // A caller can fail closed without poisoning the queue for every later run.
  return opts.strict ? complete : observed;
}

async function syncFile(file: string) {
  const handle = await open(join(RUNS_DIR, file), "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Resolves once everything queued so far is on disk, fsynced (so a clean shutdown is durable). */
export async function flushWrites(id?: string): Promise<void> {
  if (id === undefined) appendBatches.clear(); else appendBatches.delete(id);
  await writes.flush(id);
  const files = [...unsynced].filter((file) => id === undefined || runKey(file) === id);
  await Promise.all(files.map((file) => writes.run(runKey(file), async () => {
    if (!unsynced.has(file)) return;
    await syncFile(file);
    unsynced.delete(file);
  })));
  await checkpoints.flush(id);
}

/** Wait for appends without a durability barrier, for read-only transcript requests. */
export async function waitForRunWrites(id: string): Promise<void> { await writes.flush(id); }

/** Files whose unreadable lines were already logged this process. */
const reportedBadLines = new Set<string>();

/**
 * Every JSON line of a file. Lines that don't parse (a crash or a full disk mid-write) are
 * skipped: counted in `stats.skipped` when given, and logged once per file.
 */
export async function readJsonLines<T = any>(file: string, stats?: { skipped: number }): Promise<T[]> {
  const path = join(RUNS_DIR, file);
  if (!existsSync(path)) return [];
  const out: T[] = [];
  let skipped = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  if (stats) stats.skipped += skipped;
  if (skipped && !reportedBadLines.has(file)) {
    reportedBadLines.add(file);
    logWarn(`skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"} in a run log`, { file });
  }
  return out;
}

/** Startup projections consume one record at a time, without retaining whole event logs. */
export async function visitJsonLines<T>(file: string, visit: (entry: T) => void): Promise<void> {
  const path = join(RUNS_DIR, file); if (!existsSync(path)) return;
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 }); let buffer = "", skipped = 0;
  const parse = (line: string) => { if (!line.trim()) return; let value: T; try { value = JSON.parse(line); } catch { skipped++; return; } visit(value); };
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let index: number; while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error(`Run log ${file} contains a record larger than 64 MiB`); parse(line); }
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) throw new Error(`Run log ${file} contains a record larger than 64 MiB`);
    }
    parse(buffer);
  } finally { stream.destroy(); }
  if (skipped && !reportedBadLines.has(file)) { reportedBadLines.add(file); logWarn(`skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"} in a run log`, { file }); }
}

export async function listRunIds(): Promise<string[]> {
  if (!existsSync(RUNS_DIR)) return [];
  const files = await readdir(RUNS_DIR);
  const deleted = new Set(files.filter(f => f.endsWith(".deleted")).map(f => f.slice(0, -8)));
  return files
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".journal.jsonl") && !deleted.has(f.slice(0, -6)))
    .map((f) => f.slice(0, -".jsonl".length));
}

/** Tombstones also serve as durable cleanup requests after an interrupted deletion. */
export async function listDeletedRunIds(): Promise<string[]> {
  if (!existsSync(RUNS_DIR)) return [];
  return (await readdir(RUNS_DIR)).filter(file => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.deleted$/.test(file)).map(file => file.slice(0, -8));
}

/** Serialized with pending writes. The durable marker prevents partial cleanup from restoring history. */
export function deleteRunHistory(id: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new Error("Invalid run ID");
  appendBatches.delete(id);
  const work = writes.run(id, async () => {
    await ready;
    await checkpoints.flush(id);
    await writeFile(join(RUNS_DIR, `${id}.deleted`), "", { mode: 0o600, flush: true });
    for (const suffix of [".jsonl", ".journal.jsonl", ".checkpoint.json", ".cold-index.json", ".cold-detail.json"]) {
      await rm(join(RUNS_DIR, id + suffix), { force: true });
      repaired.delete(id + suffix); unsynced.delete(id + suffix); directorySynced.delete(join(RUNS_DIR, id + suffix));
    }
  });
  return work;
}

export async function loadJournal(runId: string, opts: { strict?: boolean } = {}): Promise<Map<string, unknown>> {
  if (opts.strict) {
    let text: string;
    try { text = await readFile(join(RUNS_DIR, `${runId}.journal.jsonl`), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw err; }
    // An interrupted append has no terminating newline. Only complete records count.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const journal = new Map<string, unknown>();
    for (const [index, line] of complete.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.key !== "string" || !("value" in entry) || (entry.v ?? 1) > JOURNAL_VERSION) throw new Error("invalid or unsupported record");
        journal.set(entry.key, entry.value);
      } catch (err) {
        throw new Error(`Cannot recover journal ${runId}: record ${index + 1} is damaged or uses an unsupported version`, { cause: err });
      }
    }
    return journal;
  }
  const entries = await readJsonLines<{ key: string; value: unknown; v?: number }>(`${runId}.journal.jsonl`);
  return new Map(entries.filter((e) => (e.v ?? 1) <= JOURNAL_VERSION).map((e) => [e.key, e.value]));
}

/**
 * Write a file's lines anew: `make` gets them as they are by then (in turn with appends, so none
 * is lost) and returns the new ones, or undefined to leave the file as it is. The new file is
 * synced and then renamed over the old one, so a crash leaves one or the other. True if rewritten.
 */
export function rewriteLines(file: string, make: (lines: unknown[]) => unknown[] | undefined): Promise<boolean> {
  appendBatches.delete(runKey(file));
  const done = writes.run(runKey(file), async () => {
    await ready;
    await checkpoints.flush(runKey(file));
    const path = join(RUNS_DIR, file);
    const lines = make(await readJsonLines(file));
    if (!lines) return false;
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await appendSynced(temp, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      await rename(temp, path);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    repaired.add(file);
    unsynced.delete(file);
    return true;
  });
  return done;
}

/**
 * Synced, and awaited before the run moves on: a resumed run replays these instead of redoing
 * (and re-paying for) the steps, so a step counts as done only once its entry is on disk.
 */
export function journalEntry(runId: string, key: string, value: unknown): Promise<void> {
  return appendLine(`${runId}.journal.jsonl`, { key, value, v: JOURNAL_VERSION }, { sync: true, strict: true });
}

// ---------------------------------------------------------------- the one-server lock

/** What `server.lock` records. Older code-flow versions wrote just the pid. */
interface LockInfo {
  pid: number;
  /** When the process started (ms since epoch), to compare with what `ps` says now. */
  started?: number;
  /** Linux: its start in clock ticks since boot (from /proc), which clock changes don't move. */
  ticks?: number;
  /** When the machine booted (ms since epoch). */
  boot?: number;
  /** A plain-pid lock from an older version. */
  legacy?: boolean;
}

/** Boot times computed from the clock and uptime drift a little; a reboot moves them by far more. */
const BOOT_SLACK_MS = 120_000;
/** An empty or half-written lock this young is still being written by another server. */
const WRITING_MS = 2_000;

const bootTime = () => Date.now() - uptime() * 1000;

function startTicks(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after "(comm)" start at field 3; starttime is field 22.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** When `pid` started, from `ps` (ms since epoch, to the second); undefined if it can't tell. */
function psStart(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: childEnv({ LC_ALL: "C" }) }, (err, stdout) => {
      const ms = err ? NaN : Date.parse(String(stdout).trim());
      resolve(Number.isFinite(ms) ? ms : undefined);
    });
  });
}

function parseLock(text: string): LockInfo | undefined {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) > 0 ? { pid: Number(trimmed), legacy: true } : undefined;
  try {
    const info = JSON.parse(trimmed) as LockInfo;
    return Number.isInteger(info?.pid) && info.pid > 0 ? { ...info, legacy: false } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the server that wrote a lock still runs. A live pid isn't enough: after a kill -9 or
 * a reboot an unrelated process can have that pid, and the lock would block every start.
 */
async function holderAlive(text: string, mtimeMs: number): Promise<{ live: boolean; pid?: number }> {
  const info = parseLock(text);
  if (!info) return { live: Date.now() - mtimeMs < WRITING_MS };
  const { pid } = info;
  if (pid === process.pid || !alive(pid)) return { live: false, pid };
  if (info.legacy) {
    // Written before this boot, or by a process older than the one that has the pid now.
    if (mtimeMs < bootTime() - BOOT_SLACK_MS) return { live: false, pid };
    const started = await psStart(pid);
    return { live: started === undefined || started <= mtimeMs + WRITING_MS, pid };
  }
  if (info.ticks !== undefined) {
    const ticks = startTicks(pid);
    if (ticks !== undefined) return { live: ticks === info.ticks, pid };
  }
  if (info.started !== undefined) {
    const started = await psStart(pid);
    if (started !== undefined) return { live: Math.abs(started - info.started) < 5_000, pid };
  }
  // Can't see when the process started: a lock from before this boot is someone else's pid.
  return { live: info.boot === undefined || Math.abs(info.boot - bootTime()) < BOOT_SLACK_MS, pid };
}

/**
 * The lock's text and its file's identity, read from one handle so they belong together.
 * Undefined when it's gone; an unreadable lock (another user's) throws instead of spinning.
 */
async function readLock(file: string): Promise<{ text: string; stat: Stats } | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Can't read ${file}: ${(err as Error).message}`);
  }
  try {
    return { stat: await handle.stat(), text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

/** Create the lock from a fully written temp file, so nobody ever reads it half-written. */
async function createLock(temp: string, file: string, content: string): Promise<boolean> {
  try {
    await link(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
  }
  // A filesystem without hard links.
  try {
    await writeFile(file, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Replace a stale lock with ours. Two servers can find the same stale lock at once: only the
 * one that creates the takeover link (an exclusive name for the stale lock's file) may replace
 * it, and only if the lock is still the one it judged. The lock file never goes missing in
 * between, so a third server can't slip in either. Returns true when we hold the lock.
 */
async function takeOverLock(file: string, temp: string, judged: { text: string; stat: Stats }): Promise<boolean> {
  const token = `${file}.takeover`;
  try {
    await link(file, token);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false; // gone already: create it
    if (code === "EEXIST") {
      // Another server is taking over (for milliseconds), or one crashed doing it.
      const age = await stat(token).then((s) => Date.now() - s.ctimeMs, () => 0);
      if (age > 5_000) await unlink(token).catch(() => undefined);
      return false;
    }
    // No hard links: remove the stale lock and race for a fresh one.
    if ((await readFile(file, "utf8").catch(() => undefined)) === judged.text) await unlink(file).catch(() => undefined);
    return false;
  }
  try {
    const now = await stat(token).catch(() => undefined);
    const text = await readFile(token, "utf8").catch(() => undefined);
    if (!now || now.ino !== judged.stat.ino || now.dev !== judged.stat.dev || text !== judged.text) return false;
    await rename(temp, file);
    return true;
  } finally {
    await unlink(token).catch(() => undefined);
  }
}

/**
 * One server per CODEFLOW_HOME: two would append to the same logs with clashing sequence
 * numbers. Waits briefly for a previous instance that is still shutting down (a restart).
 * Returns a release function.
 */
export async function acquireLock(waitMs = 20_000, home = CODEFLOW_HOME): Promise<() => void> {
  const file = join(home, "server.lock");
  await mkdir(home, { recursive: true });
  const info: LockInfo = { pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), ticks: startTicks(process.pid), boot: Math.round(bootTime()) };
  const content = JSON.stringify(info);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, content);
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      if (await createLock(temp, file, content)) break;
      const seen = await readLock(file);
      if (!seen) continue; // released just now
      const holder = await holderAlive(seen.text, seen.stat.mtimeMs);
      if (!holder.live) {
        if (await takeOverLock(file, temp, seen)) break;
        if (Date.now() > deadline) throw new Error(`Couldn't replace the stale ${file}. Delete it and start code-flow again.`);
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      if (Date.now() > deadline) {
          throw new Error(`Another code-flow server${holder.pid ? ` (pid ${holder.pid})` : ""} is using ${home}. Stop it, or set CODEFLOW_HOME to a different folder.`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Synchronous, so it also works from an "exit" handler. Only ours: a server that took
      // the lock over keeps it.
      if (readFileSync(file, "utf8") === content) unlinkSync(file);
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
