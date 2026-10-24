import { holdoutActive } from "./holdout-model.js";
import type { MlState } from "./store.js";
import { randomUUID } from "node:crypto";
import { canonical, hash } from "../training-worker/files.js";
import { CHUNK_BYTES, InferenceInputError, id, integer, isLlm, LLM_RECIPE, MlBusyError, MlError, object, string, terminal, type Target } from "./model.js";
import { cycleTerminal } from "./cycle-model.js";
import { promotionConcerns } from "./registry-model.js";
import { inferenceInput, inferenceResult, release, releaseInputs, servingConfig, type Deployment, type ServingRelease, type ResidentStatus, type InferenceEvent } from "./deployment-model.js";
import type { MlService } from "./service.js";
export class MlDeployments {
  private operations = new Set<Promise<unknown>>();
  private workers = new Set<string>();
  private closing = false;
  private cleaning = new Map<string, Promise<void>>();
  constructor(private service: MlService) {}
  active() { return this.operations.size > 0 || this.service.store.read().deployments.some(d => d.config.mode === "persistent" && (d.enabled || d.cleanupPending)); }
  busy(workerId?: string, ownerId?: string, holdoutJobId?: string) { return !!workerId && (this.service.store.read().promotions.some(p => p.target.workerId === workerId && p.evaluations?.some(a => holdoutActive(a) && a.jobId !== holdoutJobId)) || this.workers.has(workerId) || this.service.store.read().deployments.some(d => d.id !== ownerId && d.target.workerId === workerId && d.config.mode === "persistent" && (d.enabled || d.cleanupPending))); }
  async close() { this.closing = true; await Promise.allSettled([...this.operations]); }
  private async track<T>(work: () => Promise<T>) { if (this.closing) throw new MlError("Inference is closing", 409); const flight = work(); this.operations.add(flight); try { return await flight; } finally { this.operations.delete(flight); } }
  private enabled() { if (this.closing || !this.service.enabled()) throw new MlError("Enable the ML preview to deploy or run inference", 409); }
  private deployment(value: string) { const d = this.service.store.read().deployments.find(d => d.id === id(value)); if (!d) throw new MlError("Deployment not found", 404); return d; }
  private retry(operationId: string, requestHash: string) {
    const d = this.service.store.read().deployments.find(d => d.history.some(h => h.operationId === operationId));
    if (d && d.history.find(h => h.operationId === operationId)!.requestHash !== requestHash) throw new MlError("Deployment operation inputs changed", 409);
    return d;
  }
  private async useWorker<T>(target: Target, work: () => Promise<T>, ownerId?: string, holdoutJobId?: string) {
    if (this.busy(target.workerId, ownerId, holdoutJobId)) throw new MlBusyError("This computer is handling an inference request or deployment; retry when it finishes");
    const s = this.service.store.read();
    if (s.experiments.some(e => e.target.workerId === target.workerId && !terminal(e.status.state)) || s.cycles.some(c => c.template.target.workerId === target.workerId && !cycleTerminal(c))) throw new MlBusyError("Training or an unresolved search owns this computer; finish it before inference");
    this.workers.add(target.workerId!); try { return await work(); } finally { this.workers.delete(target.workerId!); }
  }
  private evidence(modelId: string, versionId: string) {
    const s = this.service.store.read(), model = s.registry.find(m => m.id === modelId), version = model?.versions.find(v => v.id === versionId);
    if (!model || !version) throw new MlError("Choose a registered version of this model", 409);
    return { model, version, job: s.experiments.find(e => e.id === version.jobId)! };
  }
  private review(candidate: ReturnType<MlDeployments["evidence"]>, previous: ServingRelease | undefined, reviewed: unknown) {
    if (reviewed !== undefined && typeof reviewed !== "boolean") throw new MlError("Invalid deployment review");
    const margin = this.service.store.read().cycles.find(c => c.id === candidate.job.intent.search?.cycleId)?.limits.minImprovement ?? 0;
    const current = previous ? this.evidence(candidate.model.id, previous.versionId).job : undefined;
    const concerns = promotionConcerns(candidate.job, current, margin);
    if (concerns.length && reviewed !== true) throw new MlError(`Review this deployment comparison: ${concerns.join("; ")}`, 409);
    return concerns;
  }
  private makeRelease(versionId: string, modelId: string, target: Target, config: Deployment["config"]) {
    const { job } = this.evidence(modelId, versionId);
    const fields = { controllerId: this.service.store.read().controllerId, workerId: target.workerId!, bundle: target.bundle!, versionId, ...releaseInputs(job), config };
    return release({ id: hash(canonical(fields)), ...fields });
  }
  private async prepare(target: Target, r: ServingRelease, deploymentId?: string, revision?: number) {
    await this.service.registry.withArchive(r.versionId, async fd => {
      const available = await this.service.callWorker<{ present: boolean }>(target, "serve-upload-status", { hash: r.artifact.hash, bytes: r.artifact.bytes });
      if (!available.present) for (let offset = 0; offset < r.artifact.bytes;) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, r.artifact.bytes - offset)), { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new MlError("Registered archive ended unexpectedly", 409);
        await this.service.callWorker(target, "serve-upload", { hash: r.artifact.hash, bytes: r.artifact.bytes, offset, data: buffer.subarray(0, bytesRead).toString("base64") }); offset += bytesRead;
      }
    });
    if (r.config.mode === "persistent") {
      const before = await this.service.callWorker<ResidentStatus>(target, "resident-status");
      return this.service.callWorker<ResidentStatus>(target, "resident-prepare", { release: r, deploymentId, revision, expectedSession: before.sessionId ?? null });
    }
    inferenceResult(await this.service.callWorker(target, "serve-prepare", { release: r }), r);
    return undefined;
  }
  create(raw: unknown) { return this.track(async () => {
    const v = object(raw, ["project", "repo", "name", "modelId", "versionId", "target", "config", "operationId", "reason", "reviewed"], "deployment");
    const project = string(v.project, "project"), scope = await this.service.authorize(project, string(v.repo, "repository", 4096)), operationId = id(v.operationId), requestHash = hash(canonical(v));
    const retry = this.retry(operationId, requestHash); if (retry) return retry;
    this.enabled(); const modelId = id(v.modelId), candidate = this.evidence(modelId, id(v.versionId));
    if (candidate.model.project !== project || candidate.model.repo !== scope.repo) throw new MlError("Registered model belongs to another project or repository", 409);
    const name = string(v.name, "deployment name", 100).trim(), reason = string(v.reason, "deployment reason", 1000).trim(), config = servingConfig(v.config, isLlm(candidate.job.intent.spec));
    const comparison = this.review(candidate, undefined, v.reviewed);
    const capacity = () => { const ds = this.service.store.read().deployments; if (ds.length >= 32) throw new MlError("At most 32 deployments are supported", 409); if (ds.some(d => d.project === project && d.name.toLowerCase() === name.toLowerCase())) throw new MlError("That deployment name already exists", 409); };
    capacity();
    const configured = this.service.store.read().targets.find(t => t.id === id(v.target));
    if (this.busy(configured?.workerId)) throw new MlBusyError("Stop the existing persistent deployment or wait for inference before creating another deployment");
    const capability = await this.service.probe(id(v.target), true), target = this.service.store.read().targets.find(t => t.id === v.target)!;
    if (config.mode === "persistent" && capability.persistentServing !== 1) throw new MlError("Update this worker to enable persistent serving", 409);
    if (capability.serving !== 1) throw new MlError("Update this worker to enable model deployment", 409);
    if (config.cpus > capability.cpus || !(candidate.job.intent.recipe === LLM_RECIPE ? capability.recipes?.find(r => r.id === LLM_RECIPE)?.ready : capability.ready)) throw new MlError("Prepare a compatible inference environment on this computer", 409);
    if (config.device !== "cpu" && !capability.recipes?.find(r => r.id === LLM_RECIPE)?.devices?.includes(config.device) || config.device === "cuda" && !capability.gpus.some(g => g.uuid === config.gpu)) throw new MlError("The selected inference device is unavailable", 409);
    const r = this.makeRelease(v.versionId, modelId, target, config);
    if (r.base && !this.service.store.read().experiments.some(e => e.project === project && e.repo === scope.repo && e.target.workerId === target.workerId && e.intent.kind === "model" && e.status.state === "succeeded" && canonical(e.status.model) === canonical(r.base))) throw new MlError("Prepare the exact base model on this deployment computer first", 409);
    const deploymentId = randomUUID();
    return this.useWorker(target, async () => { try {
      await this.prepare(target, r, deploymentId, 1); await this.service.authorize(project, scope.repo);
      return await this.service.store.change(s => {
        this.enabled(); const same = this.retry(operationId, requestHash); if (same) return same; capacity(); this.service.assertTarget(target, s, true);
        const d: Deployment = { id: deploymentId, project, repo: scope.repo, name, modelId, target, config, createdAt: Date.now(), revision: 1, enabled: true, current: r.id, releases: [r], history: [{ operationId, requestHash, action: "deploy", to: r.id, at: Date.now(), reason, reviewed: v.reviewed === true, comparison }] };
        s.deployments.push(d); return d;
      });
    } catch (error) { if (config.mode === "persistent") await this.service.callWorker(target, "resident-stop", { deploymentId, revision: 1 }).catch(() => {}); throw error; } });
  }); }
  update(value: string, action: "switch" | "rollback" | "stop" | "resume", raw: unknown, guard?: (state: MlState) => void, committed?: (state: MlState, deployment: Deployment) => void, comparisonEvidence?: (state: MlState) => string[]) { return this.track(async () => {
    guard?.(this.service.store.read());
    const v = object(raw, ["versionId", "revision", "operationId", "reason", "reviewed"], "deployment change"), d = this.deployment(value);
    await this.service.authorize(d.project, d.repo);
    const operationId = id(v.operationId), requestHash = hash(canonical({ id: value, action, ...v })), same = this.retry(operationId, requestHash); if (same) { if (same.cleanupPending) await this.cleanup(same); return this.deployment(same.id); }
    const reason = string(v.reason, "deployment reason", 1000).trim(), revision = integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Deployment revision");
    if (revision !== d.revision) throw new MlError("Deployment changed; review its current version", 409);
    if (d.history.length >= (action === "stop" ? 200 : 199)) throw new MlError("Deployment history is full; its final event is reserved for stopping requests", 409);
    if (["stop", "resume"].includes(action) && (v.versionId !== undefined || (action === "resume") === d.enabled)) throw new MlError("Deployment is already in that state or has an unexpected version", 409);
    if (v.reviewed !== undefined && typeof v.reviewed !== "boolean") throw new MlError("Invalid deployment review");
    const current = d.releases.find(r => r.id === d.current)!;
    const r = action === "stop" || action === "resume" ? current : this.makeRelease(id(v.versionId), d.modelId, d.target, d.config);
    if ((action === "switch" || action === "rollback") && r.id === d.current) throw new MlError("This version is already deployed", 409);
    if (action === "rollback" && !d.history.some(h => h.to === r.id)) throw new MlError("Rollback requires a previously deployed version", 409);
    const comparison = action === "switch" ? comparisonEvidence ? comparisonEvidence(this.service.store.read()) : this.review(this.evidence(d.modelId, r.versionId), current, v.reviewed) : [];
    if (comparisonEvidence && comparison.length) throw new MlError("Common holdout comparison did not pass", 409);
    const commit = async () => { await this.service.authorize(d.project, d.repo); return this.service.store.change(s => {
      if (action !== "stop") this.enabled(); const retry = this.retry(operationId, requestHash); if (retry) return retry;
      const latest = s.deployments.find(x => x.id === d.id)!;
      guard?.(s);
      if (latest.revision !== revision) throw new MlError("Deployment changed during preparation; review its current version", 409);
      latest.history.push({ operationId, requestHash, action, from: latest.current, to: r.id, at: Date.now(), reason, reviewed: v.reviewed === true, comparison }); latest.revision++; latest.enabled = action !== "stop"; latest.current = r.id;
      if (r.config.mode === "persistent" && action === "stop") latest.cleanupPending = true; else delete latest.cleanupPending;
      if (!latest.releases.some(p => p.id === r.id)) latest.releases.push(r); committed?.(s, latest); return latest;
    }); };
    if (action === "stop") { const stopped = await commit(); if (stopped.cleanupPending) await this.cleanup(stopped); return this.deployment(d.id); }
    this.enabled(); return this.useWorker(d.target, async () => {
      let prepared: ResidentStatus | undefined;
      try { prepared = await this.prepare(d.target, r, d.id, d.revision + 1); return await commit(); }
      catch (error) {
        if (d.config.mode === "persistent") {
          const latest = this.deployment(d.id);
          if (!latest.enabled) {
            if (prepared?.sessionId) await this.service.callWorker(d.target, "resident-discard", { deploymentId: d.id, revision: d.revision + 1, expectedSession: prepared.sessionId }).catch(() => {});
            await this.cleanup(latest);
          }
          else if (latest.revision === d.revision) {
            try { await this.service.authorize(d.project, d.repo); await this.prepare(d.target, current, d.id, d.revision); }
            catch { throw new MlError(`${(error as Error).message}. The previous version remains selected, but its resident process could not be restored; check the worker and warm it again.`, 409); }
          }
        }
        throw error;
      }
    }, d.id);
  }); }
  private cleanup(d: Deployment) {
    const prior = this.cleaning.get(d.id); if (prior) return prior;
    const work = (async () => {
      try {
        const result = await this.service.callWorker<{ stopped: boolean }>(d.target, "resident-stop", { deploymentId: d.id, revision: d.revision });
        if (result.stopped) await this.service.store.change(s => { const latest = s.deployments.find(x => x.id === d.id); if (latest && !latest.enabled && latest.revision === d.revision) delete latest.cleanupPending; });
      } catch { /* Durable cleanupPending keeps training fenced until reconciliation confirms release. */ }
    })();
    this.cleaning.set(d.id, work); void work.finally(() => this.cleaning.delete(d.id)); return work;
  }
  async reconcile() { if (this.closing) return; for (const d of this.service.store.read().deployments) if (d.cleanupPending) await this.cleanup(d); }
  runtime(value: string) { return this.track(async (): Promise<ResidentStatus> => {
    const d = this.deployment(value); await this.service.authorize(d.project, d.repo);
    if (d.config.mode !== "persistent") return { state: "unloaded", reason: "This deployment loads separately for each request" };
    if (!d.enabled && !d.cleanupPending) return { state: "stopped" };
    if (d.enabled && this.service.store.read().promotions.some(p => p.deploymentId === d.id && p.evaluations?.some(holdoutActive))) return { state: "busy", reason: "Common holdout evaluation has reserved this computer; the incumbent reloads after confirmed cleanup" };
    let status: ResidentStatus;
    try { status = await this.service.callWorker<ResidentStatus>(d.target, "resident-status"); }
    catch { status = { state: "unknown", reason: "Worker status is unavailable; its independent resource limits remain in force" }; }
    await this.service.authorize(d.project, d.repo);
      if (status.deploymentId && status.deploymentId !== d.id) return { state: "unloaded", reason: "Another deployment is resident on this worker" };
      if (d.cleanupPending) return { ...status, state: "unknown", reason: "Stop is saved; worker cleanup is awaiting confirmation" };
      if (status.releaseId && status.releaseId !== d.current) return { ...status, state: "unknown", reason: "The resident version differs from the selected version; warm the selected model to recover" };
    return status;
  }); }
  private async ready(d: Deployment, r: ServingRelease) {
    const status = await this.service.callWorker<ResidentStatus>(d.target, "resident-status");
    if (status.state === "ready" && status.deploymentId === d.id && status.releaseId === r.id && status.revision === d.revision) return status;
    return (await this.prepare(d.target, r, d.id, d.revision))!;
  }
  warm(value: string, holdoutJobId?: string) { return this.track(async () => {
    this.enabled(); const d = this.deployment(value); await this.service.authorize(d.project, d.repo);
    if (!d.enabled || d.config.mode !== "persistent") throw new MlError("Enable a persistent deployment before warming its model", 409);
    return this.useWorker(d.target, async () => {
      const status = await this.ready(d, d.releases.find(r => r.id === d.current)!);
      await this.service.authorize(d.project, d.repo);
      const latest = this.deployment(d.id);
      if (!latest.enabled || latest.revision !== d.revision) { if (latest.cleanupPending) await this.cleanup(latest); throw new MlError("Deployment changed while warming the model", 409); }
      return status;
    }, d.id, holdoutJobId);
  }); }
  private async residentInference(d: Deployment, r: ServingRelease, input: ReturnType<typeof inferenceInput>, options: { signal?: AbortSignal; onEvent?: (event: InferenceEvent) => Promise<void> }) {
    const check = () => { if (options.signal?.aborted) throw new MlError("Inference cancelled", 409); this.enabled(); const latest = this.deployment(d.id); if (!latest.enabled || latest.revision !== d.revision) throw new MlError("Deployment stopped or changed during inference", 409); };
    check(); const ready = await this.ready(d, r); check();
    const requestId = randomUUID(); let completed = false;
    try {
      await this.service.authorize(d.project, d.repo); check();
      const receipt = await this.service.callWorker<{ requestId: string; sessionId: string }>(d.target, "resident-start", { deploymentId: d.id, revision: d.revision, expectedSession: ready.sessionId, requestId, release: r, input, stream: !!options.onEvent });
      if (receipt.requestId !== requestId || receipt.sessionId !== ready.sessionId) throw new MlError("Resident request identity changed", 409);
      await options.onEvent?.({ type: "meta", deploymentId: d.id, revision: d.revision, versionId: r.versionId, releaseId: r.id, sessionId: receipt.sessionId });
      let cursor = 0, bytes = 0, heartbeat = Date.now(); const deadline = Date.now() + (r.config.timeoutSeconds + 10) * 1000;
      while (Date.now() < deadline) {
        check();
        const page = await this.service.callWorker<{ events: any[]; cursor: number; done: boolean }>(d.target, "resident-poll", { deploymentId: d.id, requestId, cursor });
        await this.service.authorize(d.project, d.repo); check();
        if (!Array.isArray(page.events) || page.events.length > 32 || page.cursor !== cursor + page.events.length || page.cursor > 1024 || typeof page.done !== "boolean") throw new MlError("Invalid resident event page", 502);
        cursor = page.cursor;
        for (const [index, event] of page.events.entries()) {
          bytes += Buffer.byteLength(JSON.stringify(event)); if (bytes > 256000) throw new MlError("Inference stream exceeded its output limit", 502);
          if (event.type === "delta" && options.onEvent && typeof event.text === "string") await options.onEvent({ type: "delta", text: event.text });
          else if (event.type === "done" && page.done && index === page.events.length - 1) { const result = inferenceResult(event.result, r, input); completed = true; return result; }
          else if (event.type === "error" && typeof event.error === "string") { completed = true; if (event.kind === "input") throw new InferenceInputError(event.error.slice(0, 1000)); throw new MlError(event.error.slice(0, 1000), 409); }
          else throw new MlError("Invalid resident inference event", 502);
        }
        if (page.done) throw new MlError("Inference ended without a final result", 502);
        if (options.onEvent && Date.now() - heartbeat >= 5000) { await options.onEvent({ type: "heartbeat" }); heartbeat = Date.now(); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new MlError("Inference exceeded its response deadline", 409);
    } finally { if (!completed) await this.service.callWorker(d.target, "resident-cancel", { deploymentId: d.id, requestId }).catch(() => {}); }
  }
  predict(value: string, raw: unknown, options: { signal?: AbortSignal; onEvent?: (event: InferenceEvent) => Promise<void> } = {}) { return this.track(async () => {
    this.enabled(); const d = this.deployment(value); await this.service.authorize(d.project, d.repo);
    if (!d.enabled) throw new MlError("Deployment is stopped", 409);
    const r = d.releases.find(r => r.id === d.current)!;
    if (options.onEvent && (r.config.mode !== "persistent" || !r.base)) throw new MlError("Streaming requires a persistent LLM deployment", 409);
    const input = inferenceInput(raw, r), started = Date.now();
    return this.useWorker(d.target, async () => {
      // Stop/switch wins until dispatch. A dispatched request keeps its admitted release.
      await this.service.authorize(d.project, d.repo); this.enabled();
      const latest = this.deployment(value); if (!latest.enabled || latest.revision !== d.revision) throw new MlError("Deployment changed before inference; retry against the current version", 409);
      let result: ReturnType<typeof inferenceResult>;
      try { result = r.config.mode === "persistent" ? await this.residentInference(d, r, input, options) : inferenceResult(await this.service.callWorker(d.target, "serve-predict", { release: r, input }), r, input); }
      catch (error) {
        if (!options.signal?.aborted && !(error instanceof MlBusyError) && !(error instanceof InferenceInputError)) await this.service.monitors.record(d, r, input, undefined, Date.now() - started);
        throw error;
      }
      await this.service.authorize(d.project, d.repo);
      await this.service.monitors.record(d, r, input, result, Date.now() - started);
      return { deploymentId: d.id, revision: d.revision, versionId: r.versionId, releaseId: r.id, workerId: r.workerId, recipe: r.recipe, elapsedMs: Date.now() - started, result };
    }, d.id);
  }); }
}
