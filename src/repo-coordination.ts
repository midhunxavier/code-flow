import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { sanitizeDeferredRequest, type DeferredReadiness, type DeferredRunRequest } from "./deferred-runs.js";
import { redactText } from "./privacy.js";
import { COORDINATION_LIMITS, coordinationRetryProblem, downstreamTasks } from "./repo-coordination-policy.js";
export { COORDINATION_LIMITS } from "./repo-coordination-policy.js";
import { repositoryIdentity } from "./repository-identity.js";

export interface CoordinationResult { nodeId: string; runId: string; repo: string; branch: string; commit: string; verificationId: string; verifiedAt: number }
export interface CoordinationClaim { jobId: string; nodeId: string; claimId: string; attempt: number; dependencies: CoordinationResult[] }
export type CoordinationNodeStatus = "pending" | "waiting" | "claimed" | "running" | "verified" | "failed" | "unknown" | "blocked" | "cancelled" | "shipping" | "shipping-unknown" | "shipped";
export interface CoordinatedNode {
  jobId: string; id: string; run: DeferredRunRequest; dependsOn: string[]; baseCommit: string; repositoryId: string;
  status: CoordinationNodeStatus; attempts: number; claimId?: string; claimedAt?: number; runId?: string;
  dependencies?: CoordinationResult[]; result?: CoordinationResult; reason?: string; nextCheckAt?: number;
  cancelRequested?: boolean; shippingClaimId?: string; shippedCommit?: string;
}
export interface ShippingValidation { source: string; target: string; tree: string; into: string; verifiedAt: number; verificationId: string }
export interface CoordinationShippingPreview { id: string; createdAt: number; expiresAt: number; entries: { nodeId: string; validation: ShippingValidation }[] }
export interface CoordinatedChange {
  id: string; revision: number; project: string; name: string; createdAt: number; updatedAt: number;
  status: "running" | "blocked" | "ready" | "partial-shipped" | "shipped" | "cancelled";
  cancelRequested: boolean; nodes: CoordinatedNode[]; shipping?: CoordinationShippingPreview;
  operationId?: string; operationHash?: string;
  history: { id: string; at: number; nodeId?: string; detail: string; runId?: string; claimId?: string; commit?: string }[];
}
export type CoordinationObservation = { status: "running" | "failed" | "blocked" | "cancelled" | "missing"; reason?: string } | { status: "verified"; runId: string; repo: string; branch: string; commit: string; verificationId: string; verifiedAt: number };
export interface CoordinatedChangesOptions {
  file?: string; now?: () => number; operationTimeoutMs?: number; launchTimeoutMs?: number;
  /** Canonical, authorized repository and the exact requested starting commit. No mutation. */
  pin: (run: DeferredRunRequest) => Promise<{ repo: string; commit: string }>;
  ready?: (run: DeferredRunRequest, signal: AbortSignal) => Promise<DeferredReadiness>;
  /** Persist and fsync the initial Run.coordination identity before returning a receipt. */
  launch: (run: DeferredRunRequest, claim: CoordinationClaim, signal: AbortSignal) => Promise<{ runId: string }>;
  /** Check exact owned identity, current branch HEAD and genuine current verification evidence. */
  validateResult: (node: CoordinatedNode, signal: AbortSignal) => Promise<CoordinationObservation>;
  previewShipping: (node: CoordinatedNode, into: string, signal: AbortSignal) => Promise<ShippingValidation>;
  /** Must enforce the supplied source/target/tree with compare-and-swap; never push implicitly. */
  ship: (node: CoordinatedNode, validation: ShippingValidation, signal: AbortSignal) => Promise<{ commit: string; detail?: string }>;
  confirmShipping?: (node: CoordinatedNode, validation: ShippingValidation, commit: string, signal: AbortSignal) => Promise<boolean>;
  cancelRun?: (runId: string) => Promise<void>;
}
export class CoordinationConflictError extends Error { readonly status = 409; constructor(readonly current: CoordinatedChange) { super("This coordinated change changed. Refresh before acting."); } }
/** Only for definite pre-start rejection; ordinary launch errors can follow side effects. */
export class CoordinationRejectedError extends Error {}
export interface CoordinationDocument { version: 1; jobs: CoordinatedChange[] }
const queues = new Map<string, Promise<unknown>>();
const states: CoordinationNodeStatus[] = ["pending", "waiting", "claimed", "running", "verified", "failed", "unknown", "blocked", "cancelled", "shipping", "shipping-unknown", "shipped"];
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);
const canonical = (value: any) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
const commitId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
const date = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
const text = (value: unknown, maximum: number, label: string): string => { if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new Error(`Invalid coordinated ${label}`); return value.trim(); };
const diagnostic = (value: unknown) => redactText(String(value ?? "Unknown coordinated change error")).replace(/\0/g, "").slice(0, 1000);
function onlyKeys(value: Record<string, any>, allowed: string[], label: string) { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Unsupported coordinated ${label} fields`); }
function branch(value: unknown): string { const result = text(value, 240, "branch"); if (result.startsWith("-") || /[\s~^:?*\[\\]/.test(result) || result.includes("..") || result.includes("@{") || result.startsWith("/") || result.endsWith("/") || result.endsWith(".") || result.split("/").some((part) => !part || part.endsWith(".lock"))) throw new Error("Choose a valid local Git branch"); return result; }
function safeRun(value: unknown, project: string): DeferredRunRequest {
  const run = sanitizeDeferredRequest(value); if (run.parentRunId) throw new Error("Coordinated tasks start from pinned repository commits; parent-run inheritance is unavailable");
  run.project = project;
  run.loop = { ...run.loop, copy: [], maxSteps: Math.min(50, Math.floor(run.loop.maxSteps ?? 20)), maxInvocations: Math.min(50, Math.floor(run.loop.maxInvocations ?? run.loop.maxSteps ?? 20)), maxMinutes: Math.min(60, run.loop.maxMinutes ?? 15), maxTokens: Math.min(2_000_000, run.loop.maxTokens ?? 500_000), maxCostUsd: Math.min(100, run.loop.maxCostUsd ?? 25) };
  return run;
}
function checkGraph(nodes: { id: string; dependsOn: string[] }[]) {
  const names = new Set(nodes.map((node) => node.id)); if (names.size !== nodes.length || nodes.some((node) => !id(node.id) || !Array.isArray(node.dependsOn) || node.dependsOn.length >= nodes.length || new Set(node.dependsOn).size !== node.dependsOn.length || node.dependsOn.some((dependency) => !names.has(dependency) || dependency === node.id))) throw new Error("Choose distinct task IDs and dependencies from this coordinated change");
  const visiting = new Set<string>(), visited = new Set<string>(); const visit = (name: string) => { if (visiting.has(name)) throw new Error("Coordinated task dependencies contain a cycle"); if (visited.has(name)) return; visiting.add(name); nodes.find((node) => node.id === name)!.dependsOn.forEach(visit); visiting.delete(name); visited.add(name); }; nodes.forEach((node) => visit(node.id));
}
function result(value: unknown, nodeId: string): CoordinationResult {
  if (!object(value) || value.nodeId !== nodeId || !id(value.runId) || typeof value.repo !== "string" || !isAbsolute(value.repo) || !commitId(value.commit) || !date(value.verifiedAt)) throw new Error("Invalid coordinated verified result");
  onlyKeys(value, ["nodeId", "runId", "repo", "branch", "commit", "verificationId", "verifiedAt", "status"], "verified result");
  return { nodeId, runId: value.runId, repo: value.repo, branch: branch(value.branch), commit: value.commit, verificationId: text(value.verificationId, 240, "verification identity"), verifiedAt: value.verifiedAt };
}
function validation(value: unknown): ShippingValidation {
  if (!object(value) || !commitId(value.source) || !commitId(value.target) || !commitId(value.tree) || !date(value.verifiedAt)) throw new Error("Shipping requires exact verified source, target and tree commits");
  onlyKeys(value, ["source", "target", "tree", "into", "verifiedAt", "verificationId"], "shipping validation");
  return { source: value.source, target: value.target, tree: value.tree, into: branch(value.into), verifiedAt: value.verifiedAt, verificationId: text(value.verificationId, 240, "shipping verification identity") };
}
function refresh(job: CoordinatedChange) {
  const nodes = job.nodes; job.status = job.cancelRequested ? "cancelled" : nodes.every((node) => node.status === "shipped") ? "shipped" : nodes.some((node) => ["shipped", "shipping", "shipping-unknown"].includes(node.status)) ? "partial-shipped" : nodes.every((node) => node.status === "verified") ? "ready" : nodes.some((node) => ["failed", "unknown", "blocked", "cancelled"].includes(node.status)) ? "blocked" : "running";
}
function blockDependentResults(job: CoordinatedChange, nodeId: string, now: number) {
  const downstream = downstreamTasks(job, nodeId);
  for (const node of job.nodes) if (node.id !== nodeId && downstream.has(node.id) && node.status === "verified") {
    node.status = "blocked"; node.reason = `Dependency ${nodeId}'s verified result changed. Retry ${nodeId} first to refresh downstream evidence.`;
    history(job, now, node.reason, node);
  }
}
function invalidatePreview(job: CoordinatedChange) { if (!job.nodes.some((node) => ["shipping", "shipping-unknown"].includes(node.status))) delete job.shipping; }
function history(job: CoordinatedChange, now: number, detail: string, node?: CoordinatedNode, fields: { runId?: string; claimId?: string; commit?: string } = {}) { job.updatedAt = now; job.history.push({ id: randomUUID(), at: now, detail: diagnostic(detail), ...(node ? { nodeId: node.id } : {}), ...fields }); job.history = job.history.slice(-COORDINATION_LIMITS.history); refresh(job); }
function current(document: CoordinationDocument, name: string, revision: number) { const job = document.jobs.find((item) => item.id === name); if (!job) throw new Error("Coordinated change not found"); if (!Number.isSafeInteger(revision) || job.revision !== revision) throw new CoordinationConflictError(copy(job)); return job; }
function getNode(job: CoordinatedChange, name: string) { const node = job.nodes.find((item) => item.id === name); if (!node) throw new Error("Coordinated task not found"); return node; }
const sameResult = (left: CoordinationResult, right: CoordinationResult) => left.nodeId === right.nodeId && left.runId === right.runId && left.repo === right.repo && left.branch === right.branch && left.commit === right.commit && left.verificationId === right.verificationId;

/** Single-owner durable local coordinator. Mutations serialize across local instances. */
export class CoordinatedChanges {
  readonly file: string; private readonly now: () => number; private loaded = false; private stopped = false; private loadFault?: Error;
  private readonly schedule = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>; private ticking?: Promise<void>; private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly options: CoordinatedChangesOptions) { this.file = resolve(options.file ?? join(CODEFLOW_HOME, "coordinated-changes.json")); this.now = options.now ?? Date.now; }
  async load() { if (this.loaded) return; try { await this.change((document) => { for (const job of document.jobs) for (const node of job.nodes) { if (node.status === "claimed" || node.status === "shipping") { node.status = node.status === "claimed" ? "unknown" : "shipping-unknown"; node.reason = "The application stopped after claiming an operation. Inspect its exact receipt before recovery."; history(job, this.now(), node.reason, node); } } }); this.loaded = true; } catch (error) { this.loadFault = error as Error; throw error; } }
  async list(): Promise<CoordinatedChange[]> { if (this.loadFault) throw this.loadFault; await queues.get(this.file); return copy((await readDocument(this.file)).jobs).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)); }
  async create(raw: { project: string; name: string; nodes: { id: string; run: unknown; dependsOn: string[] }[]; operationId?: string }): Promise<CoordinatedChange> {
    if (this.loadFault) throw this.loadFault;
    const project = text(raw.project, 240, "project"), name = text(raw.name, 120, "name"); if (!Array.isArray(raw.nodes) || raw.nodes.length < 2 || raw.nodes.length > COORDINATION_LIMITS.nodes) throw new Error("Coordinate 2–10 repositories");
    const nodes = raw.nodes.map((node) => { if (!object(node) || !Array.isArray(node.dependsOn) || Object.keys(node).some((key) => !["id", "run", "dependsOn"].includes(key))) throw new Error("Unsupported coordinated task fields"); return { id: node.id, dependsOn: [...node.dependsOn], run: safeRun(node.run, project) }; }); checkGraph(nodes);
    const operationId = raw.operationId === undefined ? undefined : text(raw.operationId, 240, "operation identity"), operationHash = digest({ project, name, nodes });
    const previous = operationId ? (await this.list()).find((job) => job.operationId === operationId) : undefined;
    if (previous) { if (previous.operationHash !== operationHash) throw new Error("This coordinated operation ID already names different content"); return previous; }
    const pins = await Promise.all(nodes.map(async (node) => { const pinned = await this.options.pin(copy(node.run)); if (!commitId(pinned.commit) || !isAbsolute(pinned.repo) || await realpath(pinned.repo) !== pinned.repo) throw new Error("Pin a canonical authorized repository and exact commit"); return { ...pinned, repositoryId: await repositoryIdentity(pinned.repo) }; }));
    if (new Set(pins.map((pin) => pin.repo)).size !== pins.length || new Set(pins.map((pin) => pin.repositoryId)).size !== pins.length) throw new Error("Each coordinated task must own a distinct repository, with independent Git branch storage");
    return this.change((document) => {
      const previous = operationId ? document.jobs.find((job) => job.operationId === operationId) : undefined; if (previous) { if (previous.operationHash !== operationHash) throw new Error("This coordinated operation ID already names different content"); return copy(previous); }
      if (document.jobs.filter((job) => !["cancelled", "shipped"].includes(job.status)).length >= COORDINATION_LIMITS.active) throw new Error("Resolve or cancel older coordinated changes before creating another");
      const now = this.now(), jobId = `c-${randomUUID()}`;
      const job: CoordinatedChange = { id: jobId, revision: 1, project, name, createdAt: now, updatedAt: now, status: "running", cancelRequested: false, nodes: nodes.map((node, index) => ({ jobId, id: node.id, run: { ...node.run, repo: pins[index]!.repo, baseRef: pins[index]!.commit }, dependsOn: [...node.dependsOn].sort(), baseCommit: pins[index]!.commit, repositoryId: pins[index]!.repositoryId, status: "pending", attempts: 0 })), history: [], ...(operationId ? { operationId, operationHash } : {}) };
      history(job, now, "Explicitly created with pinned repository bases and bounded safe tasks"); document.jobs.push(job);
      while (document.jobs.length > COORDINATION_LIMITS.retained) { const index = document.jobs.findIndex((item) => item.id !== job.id && ["cancelled", "shipped"].includes(item.status)); if (index < 0) throw new Error("Coordinated history is full"); document.jobs.splice(index, 1); }
      return copy(job);
    });
  }
  async cancel(name: string, revision: number) {
    const job = await this.change((document) => { const job = current(document, name, revision); job.cancelRequested = true; invalidatePreview(job); for (const node of job.nodes) { node.cancelRequested = true; if (node.status === "verified") { node.status = "cancelled"; history(job, this.now(), "Withdrew this verified result from shipping; its run, branch and commits are kept", node, { runId: node.runId }); } else if (["pending", "waiting", "blocked", "failed"].includes(node.status)) node.status = "cancelled"; } history(job, this.now(), "Cancellation requested for all unshipped tasks"); return copy(job); });
    for (const [key, controller] of this.controllers) if (key.startsWith(job.id + ":")) controller.abort();
    for (const node of job.nodes.filter((node) => node.runId && ["running", "unknown"].includes(node.status))) {
      try { if (!this.options.cancelRun) throw new Error("Stop the known run separately; cancellation is not configured"); await this.options.cancelRun(node.runId!); await this.updateNode(job.id, node.id, node.claimId, (latest, item) => { item.status = "cancelled"; history(latest, this.now(), "Sent cancellation to this exact owned run", item, { runId: node.runId }); }); }
      catch (error) { await this.updateNode(job.id, node.id, node.claimId, (latest, item) => { item.reason = diagnostic(error); history(latest, this.now(), "Run cancellation could not be confirmed: " + item.reason, item, { runId: node.runId }); }); }
    }
    return (await this.list()).find((item) => item.id === name)!;
  }
  async retryNode(name: string, nodeId: string, revision: number, options: { acknowledgeUnknown?: boolean } = {}) {
    return this.change((document) => {
      const job = current(document, name, revision), node = getNode(job, nodeId); if (!["failed", "unknown", "blocked", "cancelled"].includes(node.status)) throw new Error("Retry an explicitly failed, unknown, blocked or cancelled task"); if (node.status === "unknown" && options.acknowledgeUnknown !== true) throw new Error("Inspect existing runs and acknowledge possible duplicate work before retrying an unknown claim");
      const problem = coordinationRetryProblem(job, nodeId); if (problem) throw new Error(problem);
      const closure = downstreamTasks(job, nodeId);
      if (job.nodes.some((item) => ["shipping", "shipping-unknown"].includes(item.status))) throw new Error("Resolve every claimed or unknown shipping operation before retrying tasks");
      if (job.nodes.some((item) => closure.has(item.id) && item.status === "unknown") && options.acknowledgeUnknown !== true) throw new Error("Inspect every unknown dependent launch and acknowledge possible duplicate work before invalidating it");
      if (job.nodes.some((item) => closure.has(item.id) && ["claimed", "running", "shipping", "shipping-unknown", "shipped"].includes(item.status))) throw new Error("Stop active dependent work and resolve shipping before invalidating its inputs");
      job.cancelRequested = false; delete job.shipping;
      for (const item of job.nodes.filter((item) => closure.has(item.id))) { history(job, this.now(), "Explicit retry invalidated this task's prior result and downstream evidence", item, { ...(item.runId ? { runId: item.runId } : {}), ...(item.claimId ? { claimId: item.claimId } : {}) }); for (const key of ["claimId", "claimedAt", "runId", "dependencies", "result", "reason", "nextCheckAt", "cancelRequested"] as const) delete item[key]; item.status = "pending"; this.schedule.delete(`${job.id}:${item.id}`); }
      refresh(job); return copy(job);
    });
  }
  /** The callback checks exact persisted Run.coordination identity before an unknown claim is linked. */
  async attach(name: string, nodeId: string, revision: number, runId: string) {
    if (!id(runId)) throw new Error("Choose a valid run ID"); const snapshot = (await this.list()).find((job) => job.id === name); if (!snapshot) throw new Error("Coordinated change not found"); if (snapshot.revision !== revision) throw new CoordinationConflictError(snapshot); const node = getNode(snapshot, nodeId); if (node.status !== "unknown" || !node.claimId) throw new Error("Only an unknown exact claim can be recovered");
    const probe = { ...node, runId }, observed = await this.withOperation(`${name}:${nodeId}:attach`, (signal) => this.observe(probe, signal)); if (observed.status === "missing") throw new Error("This run does not belong to the exact owned coordinated launch claim");
    if (snapshot.cancelRequested || node.cancelRequested) { if (!this.options.cancelRun) throw new Error("The recovered run must be stopped before resolving requested cancellation"); await this.options.cancelRun(runId); }
    return this.change((document) => { const job = current(document, name, revision), latest = getNode(job, nodeId); if (latest.claimId !== node.claimId || latest.status !== "unknown") throw new Error("The reviewed launch claim changed"); latest.runId = runId; latest.status = job.cancelRequested || latest.cancelRequested ? "cancelled" : "running"; history(job, this.now(), "Linked a run matching the exact persisted launch claim", latest, { runId, claimId: latest.claimId }); return copy(job); });
  }
  async previewShipping(name: string, revision: number, targets: Record<string, string>) {
    const job = (await this.list()).find((item) => item.id === name); if (!job) throw new Error("Coordinated change not found"); if (job.revision !== revision) throw new CoordinationConflictError(job); if (job.cancelRequested || job.nodes.some((node) => !["verified", "shipped"].includes(node.status))) throw new Error("Every task needs a current verified immutable result before shipping review");
    if (!object(targets) || Object.keys(targets).length !== job.nodes.filter((node) => node.status !== "shipped").length || Object.keys(targets).some((nodeId) => !job.nodes.some((node) => node.id === nodeId && node.status !== "shipped"))) throw new Error("Choose a local target branch for each unshipped repository");
    await this.assertResults(job);
    const entries: CoordinationShippingPreview["entries"] = []; for (const node of job.nodes.filter((node) => node.status !== "shipped")) { const into = branch(targets[node.id]); const checked = validation(await this.withOperation(`${name}:${node.id}:preview`, (signal) => this.options.previewShipping(copy(node), into, signal))); if (checked.source !== node.result!.commit || checked.into !== into) throw new Error("Shipping validation did not verify the pinned result and selected target"); entries.push({ nodeId: node.id, validation: checked }); }
    await this.assertResults(job);
    return this.change((document) => { const currentJob = current(document, name, revision), now = this.now(); currentJob.shipping = { id: randomUUID(), createdAt: now, expiresAt: now + COORDINATION_LIMITS.previewMs, entries }; history(currentJob, now, "Reviewed exact source/target/tree shipping matrix; each repository still needs an explicit action"); return copy(currentJob); });
  }
  async shipNode(name: string, nodeId: string, revision: number, previewId: string) {
    const job = (await this.list()).find((item) => item.id === name); if (!job) throw new Error("Coordinated change not found"); if (job.revision !== revision) throw new CoordinationConflictError(job); const node = getNode(job, nodeId), entry = job.shipping?.entries.find((entry) => entry.nodeId === nodeId);
    if (job.cancelRequested || !entry || job.shipping?.id !== previewId || job.shipping.expiresAt <= this.now() || node.status !== "verified") throw new Error("Review a fresh shipping matrix and select an unshipped verified task");
    await this.assertResults(job);
    const checked = validation(await this.withOperation(`${name}:${nodeId}:preship`, (signal) => this.options.previewShipping(copy(node), entry.validation.into, signal)));
    if (["source", "target", "tree", "into"].some((key) => checked[key as keyof ShippingValidation] !== entry.validation[key as keyof ShippingValidation])) throw new Error("The reviewed source, target or merge tree changed; no shipping was attempted");
    const claimed = await this.change((document) => { const currentJob = current(document, name, revision), latest = getNode(currentJob, nodeId); if (currentJob.shipping?.id !== previewId || currentJob.shipping.expiresAt <= this.now() || latest.status !== "verified") throw new Error("The reviewed shipping operation changed or expired"); latest.status = "shipping"; latest.shippingClaimId = randomUUID(); history(currentJob, this.now(), "Claimed this explicit repository shipping operation durably", latest, { claimId: latest.shippingClaimId }); return copy(latest); });
    try { const shipped = await this.withOperation(`${name}:${nodeId}:ship`, (signal) => this.options.ship(claimed, copy(entry.validation), signal), this.options.launchTimeoutMs ?? 120_000); if (!commitId(shipped.commit)) throw new Error("Shipping returned an invalid commit receipt"); await this.recordShipping(name, nodeId, claimed.shippingClaimId!, shipped.commit, shipped.detail); }
    catch (error) { await this.updateNode(name, nodeId, claimed.claimId, (currentJob, latest) => { if (latest.shippingClaimId === claimed.shippingClaimId && latest.status === "shipping") { latest.status = "shipping-unknown"; latest.reason = diagnostic(error); history(currentJob, this.now(), "Shipping outcome is unknown; inspect the target before manual recovery: " + latest.reason, latest, { claimId: latest.shippingClaimId }); } }); }
    return (await this.list()).find((item) => item.id === name)!;
  }
  async recoverShipping(name: string, nodeId: string, revision: number, commit: string) {
    const job = (await this.list()).find((item) => item.id === name); if (!job) throw new Error("Coordinated change not found"); if (job.revision !== revision) throw new CoordinationConflictError(job); const node = getNode(job, nodeId), entry = job.shipping?.entries.find((entry) => entry.nodeId === nodeId);
    if (node.status !== "shipping-unknown" || !entry || !commitId(commit) || !this.options.confirmShipping) throw new Error("An unknown shipping operation needs a verifiable exact commit receipt");
    if (!await this.withOperation(`${name}:${nodeId}:recover-ship`, (signal) => this.options.confirmShipping!(copy(node), copy(entry.validation), commit, signal))) throw new Error("That commit does not prove the exact reviewed source/target/tree shipping operation");
    return this.change((document) => { const latest = current(document, name, revision), item = getNode(latest, nodeId); if (item.status !== "shipping-unknown" || item.shippingClaimId !== node.shippingClaimId) throw new Error("Shipping recovery claim changed"); item.status = "shipped"; item.shippedCommit = commit; history(latest, this.now(), "Recovered this exact shipping commit after manual review", item, { commit }); return copy(latest); });
  }
  start(intervalMs = 5000) { if (this.loadFault) return; if (!this.loaded) throw new Error("Load coordinated changes before dispatch"); if (this.timer) return; if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error("Invalid coordination interval"); this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs); this.timer.unref?.(); }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.controllers.values()) controller.abort(); await this.ticking; await queues.get(this.file); }
  tick(): Promise<void> { if (!this.loaded) return Promise.reject(new Error("Load coordinated changes before dispatch")); if (this.stopped) return Promise.resolve(); if (this.ticking) return this.ticking; const work = this.tickOnce().finally(() => { if (this.ticking === work) this.ticking = undefined; }); this.ticking = work; return work; }
  private async tickOnce() {
    for (const jobSnapshot of (await this.list()).reverse()) {
      if (jobSnapshot.cancelRequested || jobSnapshot.status === "shipped") continue;
      for (const node of jobSnapshot.nodes.filter((node) => ["running", "verified"].includes(node.status))) {
        let observed: CoordinationObservation;
        try { observed = await this.withOperation(`${jobSnapshot.id}:${node.id}:observe`, (signal) => this.observe(copy(node), signal)); }
        catch { continue; } // An unavailable read is not evidence of failure or permission to launch.
        await this.updateNode(jobSnapshot.id, node.id, node.claimId, (job, latest) => {
          if (job.cancelRequested || !["running", "verified"].includes(latest.status)) return;
          const staleInput = latest.dependencies?.find(input => { const parent = getNode(job, input.nodeId); return !parent.result || !["verified", "shipping", "shipped"].includes(parent.status) || !sameResult(input, parent.result); });
          if (observed.status === "verified" && staleInput) { latest.status = "blocked"; latest.reason = `Dependency ${staleInput.nodeId}'s verified result changed. Retry ${staleInput.nodeId} first to refresh downstream evidence.`; invalidatePreview(job); history(job, this.now(), latest.reason, latest); blockDependentResults(job, latest.id, this.now()); return; }
          if (observed.status === "verified") { const checked = result({ ...observed, nodeId: node.id }, node.id); if (checked.runId !== latest.runId || checked.repo !== latest.run.repo) throw new Error("Verified result does not match its claimed run and repository"); if (latest.result && !sameResult(latest.result, checked)) { latest.status = "blocked"; latest.reason = "The result branch or verification evidence changed after it was pinned"; invalidatePreview(job); history(job, this.now(), latest.reason, latest); } else if (latest.status !== "verified") { latest.result = checked; latest.status = "verified"; delete latest.reason; history(job, this.now(), "Pinned the current immutable result and genuine verification receipt", latest, { runId: latest.runId, commit: checked.commit }); } }
          else if (observed.status !== "running" || latest.status === "verified") { latest.status = observed.status === "cancelled" ? "cancelled" : observed.status === "failed" ? "failed" : "blocked"; latest.reason = diagnostic(observed.reason ?? "The result or verification evidence is unavailable or no longer current"); invalidatePreview(job); history(job, this.now(), latest.reason, latest); }
          if (latest.status !== "verified" && latest.result) blockDependentResults(job, latest.id, this.now());
        });
      }
      const job = (await this.list()).find((item) => item.id === jobSnapshot.id)!; if (job.cancelRequested) continue;
      for (const node of job.nodes.filter((item) => ["pending", "waiting"].includes(item.status))) {
        if (Math.max(node.nextCheckAt ?? 0, this.schedule.get(`${job.id}:${node.id}`) ?? 0) > this.now()) continue;
        try { if (await repositoryIdentity(node.run.repo) !== node.repositoryId) throw new Error("The pinned repository metadata was replaced"); }
        catch (error) { await this.updateNode(job.id, node.id, undefined, (latest, item) => { if (!latest.cancelRequested && ["pending", "waiting"].includes(item.status)) { item.status = "blocked"; item.reason = diagnostic(error); history(latest, this.now(), item.reason, item); } }); continue; }
        const dependencies = node.dependsOn.map((name) => getNode(job, name));
        if (dependencies.some((item) => !["verified", "shipped"].includes(item.status) || !item.result)) { await this.wait(job.id, node.id, "Waiting for every dependency's current verified result"); continue; }
        try { await this.assertResults(job, dependencies); }
        catch (error) { await this.wait(job.id, node.id, diagnostic(error)); continue; }
        const ready = this.options.ready ? await this.withOperation(`${job.id}:${node.id}:ready`, (signal) => this.options.ready!(copy(node.run), signal)).catch((error) => ({ ready: false, reason: diagnostic(error), retryAt: this.now() + 60_000 })) : { ready: true };
        if (!ready.ready) { await this.wait(job.id, node.id, diagnostic(ready.reason ?? "Waiting for provider readiness"), ready.retryAt); continue; }
        if (this.stopped) return;
        const claimed = await this.change((document) => { const currentJob = document.jobs.find((item) => item.id === job.id); if (!currentJob || currentJob.cancelRequested) return; const item = getNode(currentJob, node.id); if (!["pending", "waiting"].includes(item.status) || item.attempts >= COORDINATION_LIMITS.attempts) return; const inputs = item.dependsOn.map((name) => getNode(currentJob, name)); if (inputs.some((dependency, index) => !["verified", "shipped"].includes(dependency.status) || !dependency.result || !sameResult(dependency.result, dependencies[index]!.result!))) return; item.status = "claimed"; item.claimId = randomUUID(); item.claimedAt = this.now(); item.attempts++; item.dependencies = inputs.map((dependency) => copy(dependency.result!)); delete item.reason; delete item.nextCheckAt; history(currentJob, this.now(), "Durably claimed one bounded safe repository task", item, { claimId: item.claimId }); return copy(item); });
        if (!claimed) continue;
        const controller = new AbortController(), key = `${job.id}:${node.id}:launch`; this.controllers.set(key, controller);
        const claim: CoordinationClaim = { jobId: job.id, nodeId: node.id, claimId: claimed.claimId!, attempt: claimed.attempts, dependencies: copy(claimed.dependencies!) };
        const launch = Promise.resolve().then(() => this.options.launch(copy(claimed.run), claim, controller.signal));
        void launch.then((receipt) => this.recordReceipt(job.id, node.id, claimed.claimId!, receipt.runId)).catch(() => undefined);
        try { const receipt = await bounded(launch, this.options.launchTimeoutMs ?? 60_000, controller); await this.recordReceipt(job.id, node.id, claimed.claimId!, receipt.runId); }
        catch (error) { await this.updateNode(job.id, node.id, claimed.claimId, (latest, item) => { if (item.status === "claimed") { item.status = error instanceof CoordinationRejectedError ? "failed" : "unknown"; item.reason = diagnostic(error); history(latest, this.now(), item.reason, item, { claimId: item.claimId }); } }); }
        finally { this.controllers.delete(key); }
        return; // One new launch per tick; callbacks and timers cannot duplicate claims.
      }
    }
  }
  private async assertResults(job: CoordinatedChange, selected = job.nodes) {
    const closure = new Set(selected.map((node) => node.id)); for (let changed = true; changed;) { changed = false; for (const node of job.nodes.filter((node) => closure.has(node.id))) for (const dependency of node.dependsOn) if (!closure.has(dependency)) { closure.add(dependency); changed = true; } }
    for (const node of job.nodes.filter((node) => closure.has(node.id))) {
      if (!node.result || !["verified", "shipped"].includes(node.status)) throw new Error("A dependency or result is not currently verified");
      const observation = await this.withOperation(`${job.id}:${node.id}:verify-pin`, (signal) => this.observe(copy(node), signal));
      if (observation.status !== "verified") throw new Error(observation.reason ?? `${node.id} no longer has a current verified result`);
      if (!sameResult(node.result, result({ ...observation, nodeId: node.id }, node.id))) throw new Error(`${node.id} changed after its result was pinned; retry it before continuing`);
      for (const input of node.dependencies ?? []) { const parent = getNode(job, input.nodeId); if (!parent.result || !sameResult(input, parent.result) || !["verified", "shipped"].includes(parent.status)) throw new Error("Downstream evidence refers to an invalidated dependency result"); }
    }
  }
  private async observe(node: CoordinatedNode, signal: AbortSignal): Promise<CoordinationObservation> { try { if (await repositoryIdentity(node.run.repo) !== node.repositoryId) return { status: "missing", reason: "The pinned repository metadata was replaced" }; } catch (error) { return { status: "missing", reason: diagnostic(error) }; } signal.throwIfAborted(); return this.options.validateResult(node, signal); }
  private async wait(jobId: string, nodeId: string, reason: string, retryAt?: number) { await this.updateNode(jobId, nodeId, undefined, (job, node) => { if (job.cancelRequested || !["pending", "waiting"].includes(node.status)) return; const next = date(retryAt) ? Math.max(this.now() + 100, Math.min(this.now() + 24 * 60 * 60_000, retryAt)) : this.now() + 1000; this.schedule.set(`${jobId}:${nodeId}`, next); if (node.status === "waiting" && node.reason === reason) return; node.status = "waiting"; node.reason = reason; node.nextCheckAt = next; history(job, this.now(), reason, node); }); }
  private async recordReceipt(jobId: string, nodeId: string, claimId: string, runId: string) {
    if (!id(runId)) throw new Error("Invalid coordinated run receipt"); let cancel = false;
    await this.change((document) => { const job = document.jobs.find((item) => item.id === jobId); if (!job) return; const node = getNode(job, nodeId); if (node.claimId !== claimId) { if (!job.history.some((entry) => entry.claimId === claimId && entry.runId === runId)) history(job, this.now(), "Late receipt for an earlier explicitly retried claim; stopping duplicate work", node, { claimId, runId }); cancel = true; return; } if (node.runId === runId && !["claimed", "unknown"].includes(node.status)) return; if (!["claimed", "unknown"].includes(node.status)) throw new Error("The current launch no longer accepts a receipt"); node.runId = runId; node.status = "running"; delete node.reason; cancel = job.cancelRequested || node.cancelRequested === true; history(job, this.now(), "Recorded the durable matching run receipt", node, { claimId, runId }); });
    if (cancel) {
      try { if (!this.options.cancelRun) throw new Error("Run cancellation is not configured; stop this exact run separately"); await this.options.cancelRun(runId); await this.updateNode(jobId, nodeId, claimId, (job, node) => { if (node.runId === runId) { node.status = "cancelled"; history(job, this.now(), "Cancelled the late matching run after requested cancellation", node, { claimId, runId }); } }); }
      catch (error) { await this.updateNode(jobId, nodeId, claimId, (job, node) => { if (node.runId === runId) { node.reason = diagnostic(error); history(job, this.now(), "Late run cancellation could not be confirmed: " + node.reason, node, { claimId, runId }); } }); }
    }
  }
  private async recordShipping(jobId: string, nodeId: string, claim: string, commit: string, detail?: string) { await this.change((document) => { const job = document.jobs.find((item) => item.id === jobId); if (!job) return; const node = getNode(job, nodeId); if (node.shippingClaimId !== claim || !["shipping", "shipping-unknown"].includes(node.status)) return; node.status = "shipped"; node.shippedCommit = commit; delete node.reason; history(job, this.now(), detail ?? "Shipped this repository's exact reviewed merge; no push was performed", node, { claimId: claim, commit }); }); }
  private updateNode(jobId: string, nodeId: string, claimId: string | undefined, mutate: (job: CoordinatedChange, node: CoordinatedNode) => void) { return this.change((document) => { const job = document.jobs.find((item) => item.id === jobId); if (!job) return; const node = getNode(job, nodeId); if (claimId && node.claimId !== claimId) return; mutate(job, node); }); }
  private async withOperation<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, timeout = this.options.operationTimeoutMs ?? 120_000): Promise<T> { const controller = new AbortController(), uniqueKey = `${key}:${randomUUID()}`; this.controllers.set(uniqueKey, controller); try { return await bounded(Promise.resolve().then(() => operation(controller.signal)), timeout, controller); } finally { this.controllers.delete(uniqueKey); } }
  private change<T>(mutate: (document: CoordinationDocument) => T): Promise<T> {
    if (this.loadFault) return Promise.reject(this.loadFault);
    const work = (queues.get(this.file) ?? Promise.resolve()).then(async () => { const document = await readDocument(this.file), before = canonical(document), previous = JSON.parse(before) as CoordinationDocument, result = mutate(document); for (const job of document.jobs) { refresh(job); const prior = previous.jobs.find((item) => item.id === job.id); if (prior && canonical(prior) !== canonical(job)) job.revision = prior.revision + 1; } if (canonical(document) !== before) await writeDocument(this.file, document); return object(result) && Array.isArray(result.nodes) && typeof result.id === "string" ? copy(document.jobs.find((job) => job.id === result.id)) as T : result; });
    const tail = work.then(() => undefined, () => undefined); queues.set(this.file, tail); void tail.then(() => { if (queues.get(this.file) === tail) queues.delete(this.file); }); return work;
  }
}

function bounded<T>(promise: Promise<T>, timeout: number, controller: AbortController): Promise<T> { return new Promise((resolve, reject) => { let finished = false; const finish = (value: T | unknown, failure: boolean) => { if (finished) return; finished = true; clearTimeout(timer); controller.signal.removeEventListener("abort", abort); failure ? reject(value) : resolve(value as T); }; const abort = () => finish(new Error("Coordinated operation was cancelled; inspect any claimed side effects"), true), timer = setTimeout(() => { finish(new Error("Coordinated operation timed out; inspect any claimed side effects"), true); controller.abort(); }, timeout); controller.signal.addEventListener("abort", abort, { once: true }); if (controller.signal.aborted) abort(); promise.then((value) => finish(value, false), (error) => finish(error, true)); }); }

/** Strict saved schema. Invalid data remains untouched and cannot dispatch. */
export function validateCoordinationDocument(raw: unknown): CoordinationDocument {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.jobs) || raw.jobs.length > COORDINATION_LIMITS.retained) throw new Error("Invalid coordinated change storage");
  onlyKeys(raw, ["version", "jobs"], "storage");
  const seen = new Set<string>();
  for (const job of raw.jobs) {
    if (!object(job) || !id(job.id) || seen.has(job.id) || !Number.isSafeInteger(job.revision) || job.revision < 1 || !date(job.createdAt) || !date(job.updatedAt) || typeof job.cancelRequested !== "boolean" || !["running", "blocked", "ready", "partial-shipped", "shipped", "cancelled"].includes(job.status) || !Array.isArray(job.nodes) || job.nodes.length < 2 || job.nodes.length > COORDINATION_LIMITS.nodes || !Array.isArray(job.history) || job.history.length > COORDINATION_LIMITS.history) throw new Error("Invalid coordinated change record"); onlyKeys(job, ["id", "revision", "project", "name", "createdAt", "updatedAt", "status", "cancelRequested", "nodes", "shipping", "operationId", "operationHash", "history"], "saved job"); seen.add(job.id); text(job.project, 240, "saved project"); text(job.name, 120, "saved name"); checkGraph(job.nodes);
    const repos = new Set<string>(), repositoryIds = new Set<string>();
    for (const node of job.nodes) {
      if (!object(node) || node.jobId !== job.id || !states.includes(node.status) || !Number.isInteger(node.attempts) || node.attempts < 0 || node.attempts > COORDINATION_LIMITS.attempts || !commitId(node.baseCommit) || !/^[a-f0-9]{64}$/.test(node.repositoryId) || repositoryIds.has(node.repositoryId)) throw new Error("Invalid coordinated task state or repository ownership"); onlyKeys(node, ["jobId", "id", "run", "dependsOn", "baseCommit", "repositoryId", "status", "attempts", "claimId", "claimedAt", "runId", "dependencies", "result", "reason", "nextCheckAt", "cancelRequested", "shippingClaimId", "shippedCommit"], "saved task"); const run = safeRun(node.run, job.project); if (canonical(run) !== canonical(node.run) || run.baseRef !== node.baseCommit || repos.has(run.repo)) throw new Error("Saved coordinated task policy or pinned base changed"); repos.add(run.repo); repositoryIds.add(node.repositoryId);
      if (node.claimedAt !== undefined && !date(node.claimedAt) || node.nextCheckAt !== undefined && !date(node.nextCheckAt) || node.cancelRequested !== undefined && typeof node.cancelRequested !== "boolean" || node.reason !== undefined && (typeof node.reason !== "string" || node.reason.length > 1000)) throw new Error("Invalid coordinated task dates or diagnostics");
      if (node.claimId !== undefined) text(node.claimId, 240, "saved claim"); if (node.runId !== undefined && !id(node.runId)) throw new Error("Invalid coordinated run identity"); if (node.attempts && !node.claimId && !["pending", "waiting"].includes(node.status)) throw new Error("Missing coordinated claim"); if (["claimed", "running", "verified", "unknown", "shipping", "shipping-unknown", "shipped"].includes(node.status) && !node.claimId) throw new Error("Missing coordinated launch claim"); if (["running", "verified", "shipping", "shipping-unknown", "shipped"].includes(node.status) && !node.runId) throw new Error("Missing coordinated run receipt");
      if (node.result) { const checked = result(node.result, node.id); if (checked.repo !== run.repo || checked.runId !== node.runId || canonical(checked) !== canonical(node.result)) throw new Error("Mismatched coordinated result receipt"); } if (["verified", "shipping", "shipping-unknown", "shipped"].includes(node.status) && !node.result) throw new Error("Missing verified coordinated result");
      if (node.dependencies !== undefined && (!Array.isArray(node.dependencies) || node.dependencies.length !== node.dependsOn.length || node.dependencies.some((entry: any) => !object(entry) || !node.dependsOn.includes(result(entry, entry.nodeId).nodeId) || canonical(result(entry, entry.nodeId)) !== canonical(entry) || entry.repo !== getNode(job as CoordinatedChange, entry.nodeId).run.repo) || new Set(node.dependencies.map((entry: any) => entry.nodeId)).size !== node.dependsOn.length)) throw new Error("Invalid coordinated dependency receipts"); if (["claimed", "running", "verified", "unknown", "shipping", "shipping-unknown", "shipped"].includes(node.status) && !node.dependencies) throw new Error("Missing claimed dependency receipts"); if (node.shippingClaimId !== undefined) text(node.shippingClaimId, 240, "saved shipping claim"); if (["shipping", "shipping-unknown", "shipped"].includes(node.status) && !node.shippingClaimId) throw new Error("Missing shipping claim"); if (node.shippedCommit !== undefined && !commitId(node.shippedCommit)) throw new Error("Invalid shipping commit"); if (node.status === "shipped" && !node.shippedCommit) throw new Error("Missing shipping commit receipt");
    }
    if (job.shipping) { const preview = job.shipping; if (!object(preview) || typeof preview.id !== "string" || !date(preview.createdAt) || preview.expiresAt !== preview.createdAt + COORDINATION_LIMITS.previewMs || !Array.isArray(preview.entries) || preview.entries.length > job.nodes.length || new Set(preview.entries.map((entry: any) => entry.nodeId)).size !== preview.entries.length) throw new Error("Invalid coordinated shipping matrix"); for (const entry of preview.entries) { const node = getNode(job as CoordinatedChange, entry.nodeId); if (canonical(validation(entry.validation)) !== canonical(entry.validation) || entry.validation.source !== node.result?.commit) throw new Error("Mismatched reviewed shipping result"); } }
    for (const entry of job.history) if (!object(entry) || typeof entry.id !== "string" || !date(entry.at) || typeof entry.detail !== "string" || entry.detail.length > 1000 || entry.nodeId !== undefined && !job.nodes.some((node: CoordinatedNode) => node.id === entry.nodeId)) throw new Error("Invalid coordinated operation history");
    if (job.operationId !== undefined) { text(job.operationId, 240, "saved operation identity"); if (!/^[a-f0-9]{64}$/.test(job.operationHash)) throw new Error("Invalid coordinated operation checksum"); }
    const computed = copy(job) as CoordinatedChange; refresh(computed); if (computed.status !== job.status) throw new Error("Inconsistent coordinated job status");
  }
  return copy(raw as CoordinationDocument);
}
/** Backup restore keeps receipts for investigation and disables every implicit launch. */
export function disableRestoredCoordinatedChanges(raw: unknown, now = Date.now()) { const document = validateCoordinationDocument(raw); let cancelled = 0; for (const job of document.jobs) { if (job.status === "shipped" || job.status === "cancelled") continue; cancelled++; job.cancelRequested = true; for (const node of job.nodes) { node.cancelRequested = true; if (!["shipped", "shipping", "shipping-unknown", "unknown", "claimed", "running"].includes(node.status)) node.status = "cancelled"; if (node.status === "claimed") node.status = "unknown"; if (node.status === "shipping") node.status = "shipping-unknown"; node.reason = "Automatic execution disabled by encrypted backup restore; inspect existing receipts before explicit recovery"; } job.revision++; history(job, now, "Cancelled automatic dispatch after encrypted backup restore; receipt metadata preserved"); } return { document, cancelled }; }
async function readDocument(file: string): Promise<CoordinationDocument> { let handle; try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const info = await handle.stat(); if (!info.isFile() || info.size > COORDINATION_LIMITS.fileBytes) throw new Error("Coordinated storage must be a regular bounded file"); return validateCoordinationDocument(JSON.parse(await handle.readFile("utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] }; throw new Error(`Coordinated changes storage ${file} cannot be read: ${(error as Error).message}`); } finally { await handle?.close(); } }
async function writeDocument(file: string, document: CoordinationDocument) { const serialized = JSON.stringify(validateCoordinationDocument(document), null, 2); if (Buffer.byteLength(serialized) > COORDINATION_LIMITS.fileBytes) throw new Error("Coordinated storage reached its byte limit"); await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); } await rename(temp, file); if (process.platform !== "win32") { const folder = await open(dirname(file), "r"); try { await folder.sync(); } finally { await folder.close(); } } } finally { await rm(temp, { force: true }); } }
