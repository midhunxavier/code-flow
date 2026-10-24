import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { canonical, hash, syncDir } from "../training-worker/files.js";
import { id, integer, MlError, object, string, type Experiment } from "./model.js";
import { evaluatedModel, modelContract, promotionConcerns, rankVersions, type ModelVersion, type RegisteredModel } from "./registry-model.js";
import { modelReceipt, REGISTRY_BYTES } from "./registry-store.js";
import type { MlService } from "./service.js";
import type { MlState } from "./store.js";

export class MlRegistry {
  private operations = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private service: MlService) {}
  active() { return this.operations.size > 0; }
  async close() { this.closing = true; await Promise.allSettled([...this.operations]); }
  private async track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new MlError("Model registry is closing", 409);
    const flight = work(); this.operations.add(flight);
    try { return await flight; } finally { this.operations.delete(flight); }
  }
  private enabled() { if (this.closing || !this.service.enabled()) throw new MlError("Enable the ML preview before registering or promoting models", 409); }
  private model(value: string) { const model = this.service.store.read().registry.find(m => m.id === id(value)); if (!model) throw new MlError("Registry model not found", 404); return model; }
  private job(value: string) { const job = this.service.store.read().experiments.find(e => e.id === id(value)); if (!job) throw new MlError("Training result not found", 404); return job; }
  private version(value: string) {
    id(value); const model = this.service.store.read().registry.find(m => m.versions.some(v => v.id === value));
    if (!model) throw new MlError("Model version not found", 404);
    return { model, version: model.versions.find(v => v.id === value)! };
  }
  async read(value: string, reference?: string) {
    const model = this.model(value); await this.service.authorize(model.project, model.repo);
    if (reference && !model.versions.some(v => v.id === reference)) throw new MlError("Comparison version does not belong to this model", 404);
    const jobs = model.versions.map(v => this.job(v.jobId));
    return { model, experiments: jobs, ranking: rankVersions(model, jobs, reference ?? model.selectedVersionId ?? model.versions[0]!.id).map(r => r.version.id) };
  }
  register(raw: unknown, guard?: (state: MlState) => void) { return this.track(async () => {
    guard?.(this.service.store.read());
    this.enabled(); const v = object(raw, ["project", "repo", "jobId", "modelId", "name", "revision", "operationId", "notes"], "model version");
    const project = string(v.project, "project"), scope = await this.service.authorize(project, string(v.repo, "repository", 4096));
    const job = this.job(id(v.jobId)), operationId = id(v.operationId), requestHash = hash(canonical(v));
    if (job.project !== project || job.repo !== scope.repo) throw new MlError("Training result belongs to another project or repository", 409);
    if (!evaluatedModel(job)) throw new MlError("Register a successful final test with a verified model export; validation trials and base-model snapshots are not registry versions", 409);
    const modelId = v.modelId === undefined ? undefined : id(v.modelId);
    if (modelId ? v.name !== undefined : v.revision !== undefined) throw new MlError("Choose an existing model with its revision, or a new model name");
    const name = modelId ? undefined : string(v.name, "model name", 100).trim();
    if (modelId) integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Model revision");
    const notes = v.notes === undefined || v.notes === "" ? "" : string(v.notes, "version notes", 1000).trim();
    const same = () => {
      const state = this.service.store.read(), previous = state.registry.find(m => m.versions.some(p => p.operationId === operationId || p.jobId === job.id));
      if (state.registry.some(m => m.history.some(h => h.operationId === operationId))) throw new MlError("Operation ID was already used", 409);
      if (!previous) return;
      const version = previous.versions.find(p => p.operationId === operationId || p.jobId === job.id)!;
      if (version.operationId === operationId ? version.requestHash !== requestHash : version.notes !== notes || (modelId ? modelId !== previous.id : name!.toLowerCase() !== previous.name.toLowerCase())) throw new MlError("This result or operation is already registered with different inputs", 409);
      return previous;
    };
    const previous = same(); if (previous) return previous;
    if (modelId) {
      const model = this.model(modelId);
      if (model.project !== project || model.repo !== scope.repo || modelContract(this.job(model.versions[0]!.jobId)) !== modelContract(job)) throw new MlError("Choose a model with the same project, repository and input/output contract", 409);
      if (model.revision !== v.revision) throw new MlError("Model registry changed; review its latest versions", 409);
    }
    const capacity = (state: MlState) => {
      if (state.registry.flatMap(m => m.versions).reduce((sum, version) => sum + state.experiments.find(e => e.id === version.jobId)!.status.artifact!.bytes, 0) + job.status.artifact!.bytes > REGISTRY_BYTES) throw new MlError("Registered archives reached their 2 GiB retention limit", 409);
      if (!modelId) {
        if (state.registry.length >= 32) throw new MlError("At most 32 registry models are supported", 409);
        if (state.registry.some(m => m.project === project && m.repo === job.repo && m.name.toLowerCase() === name!.toLowerCase())) throw new MlError("That model name already exists; select it to add a version", 409);
      }
    };
    capacity(this.service.store.read());
    const cached = await this.archive(job, true); await cached.close();
    await syncDir(join(this.service.store.directory, "exports"));
    await this.service.authorize(project, job.repo);
    return this.service.store.change(state => {
      this.enabled(); guard?.(state); const duplicate = same(); if (duplicate) return duplicate;
      capacity(state);
      let model = modelId ? state.registry.find(m => m.id === modelId)! : undefined;
      if (model) { if (model.revision !== v.revision) throw new MlError("Model registry changed; review its latest versions", 409); }
      else {
        model = { id: randomUUID(), project, repo: job.repo, name: name!, createdAt: Date.now(), revision: 0, versions: [], history: [] }; state.registry.push(model);
      }
      const current = state.experiments.find(e => e.id === job.id)!;
      if (modelReceipt(current) !== modelReceipt(job) || current.registry) throw new MlError("Training receipt changed during registration", 409);
      const version: ModelVersion = { id: randomUUID(), number: model.versions.length + 1, jobId: job.id, registeredAt: Date.now(), operationId, requestHash, receiptHash: modelReceipt(job), notes };
      model.versions.push(version); model.revision++; current.registry = { modelId: model.id, versionId: version.id }; return model;
    });
  }); }
  select(value: string, action: "promote" | "rollback", raw: unknown) { return this.track(async () => {
    const v = object(raw, ["versionId", "revision", "operationId", "reason", "reviewed"], "model selection");
    const versionId = id(v.versionId), operationId = id(v.operationId), revision = integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Model revision"), reason = string(v.reason, "selection reason", 1000).trim();
    if (v.reviewed !== undefined && typeof v.reviewed !== "boolean") throw new MlError("Invalid comparison review");
    const requestHash = hash(canonical({ modelId: value, action, ...v }));
    let model = this.model(value); await this.service.authorize(model.project, model.repo);
    const retry = () => {
      const state = this.service.store.read();
      const previous = state.registry.flatMap(m => m.history).find(h => h.operationId === operationId);
      if (previous) { if (previous.requestHash !== requestHash) throw new MlError("Selection operation inputs changed", 409); return this.model(value); }
      if (state.registry.some(m => m.versions.some(v => v.operationId === operationId))) throw new MlError("Operation ID was already used", 409);
    };
    const previous = retry(); if (previous) return previous;
    if (action === "promote") this.enabled();
    const version = model.versions.find(v => v.id === versionId);
    if (!version) throw new MlError("Version does not belong to this model", 409);
    if (model.revision !== revision || model.selectedVersionId === versionId) throw new MlError("Selection changed or this version is already selected; reload the registry", 409);
    if (action === "rollback" && !model.history.some(h => h.to === versionId)) throw new MlError("Rollback requires a previously selected version", 409);
    const job = this.job(version.jobId), incumbent = model.versions.find(v => v.id === model.selectedVersionId);
    const margin = this.service.store.read().cycles.find(c => c.id === job.intent.search?.cycleId)?.limits.minImprovement ?? 0;
    const concerns = action === "promote" ? promotionConcerns(job, incumbent ? this.job(incumbent.jobId) : undefined, margin) : [];
    if (concerns.length && v.reviewed !== true) throw new MlError(`Review this comparison before promotion: ${concerns.join("; ")}`, 409);
    const cached = await this.archive(job, false); await cached.close();
    await this.service.authorize(model.project, model.repo);
    return this.service.store.change(state => {
      if (this.closing) throw new MlError("Model registry is closing", 409);
      const previous = retry(); if (previous) return previous;
      if (action === "promote") this.enabled();
      model = state.registry.find(m => m.id === value)!;
      if (model.revision !== revision) throw new MlError("Selection changed during verification; review the current model", 409);
      if (model.history.length >= 200) throw new MlError("Model selection history reached its 200-event limit", 409);
      model.revision++;
      model.history.push({ id: randomUUID(), operationId, requestHash, revision: model.revision, action, ...(model.selectedVersionId ? { from: model.selectedVersionId } : {}), to: versionId, at: Date.now(), reason, reviewed: v.reviewed === true, comparison: concerns });
      model.selectedVersionId = versionId; return model;
    });
  }); }
  restore(value: string) { return this.track(async () => {
    const { model, version } = this.version(value); await this.service.authorize(model.project, model.repo);
    const cached = await this.archive(this.job(version.jobId), true); await cached.close(); await syncDir(join(this.service.store.directory, "exports"));
    await this.service.authorize(model.project, model.repo);
    return { versionId: value, restored: true };
  }); }
  /** Called only inside a deployment transaction after its archive/load checks and policy guard. */
  commitSelection(state: MlState, modelId: string, versionId: string, action: "promote" | "rollback", operationId: string, reason: string) {
    const model = state.registry.find(m => m.id === modelId)!;
    if (!model.versions.some(v => v.id === versionId) || model.selectedVersionId === versionId || model.history.length >= 200 || action === "rollback" && !model.history.some(h => h.to === versionId)) throw new MlError("Registry selection changed or its history is full", 409);
    const requestHash = hash(canonical({ modelId, action, versionId, revision: model.revision, operationId, reason, reviewed: false }));
    model.revision++; model.history.push({ id: randomUUID(), operationId, requestHash, revision: model.revision, action, from: model.selectedVersionId, to: versionId, at: Date.now(), reason, reviewed: false, comparison: [] }); model.selectedVersionId = versionId;
  }
  withArchive<T>(value: string, consume: (file: FileHandle, version: ModelVersion, job: Experiment) => Promise<T>) { return this.track(async () => {
    const { model, version } = this.version(value); await this.service.authorize(model.project, model.repo);
    const job = this.job(version.jobId), file = await this.archive(job, false);
    try { await this.service.authorize(model.project, model.repo); return await consume(file, version, job); } finally { await file.close(); }
  }); }
  /** Verification uses a held file descriptor; serving cannot follow a replaced path or symlink. */
  private async archive(job: Experiment, fetch: boolean): Promise<FileHandle> {
    if (fetch) await this.service.export(job.id);
    const path = join(this.service.store.directory, "exports", `${job.id}.tar.gz`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new MlError("Retained archive is unavailable; restore it from the training computer", 409); });
    try {
      const before = await file.stat(), expected = job.status.artifact!;
      if (!before.isFile() || before.size !== expected.bytes) throw new MlError("Retained archive changed; restore it before using this version", 409);
      const digest = createHash("sha256"); let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > expected.bytes) throw new MlError("Retained archive changed", 409); digest.update(chunk); }
      const after = await file.stat();
      if (bytes !== expected.bytes || digest.digest("hex") !== expected.hash || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new MlError("Retained archive checksum changed; restore it before using this version", 409);
      return file;
    } catch (error) { await file.close(); throw error; }
  }
}
