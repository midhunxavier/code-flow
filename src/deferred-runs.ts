import { MAX_EXECUTION_BUDGET } from "./execution-budget.js";
import { permissionRequirements } from "./run-permissions.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { validateAgentSettings, type AgentSettings } from "./adapters/index.js";
import { validateAgentContainer } from "./agent-container.js";
import { validateVerificationProfile } from "./verification.js";
import { validateContextBudget } from "./context-budget.js";
import { exhausted, type Quota } from "./routing.js";
import { redactText } from "./privacy.js";
import type { AgentId } from "./adapters/types.js";
import type { LoopSettings } from "./engine.js";
import type { SourceInput } from "./github.js";

export interface DeferredRunRequest {
  repo: string; project?: string; pattern: string; task: string;
  projectSelection?: "explicit";
  templateRef?: { id: string; version: number; inputs: Record<string, string> };
  permissionRequirements?: import("./run-permissions.js").PermissionRequirement[];
  roles: Record<string, (AgentId | "auto")[]>; options: Record<string, number | boolean>;
  baseRef?: string; branchPrefix?: string; parentRunId?: string;
  context?: { paths: { path: string }[] };
  agentSettings?: AgentSettings; roleSettings?: Record<string, AgentSettings>;
  loop: Partial<LoopSettings> & { copy: [] };
  trust: "safe"; allowUntrusted: false; approvals: { plan: false; tools: false };
  source?: SourceInput;
  externalSourceRef?: { integration: string; kind: "issue" | "pr"; key: string };
}
export type DeferredRunStatus = "queued" | "waiting-time" | "waiting-provider" | "claimed" | "started" | "failed" | "unknown" | "cancelled";
export interface DeferredRunJob {
  id: string; revision: number; name: string; run: DeferredRunRequest;
  createdAt: number; updatedAt: number; notBefore: number; waitForProviders: AgentId[];
  status: DeferredRunStatus; attempts: number; maxAttempts: number;
  claimId?: string; claimedAt?: number; runId?: string; reason?: string; nextCheckAt?: number; cancelRequested?: boolean;
  operationId?: string; operationHash?: string;
  history: { id: string; at: number; status: DeferredRunStatus; detail: string; claimId?: string; runId?: string }[];
}
export interface DeferredReadiness { ready: boolean; reason?: string; retryAt?: number }
export interface DeferredClaim { jobId: string; claimId: string; attempt: number }
export interface DeferredRunsOptions {
  file?: string; now?: () => number;
  ready: (run: DeferredRunRequest, providers: AgentId[], signal: AbortSignal) => Promise<DeferredReadiness>;
  launch: (run: DeferredRunRequest, claim: DeferredClaim, signal: AbortSignal) => Promise<{ runId: string }>;
  cancelRun?: (runId: string) => Promise<void>;
  readinessTimeoutMs?: number; launchTimeoutMs?: number;
}
export class DeferredRunConflictError extends Error {
  readonly status = 409;
  constructor(readonly current: DeferredRunJob) { super("This deferred job changed. Refresh before acting on it."); }
}
/** Throw only when validation failed before any run/start side effects were attempted. */
export class DeferredRunRejectedError extends Error {}

const AGENTS: AgentId[] = ["claude", "codex", "agy"];
const STATUSES: DeferredRunStatus[] = ["queued", "waiting-time", "waiting-provider", "claimed", "started", "failed", "unknown", "cancelled"];
const PENDING = new Set<DeferredRunStatus>(["queued", "waiting-time", "waiting-provider"]);
/** A known rejection with attempts left still asks for your review, so it counts as open work. */
const retryable = (job: DeferredRunJob) => job.status === "failed" && job.attempts < job.maxAttempts;
/** Only records that need nothing more from you can be removed, explicitly or by retention. */
const finished = (job: DeferredRunJob) => job.status === "started" || job.status === "cancelled" || job.status === "failed" && !retryable(job);
export const DEFERRED_RUN_LIMITS = { active: 100, retained: 200, history: 30, attempts: 3, requestBytes: 96 * 1024, fileBytes: 32 * 1024 * 1024, futureMs: 365 * 24 * 60 * 60_000 };
const queues = new Map<string, Promise<unknown>>();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid deferred ${label}`);
  return value.trim();
}
function keys(value: unknown, allowed: string[], label: string): Record<string, any> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Unsupported deferred ${label} fields`);
  return value;
}
function record<T>(raw: unknown, max: number, parse: (value: unknown) => T, label: string): Record<string, T> {
  if (!object(raw) || Object.keys(raw).length > max || Object.keys(raw).some((key) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key))) throw new Error(`Invalid deferred ${label}`);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, parse(value)]));
}
const given = (value: unknown) => value !== undefined && value !== null;
const positiveDate = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const diagnostic = (value: unknown) => redactText(String(value ?? "Unknown deferred run error")).replace(/\0/g, "").slice(0, 1000);
const canonical = (value: any): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** A second defense behind server validation: only configuration and source references persist. */
export function sanitizeDeferredRequest(value: unknown): DeferredRunRequest {
  const raw = keys(value, ["templateRef", "permissionRequirements", "repo", "project", "projectSelection", "pattern", "task", "roles", "options", "baseRef", "branchPrefix", "parentRunId", "context", "agentSettings", "roleSettings", "loop", "trust", "allowUntrusted", "approvals", "source", "externalSourceRef"], "run request");
  const repo = text(raw.repo, 4000, "repository");
  if (!isAbsolute(repo)) throw new Error("Deferred runs need an absolute repository path");
  const roles = record(raw.roles ?? {}, 20, (value) => {
    if (!Array.isArray(value) || value.length > 6 || value.some((agent) => agent !== "auto" && !AGENTS.includes(agent))) throw new Error("Invalid deferred provider roles");
    return [...new Set(value)] as (AgentId | "auto")[];
  }, "roles");
  const options = record(raw.options ?? {}, 64, (value) => {
    if (typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid deferred pattern option");
    return value;
  }, "options");
  const loopRaw = raw.loop === undefined ? {} : keys(raw.loop, ["check", "setup", "copy", "maxMinutes", "maxSteps", "maxInvocations", "maxTokens", "maxCostUsd", "checkTimeoutMin", "verification", "container", "agentContainer", "contextBudget", "remoteWorker"], "loop");
  const loop: DeferredRunRequest["loop"] = { copy: [] };
  for (const key of ["check", "setup"] as const) if (loopRaw[key] !== undefined && loopRaw[key] !== "") loop[key] = text(loopRaw[key], 4000, `${key} command`);
  const bounds = { maxMinutes: [1, MAX_EXECUTION_BUDGET.maxMinutes], maxSteps: [1, MAX_EXECUTION_BUDGET.maxSteps], maxInvocations: [1, MAX_EXECUTION_BUDGET.maxSteps], maxTokens: [1, 1_000_000_000], maxCostUsd: [0.001, 1_000_000], checkTimeoutMin: [1, 120] };
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) if (loopRaw[key] !== undefined) {
    const number = loopRaw[key], [min, max] = bounds[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min! || number > max!) throw new Error(`Invalid deferred ${key}`);
    loop[key] = number;
  }
  // The composer sends null for "none" (the single configured check, no worker or container), as POST /api/runs accepts.
  if (given(loopRaw.remoteWorker)) loop.remoteWorker = validateWorkerSelection(loopRaw.remoteWorker);
  if (given(loopRaw.verification)) loop.verification = validateVerificationProfile(loopRaw.verification);
  if (given(loopRaw.contextBudget)) loop.contextBudget = validateContextBudget(loopRaw.contextBudget);
  if (given(loopRaw.agentContainer)) loop.agentContainer = validateAgentContainer(loopRaw.agentContainer);
  if (loopRaw.container !== undefined) {
    const container = keys(loopRaw.container, ["image", "network"], "check container");
    const image = text(container.image, 200, "container image");
    if (!/^[\w./:@-]+$/.test(image) || image.startsWith("-")) throw new Error("Invalid deferred container image");
    if (container.network !== undefined && typeof container.network !== "boolean") throw new Error("Invalid deferred container network");
    loop.container = { image, network: container.network !== false };
  }
  const run: DeferredRunRequest = { repo, pattern: text(raw.pattern, 100, "pattern"), task: text(raw.task, 24_000, "task"), roles, options, loop, trust: "safe", allowUntrusted: false, approvals: { plan: false, tools: false } };
  if (raw.permissionRequirements !== undefined) run.permissionRequirements = permissionRequirements(raw.permissionRequirements);
  if (raw.templateRef !== undefined) {
    const ref = keys(raw.templateRef, ["id", "version", "inputs"], "template reference");
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1) throw new Error("Invalid deferred template version");
    run.templateRef = { id: ref.id, version: ref.version, inputs: record(ref.inputs, 24, v => text(v, 10000, "template input"), "template inputs") };
  }
  for (const key of ["project", "baseRef", "branchPrefix", "parentRunId"] as const) if (raw[key] !== undefined && raw[key] !== "") run[key] = text(raw[key], key === "project" || key === "parentRunId" ? 240 : 1000, key);
  if (raw.projectSelection !== undefined) {
    if (raw.projectSelection !== "explicit" || !run.project) throw new Error("Choose an explicit project for the deferred run");
    run.projectSelection = "explicit";
  }
  if (raw.agentSettings !== undefined) run.agentSettings = validateAgentSettings(raw.agentSettings);
  if (raw.roleSettings !== undefined) run.roleSettings = record(raw.roleSettings, 20, (value) => validateAgentSettings(value), "role settings");
  if (raw.context !== undefined) {
    const context = keys(raw.context, ["paths", "attachments"], "context (attachments cannot be deferred)");
    if (context.attachments !== undefined && (!Array.isArray(context.attachments) || context.attachments.length)) throw new Error("Attachments cannot be deferred; remove them before queueing the run");
    if (!Array.isArray(context.paths) || context.paths.length > 50) throw new Error("Invalid deferred context paths");
    run.context = { paths: context.paths.map((value: unknown) => {
      const path = text(keys(value, ["path"], "context path").path, 2000, "context path").replace(/\\/g, "/");
      if (isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Deferred context paths must stay inside the repository");
      return { path };
    }) };
  }
  if (raw.source !== undefined) {
    const source = keys(raw.source, ["kind", "number", "ciLogs", "tool", "numbers"], "GitHub source reference");
    if (!["issue", "pr", "alert"].includes(source.kind) || !Number.isSafeInteger(source.number) || source.number < 1) throw new Error("Invalid deferred GitHub source reference");
    if (source.ciLogs !== undefined && typeof source.ciLogs !== "boolean") throw new Error("Invalid deferred CI log preference");
    run.source = { kind: source.kind, number: source.number, ...(source.ciLogs !== undefined ? { ciLogs: source.ciLogs } : {}) };
    if (source.kind === "alert") {
      if (!["dependabot", "code-scanning"].includes(source.tool)) throw new Error("Invalid deferred alert tool");
      run.source.tool = source.tool;
      if (source.numbers !== undefined) {
        if (!Array.isArray(source.numbers) || source.numbers.length > 50 || source.numbers.some((number: unknown) => !Number.isSafeInteger(number) || Number(number) < 1)) throw new Error("Invalid deferred alert references");
        run.source.numbers = [...new Set<number>(source.numbers)];
      }
    } else if (source.tool !== undefined || source.numbers !== undefined) throw new Error("Alert fields require an alert source");
  }
  if (raw.externalSourceRef !== undefined) {
    const ref = keys(raw.externalSourceRef, ["integration", "kind", "key"], "external source reference");
    if (!["issue", "pr"].includes(ref.kind) || run.source) throw new Error("Choose one deferred source reference");
    run.externalSourceRef = { integration: text(ref.integration, 100, "integration"), kind: ref.kind, key: text(ref.key, 240, "source key") };
  }
  if (Buffer.byteLength(JSON.stringify(run)) > DEFERRED_RUN_LIMITS.requestBytes) throw new Error("Deferred run configuration is too large");
  return run;
}

/** Uses reported windows, never a guessed provider reset or a billable quota probe. */
export function deferredProviderReadiness(providers: AgentId[], quota: Quota, installed?: Set<AgentId>, now = Date.now()): DeferredReadiness {
  const blocked = providers.flatMap((provider) => {
    const reason = installed && !installed.has(provider) ? "is not installed" : exhausted(provider, quota, now);
    if (!reason) return [];
    const q = quota[provider];
    const resets = Object.values(q?.windows ?? {}).flatMap((window) => window.resetsAt && window.resetsAt > now ? [window.resetsAt] : []);
    // Unknown resets and sign-in failures are rechecked; a check time is not a promised reset.
    return [{ provider, reason, retryAt: resets.length ? Math.max(...resets) : now + 60_000 }];
  });
  return blocked.length ? { ready: false, reason: blocked.map((item) => `${item.provider} ${item.reason}`).join("; "), retryAt: Math.max(...blocked.map((item) => item.retryAt)) } : { ready: true };
}

export interface DeferredRunDocument { version: 1; jobs: DeferredRunJob[] }
type Document = DeferredRunDocument;
/** One application server owns the file; local instances also share a transaction queue. */
export class DeferredRuns {
  readonly file: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopped = false;
  private loaded = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  constructor(private readonly options: DeferredRunsOptions) { this.file = resolve(options.file ?? join(CODEFLOW_HOME, "deferred-runs.json")); this.now = options.now ?? Date.now; }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.change((document) => {
      for (const job of document.jobs) if (job.status === "claimed") this.transition(job, "unknown", "The application stopped after claiming this launch. Inspect existing runs before explicitly recovering it.");
    });
    this.loaded = true;
  }
  async list(): Promise<DeferredRunJob[]> { await queues.get(this.file); return clone((await readDocument(this.file)).jobs).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async enqueue(raw: { name?: string; run: unknown; notBefore?: number; waitForProviders?: AgentId[]; maxAttempts?: number; operationId?: string }): Promise<DeferredRunJob> {
    const run = sanitizeDeferredRequest(raw.run), now = this.now();
    const notBefore = raw.notBefore ?? now;
    if (!positiveDate(notBefore) || notBefore > now + DEFERRED_RUN_LIMITS.futureMs) throw new Error("Choose a deferred start within the next year");
    if (raw.waitForProviders !== undefined && (!Array.isArray(raw.waitForProviders) || raw.waitForProviders.length > AGENTS.length || raw.waitForProviders.some((provider) => !AGENTS.includes(provider)))) throw new Error("Choose valid providers to wait for");
    const providers = [...new Set(raw.waitForProviders ?? [])].sort();
    const maxAttempts = raw.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFERRED_RUN_LIMITS.attempts) throw new Error("Deferred jobs permit 1–3 explicit launch attempts");
    const name = raw.name === undefined || raw.name === "" ? run.task.split("\n")[0]!.slice(0, 120) : text(raw.name, 120, "name");
    const operationId = raw.operationId === undefined ? undefined : text(raw.operationId, 240, "operation ID");
    const operationHash = createHash("sha256").update(canonical({ run, name, notBefore: raw.notBefore, providers, maxAttempts })).digest("hex");
    return this.change((document) => {
      const previous = operationId ? document.jobs.find((job) => job.operationId === operationId) : undefined;
      if (previous) { if (previous.operationHash !== operationHash) throw new Error("Deferred operation ID already names different content"); return clone(previous); }
      if (document.jobs.filter((job) => PENDING.has(job.status) || job.status === "claimed" || job.status === "unknown" || retryable(job)).length >= DEFERRED_RUN_LIMITS.active) throw new Error("Deferred queue is full; cancel or resolve older jobs first");
      const job: DeferredRunJob = { id: `d-${randomUUID()}`, revision: 1, name, run, notBefore, waitForProviders: providers, createdAt: now, updatedAt: now, status: notBefore > now ? "waiting-time" : "queued", attempts: 0, maxAttempts, history: [], ...(operationId ? { operationId, operationHash } : {}) };
      this.history(job, "Explicitly queued by you");
      document.jobs.push(job); trim(document); return clone(job);
    });
  }

  async cancel(id: string, expectedRevision: number): Promise<DeferredRunJob> {
    const job = await this.change((document) => {
      // Cancelling twice (say from a second tab) already has the outcome it asked for.
      const cancelled = document.jobs.find((job) => job.id === id && job.status === "cancelled");
      if (cancelled) return clone(cancelled);
      const job = current(document, id, expectedRevision);
      if (job.status === "started") throw new Error("This job already started. Stop its run from the run view.");
      if (job.status === "claimed") { job.cancelRequested = true; this.transition(job, "claimed", "Cancellation requested while launching; the outcome must still be confirmed."); }
      else this.transition(job, "cancelled", job.status === "unknown" ? "Queue recovery cancelled. An unknown launched run may still need to be stopped separately." : "Cancelled before launch");
      return clone(job);
    });
    this.controllers.get(id)?.abort(); return job;
  }
  async retry(id: string, expectedRevision: number, options: { acknowledgeUnknown?: boolean } = {}): Promise<DeferredRunJob> {
    return this.change((document) => {
      const job = current(document, id, expectedRevision);
      if (job.status !== "failed" && job.status !== "unknown") throw new Error("Only failed or unknown launches can be explicitly retried");
      if (job.status === "unknown" && options.acknowledgeUnknown !== true) throw new Error("Inspect existing runs and acknowledge that retrying an unknown launch can duplicate work");
      if (job.attempts >= job.maxAttempts) throw new Error("This deferred job reached its launch attempt limit");
      delete job.claimId; delete job.claimedAt; delete job.runId; delete job.cancelRequested; delete job.nextCheckAt;
      this.transition(job, "queued", "Explicit retry requested; provider availability and configuration will be checked again"); return clone(job);
    });
  }
  /** Dismiss reviewed records. Pending, launching, unknown and retryable jobs stay until resolved or cancelled. */
  async remove(targets: { id: string; expectedRevision: number }[]): Promise<number> {
    if (!Array.isArray(targets) || !targets.length || targets.length > DEFERRED_RUN_LIMITS.retained) throw new Error("Choose deferred records to remove");
    return this.change((document) => {
      const ids = new Set(targets.map((target) => {
        const job = current(document, target?.id, target?.expectedRevision);
        if (!finished(job)) throw new Error("Only started, cancelled or exhausted deferred jobs can be removed; cancel or resolve this job first");
        return job.id;
      }));
      document.jobs = document.jobs.filter((job) => !ids.has(job.id));
      return ids.size;
    });
  }
  /** The HTTP boundary must verify the run's persisted deferred job/claim and repository. */
  async attach(id: string, expectedRevision: number, runId: string): Promise<DeferredRunJob> {
    runId = text(runId, 240, "run ID");
    const snapshot = (await this.list()).find((job) => job.id === id);
    if (!snapshot) throw new Error("Deferred job not found");
    if (snapshot.revision !== expectedRevision) throw new DeferredRunConflictError(snapshot);
    if (snapshot.status !== "unknown" || !snapshot.claimId) throw new Error("Only an unknown claimed launch can be linked");
    if (snapshot.cancelRequested) {
      if (!this.options.cancelRun) throw new Error("The recovered run must be cancelled before resolving this requested cancellation");
      await bounded(this.options.cancelRun(runId), 10_000, new AbortController(), "Recovered run cancellation could not be confirmed");
    }
    return this.change((document) => { const job = current(document, id, expectedRevision); if (job.status !== "unknown" || job.claimId !== snapshot.claimId) throw new Error("Only the reviewed unknown launch can be linked"); job.runId = runId; this.transition(job, job.cancelRequested ? "cancelled" : "started", job.cancelRequested ? "Recovered the matching run and sent its requested cancellation" : "Recovered by linking the run belonging to this exact launch claim"); return clone(job); });
  }

  start(intervalMs = 5000) {
    if (!this.loaded) throw new Error("Load deferred runs before starting the queue");
    if (this.timer) return;
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error("Invalid deferred queue interval");
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => { /* API reads expose storage faults; never launch after an unsuccessful claim. */ }); }, intervalMs);
    this.timer.unref?.();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.controllers.values()) controller.abort(); await this.ticking; await queues.get(this.file); }
  /** At most one launch per tick. Claims are durable before the launch callback can run. */
  tick(force = false): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error("Load deferred runs before checking the queue"));
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.tickOnce(force).finally(() => { if (this.ticking === work) this.ticking = undefined; }); this.ticking = work; return work;
  }
  private async tickOnce(force: boolean) {
    const jobs = (await this.list()).reverse();
    for (const snapshot of jobs) {
      if (!PENDING.has(snapshot.status)) continue;
      const now = this.now();
      if (snapshot.notBefore > now) continue;
      if (!force && (snapshot.nextCheckAt ?? 0) > now) continue;
      const controller = new AbortController(); this.controllers.set(snapshot.id, controller);
      try {
        let ready: DeferredReadiness;
        try { ready = await bounded(this.options.ready(clone(snapshot.run), [...snapshot.waitForProviders], controller.signal), this.options.readinessTimeoutMs ?? 10_000, controller, "Provider availability check timed out"); }
        catch (error) { ready = { ready: false, reason: diagnostic((error as Error).message), retryAt: this.now() + 60_000 }; }
        if (typeof ready?.ready !== "boolean") ready = { ready: false, reason: "Provider readiness returned no valid answer", retryAt: this.now() + 60_000 };
        if (!ready.ready) {
          await this.change((document) => {
            const job = document.jobs.find((job) => job.id === snapshot.id);
            if (!job || !PENDING.has(job.status) || job.revision !== snapshot.revision) return;
            const reason = diagnostic(ready.reason ?? "Waiting for provider capacity");
            job.nextCheckAt = positiveDate(ready.retryAt) && ready.retryAt! > this.now() ? ready.retryAt : this.now() + 60_000;
            this.transition(job, "waiting-provider", reason);
          }); continue;
        }
        if (controller.signal.aborted) continue;
        const claimed = await this.change((document) => {
          const job = document.jobs.find((job) => job.id === snapshot.id);
          if (!job || !PENDING.has(job.status) || job.revision !== snapshot.revision || job.notBefore > this.now() || job.attempts >= job.maxAttempts) return undefined;
          job.attempts++; job.claimId = randomUUID(); job.claimedAt = this.now(); delete job.nextCheckAt;
          this.transition(job, "claimed", "Launch claim saved before execution"); return clone(job);
        });
        if (!claimed) continue;
        const claim = { jobId: claimed.id, claimId: claimed.claimId!, attempt: claimed.attempts };
        if (controller.signal.aborted || this.stopped) {
          await this.change((document) => { const job = document.jobs.find((job) => job.id === claimed.id); if (job?.claimId === claim.claimId && job.status === "claimed") this.transition(job, job.cancelRequested ? "cancelled" : "failed", "Launch stopped before execution began"); });
          return;
        }
        const launch = Promise.resolve().then(() => this.options.launch(clone(claimed.run), claim, controller.signal));
        try {
          const receipt = await bounded(launch, this.options.launchTimeoutMs ?? 30_000, controller, "Launch receipt timed out; the run may already exist");
          const runId = text(receipt?.runId, 240, "launch receipt");
          const cancel = await this.change((document) => {
            const job = document.jobs.find((job) => job.id === claimed.id);
            if (!job || job.claimId !== claim.claimId || job.status !== "claimed") return false;
            job.runId = runId;
            this.transition(job, job.cancelRequested ? "claimed" : "started", job.cancelRequested ? "Launch completed during cancellation; stopping its run" : "Run started; open it to follow execution");
            return job.cancelRequested === true;
          });
          if (cancel) {
            if (!this.options.cancelRun) throw new Error("Launch completed during cancellation; its run must be inspected and stopped manually");
            await bounded(this.options.cancelRun(runId), 10_000, new AbortController(), "Run cancellation could not be confirmed");
            await this.change((document) => { const job = document.jobs.find((job) => job.id === claimed.id); if (job?.claimId === claim.claimId && job.status === "claimed") this.transition(job, "cancelled", "The launched run was sent a cancellation request"); });
          }
        } catch (error) {
          await this.change((document) => { const job = document.jobs.find((job) => job.id === claimed.id); if (!job || job.claimId !== claim.claimId || job.status !== "claimed") return; this.transition(job, error instanceof DeferredRunRejectedError ? "failed" : "unknown", diagnostic((error as Error).message)); });
          // A callback can finish after its timeout/abort. Keep that receipt discoverable,
          // including when the user already recovered into a different attempt.
          void launch.then(async (receipt) => {
            const runId = text(receipt?.runId, 240, "late launch receipt");
            const cancel = await this.change((document) => {
              const job = document.jobs.find((job) => job.id === claimed.id); if (!job) return false;
              if (job.claimId === claim.claimId && job.status === "unknown") { job.runId = runId; this.transition(job, "unknown", "A late run receipt arrived. Link this run after verifying its launch claim."); }
              else { job.history = [...job.history, { id: randomUUID(), at: this.now(), status: "unknown" as const, detail: "A late receipt arrived for an earlier launch attempt", claimId: claim.claimId, runId }].slice(-DEFERRED_RUN_LIMITS.history); job.revision++; job.updatedAt = this.now(); }
              return job.cancelRequested === true && job.claimId === claim.claimId;
            });
            if (cancel && this.options.cancelRun) await this.options.cancelRun(runId);
          }).catch(() => undefined);
        }
        return;
      } finally { if (this.controllers.get(snapshot.id) === controller) this.controllers.delete(snapshot.id); }
    }
  }
  private history(job: DeferredRunJob, detail: string) { job.history = [...job.history, { id: randomUUID(), at: this.now(), status: job.status, detail: diagnostic(detail), ...(job.claimId ? { claimId: job.claimId } : {}), ...(job.runId ? { runId: job.runId } : {}) }].slice(-DEFERRED_RUN_LIMITS.history); }
  private transition(job: DeferredRunJob, status: DeferredRunStatus, reason: string) { job.status = status; job.reason = diagnostic(reason); job.revision++; job.updatedAt = this.now(); this.history(job, reason); }
  private change<T>(mutate: (document: Document) => T): Promise<T> {
    const work = (queues.get(this.file) ?? Promise.resolve()).then(async () => { const document = await readDocument(this.file); const before = JSON.stringify(document); const result = mutate(document); trim(document); if (JSON.stringify(document) !== before) await writeDocument(this.file, document); return result; });
    const tail = work.then(() => undefined, () => undefined); queues.set(this.file, tail);
    void tail.then(() => { if (queues.get(this.file) === tail) queues.delete(this.file); });
    return work.then((result) => { for (const listener of this.listeners) { try { listener(); } catch { /* observers cannot roll back a durable transition */ } } return result; });
  }
}

function current(document: Document, id: string, revision: number) { const job = document.jobs.find((job) => job.id === id); if (!job) throw new Error("Deferred job not found"); if (!Number.isSafeInteger(revision) || revision !== job.revision) throw new DeferredRunConflictError(clone(job)); return job; }
/** Retryable failures count toward the active limit, so retention always finds a finished record to drop first. */
function trim(document: Document) { if (document.jobs.length <= DEFERRED_RUN_LIMITS.retained) return; const removable = document.jobs.filter(finished).sort((a, b) => a.updatedAt - b.updatedAt); const remove = new Set(removable.slice(0, document.jobs.length - DEFERRED_RUN_LIMITS.retained).map((job) => job.id)); document.jobs = document.jobs.filter((job) => !remove.has(job.id)); }
async function bounded<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Deferred callback timeout must be 1–60,000 ms");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Deferred operation was cancelled; its outcome may require review"));
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    timer = setTimeout(() => { reject(new Error(message)); controller.abort(); }, timeoutMs);
  })]); }
  finally { if (timer) clearTimeout(timer); if (abort) controller.signal.removeEventListener("abort", abort); }
}
async function readDocument(file: string): Promise<Document> {
  let body: string;
  try { const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const info = await handle.stat(); if (!info.isFile() || info.size > DEFERRED_RUN_LIMITS.fileBytes) throw new Error("queue must be a bounded regular file"); body = await handle.readFile("utf8"); } finally { await handle.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] }; throw new Error(`Deferred queue cannot be read: ${(error as Error).message}`); }
  try { return validateDeferredDocument(JSON.parse(body)); }
  catch (error) { throw new Error(`Deferred queue cannot be read: ${(error as Error).message}`); }
}

/** Validate backup data without executing or trusting stored authority. */
export function validateDeferredDocument(value: unknown): DeferredRunDocument {
    const document = clone(value) as Document;
    if (document?.version !== 1 || !Array.isArray(document.jobs) || document.jobs.length > DEFERRED_RUN_LIMITS.retained) throw new Error("invalid document");
    const ids = new Set<string>();
    for (const job of document.jobs) {
      if (!object(job) || typeof job.id !== "string" || !/^d-[a-f0-9-]{36}$/.test(job.id) || ids.has(job.id) || !Number.isSafeInteger(job.revision) || job.revision < 1 || !STATUSES.includes(job.status) || !positiveDate(job.createdAt) || !positiveDate(job.updatedAt) || !positiveDate(job.notBefore) || !Number.isInteger(job.attempts) || !Number.isInteger(job.maxAttempts) || job.attempts < 0 || job.attempts > job.maxAttempts || job.maxAttempts < 1 || job.maxAttempts > 3 || !Array.isArray(job.waitForProviders) || job.waitForProviders.length > 3 || job.waitForProviders.some((provider: AgentId) => !AGENTS.includes(provider)) || !Array.isArray(job.history) || job.history.length > DEFERRED_RUN_LIMITS.history) throw new Error("invalid job");
      ids.add(job.id); text(job.name, 120, "saved job name");
      if ((job.nextCheckAt !== undefined && !positiveDate(job.nextCheckAt)) || (job.claimedAt !== undefined && !positiveDate(job.claimedAt)) || (job.cancelRequested !== undefined && typeof job.cancelRequested !== "boolean") || (job.reason !== undefined && (typeof job.reason !== "string" || job.reason.length > 1000 || job.reason.includes("\0"))) || (job.operationId !== undefined && (typeof job.operationId !== "string" || !job.operationId.trim() || job.operationId.length > 240)) || (job.operationHash !== undefined && !/^[a-f0-9]{64}$/.test(job.operationHash))) throw new Error("invalid job metadata");
      if (job.run?.trust !== "safe" || job.run.allowUntrusted !== false || job.run.approvals?.plan !== false || job.run.approvals?.tools !== false || !Array.isArray(job.run.loop?.copy) || job.run.loop.copy.length) throw new Error("unsafe saved run policy");
      job.run = sanitizeDeferredRequest(job.run);
      if ((job.claimId !== undefined && (typeof job.claimId !== "string" || !/^[a-f0-9-]{36}$/.test(job.claimId))) || (["claimed", "unknown", "started"].includes(job.status) && (!job.claimId || !job.attempts)) || (job.runId !== undefined && (typeof job.runId !== "string" || job.runId.length > 240))) throw new Error("invalid claim");
      if ((job.claimId && job.claimedAt === undefined) || (job.status === "started" && !job.runId)) throw new Error("incomplete claim receipt");
      for (const event of job.history) if (!object(event) || typeof event.id !== "string" || !positiveDate(event.at) || !STATUSES.includes(event.status) || typeof event.detail !== "string" || event.detail.length > 1000) throw new Error("invalid history");
    }
    return document;
}

/** Restored configurations never dispatch without a new explicit enqueue. Receipts remain. */
export function disableRestoredDeferredRuns(value: unknown, now = Date.now()): { document: DeferredRunDocument; cancelled: number } {
  if (!positiveDate(now)) throw new Error("Invalid deferred restore time");
  const document = validateDeferredDocument(value);
  let cancelled = 0;
  for (const job of document.jobs) {
    if (job.status === "started" || job.status === "cancelled") continue;
    cancelled++; job.status = "cancelled"; job.cancelRequested = true; job.revision++; job.updatedAt = now;
    delete job.nextCheckAt;
    job.reason = "Cancelled during backup restore. Review the configuration and explicitly enqueue a new job to execute it.";
    job.history = [...job.history, { id: randomUUID(), at: now, status: "cancelled" as const, detail: job.reason, ...(job.claimId ? { claimId: job.claimId } : {}), ...(job.runId ? { runId: job.runId } : {}) }].slice(-DEFERRED_RUN_LIMITS.history);
  }
  return { document, cancelled };
}
async function writeDocument(file: string, document: Document) {
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body) > DEFERRED_RUN_LIMITS.fileBytes) throw new Error("Deferred queue storage limit reached");
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); const folder = await open(dirname(file), "r"); try { await folder.sync(); } finally { await folder.close(); } }
  finally { await rm(temporary, { force: true }); }
}
import { validateWorkerSelection } from "./remote-workers/protocol.js";
