import { randomUUID } from "node:crypto";
import type { AgentApprovalRequest, ApprovalDecision } from "./adapters/types.js";

export type ApprovalStatus = "pending" | "approved" | "declined" | "expired" | "cancelled";
export interface ApprovalRecord extends Omit<AgentApprovalRequest, "id"> {
  /** Opaque UI identifier, scoped separately from a provider's request identifier. */
  id: string;
  requestId: string;
  runId: string;
  stepId: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  resolvedAt?: number;
}

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}
interface RegistryOptions {
  defaultTimeoutMs?: number;
  maxPending?: number;
  maxPerRun?: number;
  maxPerStep?: number;
  maxRecords?: number;
}

/**
 * Live process requests only: they are never replayed after restart. Each browser action
 * can resolve one request once, before its deadline, in its original run and step.
 */
export class ApprovalRegistry {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private readonly defaultTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPerRun: number;
  private readonly maxPerStep: number;
  private readonly maxRecords: number;

  constructor(options: RegistryOptions = {}) {
    this.defaultTimeoutMs = bounded(options.defaultTimeoutMs, 2 * 60_000, 10 * 60_000);
    this.maxPending = bounded(options.maxPending, 128, 1_024);
    this.maxPerRun = bounded(options.maxPerRun, 32, this.maxPending);
    this.maxPerStep = bounded(options.maxPerStep, 8, this.maxPerRun);
    this.maxRecords = Math.max(this.maxPending, bounded(options.maxRecords, 512, 10_000));
  }

  request(runId: string, stepId: string, raw: AgentApprovalRequest, signal: AbortSignal, options: { timeoutMs?: number } = {}): Promise<ApprovalDecision> {
    if (this.closed || signal.aborted) return Promise.resolve("decline");
    const request = validateRequest(raw);
    if (!runId || !stepId || !request) return Promise.resolve("decline");
    const active = [...this.records.values()].filter((record) => record.status === "pending");
    if (this.pending.size >= this.maxPending || active.filter((record) => record.runId === runId).length >= this.maxPerRun
      || active.filter((record) => record.runId === runId && record.stepId === stepId).length >= this.maxPerStep
      || active.some((record) => record.runId === runId && record.stepId === stepId && record.requestId === request.id)) return Promise.resolve("decline");
    const createdAt = Date.now();
    const timeoutMs = bounded(options.timeoutMs, this.defaultTimeoutMs, 10 * 60_000);
    const id = randomUUID();
    const { id: requestId, ...action } = request;
    const record: ApprovalRecord = { ...action, id, requestId, runId, stepId, createdAt, expiresAt: createdAt + timeoutMs, status: "pending" };
    this.records.set(id, record);
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const cancel = () => { this.finish(id, "cancelled"); };
      const timer = setTimeout(() => this.finish(id, "expired"), timeoutMs);
      this.pending.set(id, { resolve, timer, cleanup: () => signal.removeEventListener("abort", cancel) });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    this.trim();
    this.emit();
    return promise;
  }

  list(runId?: string): ApprovalRecord[] {
    this.expire();
    return [...this.records.values()].filter((record) => !runId || record.runId === runId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map((record) => structuredClone(record));
  }

  respond(id: string, decision: ApprovalDecision, scope: { runId?: string; stepId?: string } = {}): boolean {
    if (decision !== "approve" && decision !== "decline") return false;
    const record = this.records.get(id);
    if (!record || record.status !== "pending" || (scope.runId !== undefined && scope.runId !== record.runId) || (scope.stepId !== undefined && scope.stepId !== record.stepId)) return false;
    if (Date.now() >= record.expiresAt) { this.finish(id, "expired"); return false; }
    return this.finish(id, decision === "approve" ? "approved" : "declined");
  }

  cancelRun(runId: string): void {
    for (const record of this.records.values()) if (record.runId === runId) this.finish(record.id, "cancelled");
  }
  cancelStep(runId: string, stepId: string): void {
    for (const record of this.records.values()) if (record.runId === runId && record.stepId === stepId) this.finish(record.id, "cancelled");
  }
  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.finish(id, "cancelled");
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private expire(): void {
    for (const record of this.records.values()) if (record.status === "pending" && Date.now() >= record.expiresAt) this.finish(record.id, "expired");
  }
  private finish(id: string, status: Exclude<ApprovalStatus, "pending">): boolean {
    const pending = this.pending.get(id);
    const record = this.records.get(id);
    if (!pending || !record || record.status !== "pending") return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    record.status = status;
    record.resolvedAt = Date.now();
    pending.resolve(status === "approved" ? "approve" : "decline");
    this.trim();
    this.emit();
    return true;
  }
  private trim(): void {
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxRecords) break;
      if (record.status !== "pending") this.records.delete(id);
    }
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* An observer cannot change the approval decision. */ }
    }
  }
}

function validateRequest(raw: AgentApprovalRequest): AgentApprovalRequest | undefined {
  if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 240 || !["command", "file-change"].includes(raw.kind)) return;
  for (const [value, limit] of [[raw.command, 16_000], [raw.cwd, 4_096], [raw.reason, 4_000]] as const) if (value !== undefined && (typeof value !== "string" || value.length > limit || value.includes("\0"))) return;
  if (raw.kind === "command" && !raw.command?.trim()) return;
  if (raw.kind === "file-change" && (!raw.paths?.length || raw.paths.length > 200)) return;
  if (raw.paths !== undefined && (!Array.isArray(raw.paths) || raw.paths.some((path) => typeof path !== "string" || !path || path.length > 4_096 || path.includes("\0")))) return;
  return structuredClone({ id: raw.id, kind: raw.kind, ...(raw.command ? { command: raw.command } : {}), ...(raw.cwd ? { cwd: raw.cwd } : {}), ...(raw.reason ? { reason: raw.reason } : {}), ...(raw.paths ? { paths: raw.paths } : {}) });
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.round(value!)) : fallback);
}

export const approvals = new ApprovalRegistry();
