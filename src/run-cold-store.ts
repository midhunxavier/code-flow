import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Run, RunSummary } from "./engine.js";
import { RUNS_DIR } from "./store.js";
import { runSearchText } from "./run-history.js";

export const COLD_LIMITS = { indexBytes: 128 * 1024, detailBytes: 16 * 1024 * 1024, cacheBytes: 32 * 1024 * 1024, cacheEntries: 8 };
type Identity = { size: string; mtimeNs: string; ctimeNs: string; dev: string; ino: string };
interface Index { version: 1; source: Identity; detail: Identity; digest: string; seq: number; summary: RunSummary; search?: string }
const identity = (info: import("node:fs").BigIntStats): Identity => ({ size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), dev: String(info.dev), ino: String(info.ino) });
const same = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id);
const shorten = (text: string | undefined, size: number) => text && text.length > size ? `${text.slice(0, size)}…` : text;

/** Pending/resumable work stays hot. Archiving never grants a new execution permission. */
export function coldEligible(run: Run): boolean {
  return run.archived && run.status === "done" && !run.awaiting && !run.team?.awaitingRequestId && !run.pauseRequested && !run.notes.some((note) => note.status === "queued") && !run.followUps.some((turn) => turn.status === "pending") && Object.keys(run.watches).length === 0 && !run.steps.some((step) => step.status === "running" || step.remote?.ambiguous || step.remote && ["accepted", "running", "unknown"].includes(step.remote.state));
}

/** Indexes keep ownership, source trust and exact statistical counters, without execution evidence. */
export function coldSummary(run: Run): RunSummary {
  const { steps: _steps, team: _team, teamRerun: _rerun, verification: _verification, mergeValidation: _mergeValidation, conventions: _conventions, lessons: _lessons, memoryManifest: _memoryManifest, findings: _findings, proofs: _proofs, humanReview: _humanReview, humanRework: _humanRework, patternSummary: _patternSummary, ...metadata } = run;
  return structuredClone({ ...metadata, humanRework: run.humanRework?.map(item => ({ ...item, note: "" })), cold: true as const, detailAvailable: true as const, task: shorten(run.task, 8192)!, summary: shorten(run.summary, 8192), error: shorten(run.error, 4096), notes: [], followUps: run.followUps.map((turn) => ({ ...turn, message: "", result: undefined, side: turn.side ? { ...turn.side, title: shorten(turn.side.title, 500)! } : undefined })),
    verification: run.verification ? { version: run.verification.version, state: run.verification.state, profile: run.verification.profile, startedAt: run.verification.startedAt, endedAt: run.verification.endedAt, head: run.verification.head, branch: run.verification.branch, checks: [], skipped: [] } : undefined,
    source: run.source ? { ...run.source, body: "", ci: run.source.ci ? { ...run.source.ci, logs: "" } : undefined } : undefined,
    externalSource: run.externalSource ? { ...run.externalSource, body: "" } : undefined,
    artifacts: run.artifacts.map((artifact) => ({ ...artifact, stat: artifact.stat?.trim().split("\n").at(-1) })),
    review: run.review ? { ...run.review, summary: "", markdown: "", findings: run.review.findings.map((finding) => ({ severity: finding.severity, raisedBy: finding.raisedBy, file: "", problem: "", fix: "" })) } : undefined,
    integrity: run.integrity ? Object.fromEntries(Object.entries(run.integrity).map(([branch, issues]) => [branch, issues.map((issue) => ({ ...issue, detail: "" }))])) : undefined,
  });
}

/** Optional, source-bound projections. The append-only event log remains authoritative. */
export class RunColdStore {
  private readonly indexes = new Map<string, Index>();
  private readonly cache = new Map<string, { run: Run; bytes: number }>();
  private bytes = 0;
  constructor(private readonly directory = RUNS_DIR) {}
  private source(id: string) { return join(this.directory, `${id}.jsonl`); }
  private path(id: string, kind: "index" | "detail") { if (!validId(id)) throw new Error("Invalid cold run ID"); return join(this.directory, `${id}.cold-${kind}.json`); }
  private async regular(path: string) { const info = await lstat(path, { bigint: true }); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Cold run projections require regular files"); return identity(info); }
  private regularSync(path: string) { const info = lstatSync(path, { bigint: true }); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Cold run projections require regular files"); return identity(info); }
  has(id: string) { return this.indexes.has(id); }
  ids() { return this.indexes.keys(); }
  index(id: string) { const item = this.indexes.get(id); return item ? structuredClone(item.summary) : undefined; }
  search(id: string) { return this.indexes.get(id)?.search; }
  summaries() { return [...this.indexes.values()].map((item) => structuredClone(item.summary)); }
  valid(id: string) { const item = this.indexes.get(id); if (!item) return false; try { return same(item.source, this.regularSync(this.source(id))) && same(item.detail, this.regularSync(this.path(id, "detail"))); } catch { return false; } }
  drop(id: string) { this.indexes.delete(id); const entry = this.cache.get(id); if (entry) this.bytes -= entry.bytes; this.cache.delete(id); }
  inspect() { return { records: this.indexes.size, cached: this.cache.size, bytes: this.bytes, limits: { ...COLD_LIMITS } }; }
  async load(id: string): Promise<{ summary: RunSummary; seq: number; search: string } | undefined> {
    if (!validId(id)) return undefined;
    try {
      const before = await this.regular(this.source(id)), file = this.path(id, "index"), info = await this.regular(file); if (Number(info.size) > COLD_LIMITS.indexBytes) return undefined;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let text: string; try { if ((await handle.stat()).size > COLD_LIMITS.indexBytes) return undefined; text = await handle.readFile("utf8"); } finally { await handle.close(); }
      const envelope = JSON.parse(text), item = envelope.index as Index;
      if (envelope.checksum !== sha(JSON.stringify(item)) || item?.version !== 1 || !Number.isSafeInteger(item.seq) || item.seq < 0 || !item.summary?.cold || !item.summary.detailAvailable || item.summary.id !== id || !item.summary.archived || item.summary.status !== "done" || !/^[a-f0-9]{64}$/.test(item.digest) || !same(item.source, before) || !same(before, await this.regular(this.source(id))) || !same(item.detail, await this.regular(this.path(id, "detail"))) || Number(item.detail.size) > COLD_LIMITS.detailBytes) return undefined;
      this.indexes.set(id, item);
      // Upgrade legacy projections once during async recovery, never during a history query.
      if (typeof item.search !== "string") { const full = await this.getAsync(id); if (!full) { this.drop(id); return undefined; } item.search = runSearchText(full); this.cache.delete(id); this.bytes = [...this.cache.values()].reduce((n, entry) => n + entry.bytes, 0); }
      return { summary: structuredClone(item.summary), seq: item.seq, search: item.search };
    } catch { this.drop(id); return undefined; }
  }
  async save(run: Run, seq: number): Promise<boolean> {
    if (!coldEligible(run) || !validId(run.id)) return false;
    const serialized = JSON.stringify(run); if (Buffer.byteLength(serialized) > COLD_LIMITS.detailBytes) return false;
    const summary = coldSummary(run); if (Buffer.byteLength(JSON.stringify(summary)) > COLD_LIMITS.indexBytes - 2048) return false;
    const source = await this.regular(this.source(run.id)), detailPath = this.path(run.id, "detail"); await mkdir(this.directory, { recursive: true });
    const atomic = async (path: string, text: string) => { const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`; try { const file = await open(temp, "wx", 0o600); try { await file.writeFile(text); } finally { await file.close(); } await rename(temp, path); } finally { await rm(temp, { force: true }); } };
    await atomic(detailPath, serialized); if (!same(source, await this.regular(this.source(run.id)))) return false;
    const index: Index = { version: 1, source, detail: await this.regular(detailPath), digest: sha(serialized), seq, summary, search: runSearchText(run) };
    const text = JSON.stringify({ index, checksum: sha(JSON.stringify(index)) }); if (Buffer.byteLength(text) > COLD_LIMITS.indexBytes) return false;
    await atomic(this.path(run.id, "index"), text); if (!same(source, await this.regular(this.source(run.id)))) return false;
    this.drop(run.id); this.indexes.set(run.id, index); return true;
  }
  async getAsync(id: string): Promise<Run | undefined> {
    const index = this.indexes.get(id); if (!index) return undefined;
    const valid = async () => same(index.source, await this.regular(this.source(id))) && same(index.detail, await this.regular(this.path(id, "detail")));
    if (!await valid()) return undefined;
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return structuredClone(cached.run); }
    const handle = await open(this.path(id, "detail"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let text: string;
    try { const info = await handle.stat(); if (!info.isFile() || info.size > COLD_LIMITS.detailBytes) throw new Error("Cold run detail exceeds its bound"); text = await handle.readFile("utf8"); } finally { await handle.close(); }
    if (Buffer.byteLength(text) > COLD_LIMITS.detailBytes || sha(text) !== index.digest || !await valid() || this.indexes.get(id) !== index) return undefined;
    const run = JSON.parse(text) as Run; if (run.id !== id || !coldEligible(run)) return undefined;
    this.remember(id, run, Buffer.byteLength(text)); return structuredClone(run);
  }
  private remember(id: string, run: Run, bytes: number) {
    const old = this.cache.get(id); if (old) { this.bytes -= old.bytes; this.cache.delete(id); }
    while (this.cache.size >= COLD_LIMITS.cacheEntries || this.bytes + bytes > COLD_LIMITS.cacheBytes) { const key = this.cache.keys().next().value as string | undefined; if (!key) break; this.bytes -= this.cache.get(key)!.bytes; this.cache.delete(key); }
    this.cache.set(id, { run, bytes }); this.bytes += bytes;
  }
  /** Sync compatibility for manager.get; detail reads are bounded and cached, never whole logs. */
  get(id: string): Run | undefined {
    const index = this.indexes.get(id); if (!index || !this.valid(id)) return undefined;
    const cached = this.cache.get(id); if (cached) { this.cache.delete(id); this.cache.set(id, cached); return structuredClone(cached.run); }
    const handle = openSync(this.path(id, "detail"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let text: string;
    try { const info = fstatSync(handle); if (!info.isFile() || info.size > COLD_LIMITS.detailBytes) throw new Error("Cold run detail exceeds its bound"); text = readFileSync(handle, "utf8"); } finally { closeSync(handle); }
    if (sha(text) !== index.digest || !this.valid(id)) return undefined;
    const run = JSON.parse(text) as Run; if (run.id !== id || !coldEligible(run)) return undefined;
    this.remember(id, run, Buffer.byteLength(text)); return structuredClone(run);
  }
}
