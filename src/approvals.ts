import { randomUUID } from "node:crypto";
import type { AgentApprovalRequest, AgentQuestion, ApprovalDecision } from "./adapters/types.js";

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
  answers?: Record<string, string>;
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

  async ask(runId: string, stepId: string, questions: AgentQuestion[], signal: AbortSignal): Promise<Record<string, string> | undefined> {
    const requestId = randomUUID();
    const decision = await this.request(runId, stepId, { id: requestId, kind: "question", questions }, signal, { timeoutMs: 10 * 60_000 });
    return decision === "approve" ? this.list(runId).find(record => record.stepId === stepId && record.requestId === requestId)?.answers : undefined;
  }

  respond(id: string, decision: ApprovalDecision, scope: { runId?: string; stepId?: string } = {}, answers?: unknown): boolean {
    if (decision !== "approve" && decision !== "decline") return false;
    const record = this.records.get(id);
    if (!record || record.status !== "pending" || (scope.runId !== undefined && scope.runId !== record.runId) || (scope.stepId !== undefined && scope.stepId !== record.stepId)) return false;
    if (Date.now() >= record.expiresAt) { this.finish(id, "expired"); return false; }
    if (decision === "approve" && record.kind === "question") {
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
      const supplied = answers as Record<string, unknown>;
      if (!record.questions?.every(q => typeof supplied[q.id] === "string" && (supplied[q.id] as string).trim().length > 0 && (supplied[q.id] as string).length <= 20_000)) return false;
      record.answers = Object.fromEntries(record.questions.map(q => [q.id, supplied[q.id] as string]));
    }
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
  if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 240 || !["command", "file-change", "tool", "question"].includes(raw.kind)) return;
  if (raw.kind === "tool" && (typeof raw.toolName !== "string" || !raw.toolName || raw.toolName.length > 240 || typeof raw.input !== "string" || raw.input.length > 16_000)) return;
  if (raw.kind === "question" && (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 8 || new Set(raw.questions.map(q => q?.id)).size !== raw.questions.length || raw.questions.some(q => !q || typeof q.id !== "string" || !q.id || q.id.length > 240 || typeof q.question !== "string" || !q.question || q.question.length > 8000 || q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 20 || q.options.some(o => typeof o !== "string" || o.length > 2000))))) return;
  for (const [value, limit] of [[raw.command, 16_000], [raw.cwd, 4_096], [raw.reason, 4_000]] as const) if (value !== undefined && (typeof value !== "string" || value.length > limit || value.includes("\0"))) return;
  if (raw.kind === "command" && !raw.command?.trim()) return;
  if (raw.kind === "file-change" && (!raw.paths?.length || raw.paths.length > 200)) return;
  if (raw.paths !== undefined && (!Array.isArray(raw.paths) || raw.paths.some((path) => typeof path !== "string" || !path || path.length > 4_096 || path.includes("\0")))) return;
  return structuredClone({ id: raw.id, kind: raw.kind, ...(raw.command ? { command: raw.command } : {}), ...(raw.cwd ? { cwd: raw.cwd } : {}), ...(raw.reason ? { reason: raw.reason } : {}), ...(raw.paths ? { paths: raw.paths } : {}), ...(raw.kind === "tool" ? { toolName: raw.toolName, input: raw.input } : {}), ...(raw.kind === "question" ? { questions: raw.questions } : {}) });
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.round(value!)) : fallback);
}

export const approvals = new ApprovalRegistry();
