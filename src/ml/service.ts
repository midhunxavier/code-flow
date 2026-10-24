import { holdoutResult } from "./holdout-model.js";
import { MlPromotions } from "./promotions.js";
import { MlMonitors } from "./monitors.js";
import { MlDeployments } from "./deployments.js";
import { MlRegistry } from "./registry.js";
import { MlSchedules } from "./schedules.js";
import { fingerprint } from "./schedule-model.js";
import { fingerprintFile } from "./source.js";
import { MlCycles } from "./cycles.js";
import { cycleTerminal } from "./cycle-model.js";
import type { SearchPlanner } from "./planner.js";
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CODEFLOW_HOME } from "../config.js";
import { validSshHost } from "../ssh-projects/transport.js";
import { canonical, hash } from "../training-worker/files.js";
import { CHUNK_BYTES, DATA_LIMIT, MlError, MlBusyError, RECIPE, LLM_RECIPE, recipe, llmSpec, isLlm, modelSnapshot, dataset, id, integer, jobStatus, object, string, trainingSpec, terminal, type Dataset, type Experiment, type Intent, type JobStatus, type Probe, type Target } from "./model.js";
import { MlStore, type SnapshotRecord, type MlState } from "./store.js";
import { loadBundle, TrainingTransport, type WorkerClient } from "./transport.js";
export const mlEnabled = () => process.env.CODEFLOW_ML_ENABLED === "true";
export interface MlOptions { promotionClock?: () => number; monitorClock?: () => number; scheduleClock?: () => number; planner?: SearchPlanner; home?: string; bundlePath?: string; transport?: WorkerClient; authorize: (project: string, repo: string) => Promise<{ repo: string; commit: string }>; enabled?: () => boolean }
export class MlService {
  readonly store: MlStore;
  readonly registry: MlRegistry;
  readonly deployments: MlDeployments;
  readonly cycles: MlCycles;
  readonly schedules: MlSchedules;
  readonly monitors: MlMonitors;
  readonly promotions: MlPromotions;
  private transport: WorkerClient;
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private exports = new Map<string, Promise<string>>();
  private submitting = new Set<string>();
  private upgrading = new Set<string>();
  private ready = false;
  constructor(private options: MlOptions) { this.store = new MlStore(join(options.home ?? CODEFLOW_HOME, "ml")); this.transport = options.transport ?? new TrainingTransport(options.bundlePath); this.cycles = new MlCycles(this, options.planner); this.schedules = new MlSchedules(this, options.scheduleClock); this.registry = new MlRegistry(this); this.deployments = new MlDeployments(this); this.monitors = new MlMonitors(this, options.monitorClock); this.promotions = new MlPromotions(this, options.promotionClock); }
  async load() { await this.store.load(); await this.cycles.recover(); await this.schedules.recover(); await this.monitors.recover(); this.ready = true; }
  start() { this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 5000); this.timer.unref(); }
  async close() { clearInterval(this.timer); await this.promotions.close(); await this.monitors.close(); await this.schedules.close(); await this.cycles.close(); await this.deployments.close(); await this.registry.close(); await this.flight; await Promise.allSettled([...this.exports.values()]); await this.transport.close(); }
  active() { return !this.ready || this.promotions.active() || this.monitors.active() || this.deployments.active() || this.registry.active() || this.exports.size > 0 || this.schedules.active() || this.store.read().cycles.some(c => !cycleTerminal(c)) || this.store.read().experiments.some(e => !terminal(e.status.state)); }
  enabled() { return (this.options.enabled ?? mlEnabled)(); }
  authorize(project: string, repo: string) { return this.options.authorize(project, repo); }
  private creation() { if (!this.enabled()) throw new MlError("Enable the local training preview with CODEFLOW_ML_ENABLED=true", 409); }
  assertTarget(target: Target, state = this.store.read(), ownsServing = false) {
    if (!ownsServing && this.deployments.busy(target.workerId)) throw new MlError("Inference is using this computer; retry when it finishes", 409);
    if (this.upgrading.has(target.id) || state.targets.find(t => t.id === target.id)?.revision !== target.revision) throw new MlError("Training computer changed or is being updated", 409);
  }
  private target(value: unknown) { const target = this.store.read().targets.find(t => t.id === value); if (!target) throw new MlError("Training computer not found", 404); return target; }
  private experiment(value: unknown) { const result = this.store.read().experiments.find(e => e.id === value); if (!result) throw new MlError("Experiment not found", 404); return result; }
  private request(target: Target, action: string, values: Record<string, unknown> = {}) { return { action, controllerId: this.store.read().controllerId, ...(target.workerId ? { workerId: target.workerId } : {}), python: target.python, ...values }; }
  callWorker<T = any>(target: Target, action: string, values: Record<string, unknown> = {}) { return this.transport.call<T>(target, this.request(target, action, values)); }
  overview(project: string) {
    const state = this.store.read();
    return { enabled: this.enabled(), revision: state.revision, targets: state.targets, promotions: state.promotions.filter(p => p.project === project), monitors: state.monitors.filter(m => m.project === project), defaultTarget: state.defaults[project] ?? "local", registry: state.registry.filter(m => m.project === project), deployments: state.deployments.filter(d => d.project === project), schedules: state.schedules.filter(s => s.template.project === project).reverse(), cycles: state.cycles.filter(c => c.template.project === project).reverse(), datasets: state.datasets.filter(d => d.project === project), experiments: state.experiments.filter(e => e.project === project).sort((a, b) => b.intent.createdAt - a.intent.createdAt).slice(0, 200) };
  }
  summary(project: string) { const s = this.store.read(); return { enabled: this.enabled(), configured: s.registry.some(m => m.project === project) || s.schedules.some(s => s.template.project === project) || s.cycles.some(c => c.template.project === project) || s.experiments.some(e => e.project === project) || s.datasets.some(d => d.project === project) }; }
  async register(raw: unknown) {
    this.creation(); const v = object(raw, ["name", "host", "directory", "python", "standalone"]);
    if (!validSshHost(v.host)) throw new MlError("Enter a valid SSH alias or user@host");
    if (v.standalone !== true) throw new MlError("Direct SSH training requires a standalone server; Slurm clusters need a scheduler adapter");
    const directory = string(v.directory ?? "~/.codeflow/training-worker", "worker directory", 4096);
    if (!isAbsolute(directory) && !directory.startsWith("~/")) throw new MlError("Use an absolute or ~/ worker directory");
    const python = string(v.python ?? "python3", "Python executable", 4096);
    if (python !== "python3" && !isAbsolute(python)) throw new MlError("Use python3 or an absolute Python path");
    const target: Target = { id: randomUUID(), revision: 1, kind: "ssh", name: string(v.name, "computer name", 100), host: v.host, directory, python };
    return this.store.change(s => { if (s.targets.length >= 32) throw new MlError("At most 32 training computers are supported"); if (s.targets.some(t => t.host === target.host && t.directory === target.directory)) throw new MlError("This training computer is already configured", 409); s.targets.push(target); return target; });
  }
  async probe(value: string, serving = false): Promise<Probe> {
    let target = this.target(value);
    const enroll = !target.workerId;
    if (enroll) this.creation();
    const bundle = enroll ? (await loadBundle(this.options.bundlePath)).version : target.bundle!;
    const result = await this.transport.call<Probe>(target, this.request(target, enroll ? "enroll" : "probe", serving ? { serving: true } : {}), enroll);
    if (result.protocol !== 1 || target.workerId && target.workerId !== result.workerId) throw new MlError("Training worker identity changed", 409);
    if (enroll) await this.store.change(s => { const selected = s.targets.find(t => t.id === target.id)!; if (selected.workerId && selected.workerId !== result.workerId) throw new MlError("Worker enrollment changed", 409); selected.workerId = result.workerId; selected.bundle = bundle; selected.revision++; });
    return result;
  }
  async upgrade(value: string): Promise<Probe> {
    this.creation(); const target = this.target(value);
    if (this.promotions.usesTarget(value) || this.monitors.usesTarget(value) || this.deployments.busy(target.workerId) || this.upgrading.has(value) || this.store.read().schedules.some(s => s.state === "enabled" && s.template.target.id === value) || this.store.read().cycles.some(c => !cycleTerminal(c) && c.template.target.id === value) || this.store.read().experiments.some(e => e.target.id === value && !terminal(e.status.state))) throw new MlError("Finish or reconcile this computer's job, stop persistent serving and pause its schedules, monitors and promotion policies before updating its worker", 409);
    this.upgrading.add(value);
    try {
      // Queue behind any admission whose durable write has started but has not
      // published yet. The in-memory gate rejects later admissions until done.
      await this.store.change(s => {
        if (this.promotions.usesTarget(value) || this.monitors.usesTarget(value) || this.deployments.busy(target.workerId) || s.schedules.some(s => s.state === "enabled" && s.template.target.id === value) || s.cycles.some(c => !cycleTerminal(c) && c.template.target.id === value) || s.experiments.some(e => e.target.id === value && !terminal(e.status.state))) throw new MlError("Finish or reconcile this computer's job, stop persistent serving and pause its schedules, monitors and promotion policies before updating its worker", 409);
      });
      const bundle = await loadBundle(this.options.bundlePath);
      const result = await this.transport.call<Probe>(target, this.request(target, "enroll"), true);
      if (result.protocol !== 1 || target.workerId && result.workerId !== target.workerId) throw new MlError("Training worker identity changed", 409);
      await this.store.change(s => { const selected = s.targets.find(t => t.id === value)!; selected.workerId = result.workerId; selected.bundle = bundle.version; selected.revision++; });
      return result;
    } finally { this.upgrading.delete(value); }
  }
  async setDefault(raw: unknown) {
    this.creation(); const v = object(raw, ["project", "repo", "target", "revision"]);
    const project = string(v.project, "project"); await this.options.authorize(project, string(v.repo, "repository", 4096)); this.target(v.target);
    return this.store.change(s => { if (s.revision !== v.revision) throw new MlError("Training settings changed; reload before saving", 409); s.defaults[project] = v.target; return { target: v.target, revision: s.revision + 1 }; });
  }
  async configure(value: string, raw: unknown) {
    this.creation(); const v = object(raw, ["python", "revision"]), target = this.target(value);
    const python = string(v.python, "Python executable", 4096);
    if (python !== "python3" && !isAbsolute(python)) throw new MlError("Use python3 or an absolute Python path");
    if (this.upgrading.has(value)) throw new MlError("Worker update is in progress", 409);
    return this.store.change(s => {
      const selected = s.targets.find(t => t.id === target.id)!;
      if (selected.revision !== v.revision) throw new MlError("Computer settings changed; reload before saving", 409);
      if (this.promotions.usesTarget(value) || this.monitors.usesTarget(value) || this.deployments.busy(target.workerId) || s.schedules.some(s => s.state === "enabled" && s.template.target.id === target.id) || s.cycles.some(c => !cycleTerminal(c) && c.template.target.id === target.id) || s.experiments.some(e => !terminal(e.status.state) && e.target.id === target.id)) throw new MlError("Finish or reconcile this computer's job, stop persistent serving and pause its schedules, monitors and promotion policies before changing Python", 409);
      selected.python = python; selected.revision++; return selected;
    });
  }
  async fingerprint(raw: unknown) {
    this.creation(); const v = object(raw, ["project", "repo", "target", "path", "location"]);
    await this.authorize(string(v.project, "project"), string(v.repo, "repository", 4096));
    const target = this.target(v.target);
    if (!target.workerId || !target.bundle) throw new MlError("Enroll the training computer before checking data", 409);
    if (!["target", "controller"].includes(v.location)) throw new MlError("Choose which computer holds the dataset");
    return fingerprint(target.kind === "local" || v.location === "controller" ? await fingerprintFile(v.path) : await this.transport.call(target, this.request(target, "fingerprint", { path: v.path })));
  }
  async snapshot(raw: unknown): Promise<SnapshotRecord> {
    this.creation(); const v = object(raw, ["project", "repo", "target", "path", "location", "purpose"]);
    if (v.purpose !== undefined && v.purpose !== "holdout") throw new MlError("Invalid dataset purpose");
    const project = string(v.project, "project"), scope = await this.options.authorize(project, string(v.repo, "repository", 4096));
    let target = this.target(v.target ?? this.store.read().defaults[project] ?? "local");
    const path = string(v.path, "dataset path", 4096); if (!isAbsolute(path)) throw new MlError("Use an absolute dataset path");
    const format = path.toLowerCase().endsWith(".csv") ? "csv" : path.toLowerCase().endsWith(".parquet") ? "parquet" : path.toLowerCase().endsWith(".jsonl") ? "jsonl" : undefined;
    if (!format) throw new MlError("Use a CSV, Parquet or JSONL dataset");
    const capability = await this.probe(target.id); target = this.target(target.id);
    if (v.purpose === "holdout" && capability.commonHoldout !== 1) throw new MlError("Update this worker before preparing a common holdout", 409);
    const available = format === "jsonl" ? capability.recipes?.find(r => r.id === LLM_RECIPE) : capability;
    if (!available?.ready) throw new MlError(available?.issue ?? "Update this worker and set up the selected recipe's environment", 409);
    if (!["target", "controller"].includes(v.location)) throw new MlError("Choose which computer holds the dataset");
    let prepared: Dataset;
    if (v.location === "target" || target.kind === "local") prepared = await this.transport.call(target, this.request(target, "snapshot", { path, ...(v.purpose ? { purpose: v.purpose } : {}) }));
    else {
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Freeze the source before sending it. Retries use content hashes and verified byte offsets.
      const temporary = join(this.store.directory, "staging", randomUUID()); await mkdir(join(this.store.directory, "staging"), { recursive: true, mode: 0o700 });
      const output = await open(temporary, "wx", 0o600); const hasher = createHash("sha256"); let bytes = 0;
      try {
        const before = await input.stat(); if (!before.isFile()) throw new MlError("Choose a regular dataset file"); integer(before.size, 1, format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset size");
        for await (const chunk of input.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > DATA_LIMIT) throw new MlError("Dataset is too large"); hasher.update(chunk); await output.write(chunk); }
        const after = await input.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new MlError("Dataset changed during preparation"); await output.sync();
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      finally { await input.close(); await output.close(); }
      const fingerprint = hasher.digest("hex"), source = await open(temporary, "r");
      try {
        for (let offset = 0; offset < bytes;) { const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, bytes - offset)); const read = await source.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) throw new Error("Snapshot ended unexpectedly"); await this.transport.call(target, this.request(target, "upload", { hash: fingerprint, format, bytes, offset, data: buffer.subarray(0, read.bytesRead).toString("base64") })); offset += read.bytesRead; }
        prepared = await this.transport.call(target, this.request(target, "finish-upload", { hash: fingerprint, format, ...(v.purpose ? { purpose: v.purpose } : {}) }));
      } finally { await source.close(); await rm(temporary, { force: true }); }
    }
    const record: SnapshotRecord = { id: randomUUID(), project, repo: scope.repo, target, dataset: dataset(prepared), ...(v.purpose ? { purpose: v.purpose } : {}) };
    await this.options.authorize(project, scope.repo);
    return this.store.change(s => { if (v.purpose === "holdout" && s.experiments.some(e => e.intent.kind === "training" && e.intent.dataset?.hash === record.dataset.hash)) throw new MlError("Previously trained data cannot become a holdout", 409); const prior = s.datasets.find(d => d.project === project && d.repo === scope.repo && d.target.workerId === target.workerId && d.dataset.hash === record.dataset.hash); if (prior) { if (v.purpose === "holdout") { if (s.experiments.some(e => e.intent.kind === "training" && e.intent.dataset?.hash === prior.dataset.hash)) throw new MlError("Previously trained data cannot become a holdout", 409); prior.purpose = "holdout"; } return prior; } if (s.datasets.length >= 200) throw new MlError("Dataset history is full; archive it before preparing more inputs"); s.datasets.push(record); return record; });
  }
  async startJob(raw: unknown, setup: boolean | "model" = false, prepareOnly = false): Promise<Experiment> {
    this.creation(); const v = object(raw, setup === "model" ? ["project", "repo", "target", "operationId", "path"] : setup ? ["project", "repo", "target", "operationId", "recipe"] : ["project", "repo", "name", "dataset", "spec", "operationId", "recipe", "model"]);
    const project = string(v.project, "project"), scope = await this.options.authorize(project, string(v.repo, "repository", 4096)), operationId = id(v.operationId);
    const requestHash = hash(canonical({ ...v, repo: scope.repo, setup }));
    const previous = this.store.read().experiments.find(e => e.operationId === operationId);
    if (previous) { if (prepareOnly) throw new MlError("This operation ID already belongs to a manual job", 409); if (previous.requestHash !== requestHash) throw new MlError("This operation ID belongs to different inputs", 409); return this.inspect(previous.id); }
    const selected = setup === "model" ? LLM_RECIPE : recipe(v.recipe);
    const snapshot = setup ? undefined : this.store.read().datasets.find(d => d.id === v.dataset && d.project === project && d.repo === scope.repo);
    if (!setup && !snapshot) throw new MlError("Choose a prepared dataset from this project", 409);
    if (snapshot && this.store.read().datasets.some(d => d.purpose === "holdout" && d.dataset.hash === snapshot.dataset.hash)) throw new MlError("Common holdout data is reserved for evaluation, not training", 409);
    if (snapshot && (selected === LLM_RECIPE) !== (snapshot.dataset.format === "jsonl")) throw new MlError("Choose a dataset for the selected recipe", 409);
    let target = this.target(setup ? v.target : snapshot!.target.id);
    if (this.deployments.busy(target.workerId)) throw new MlBusyError("Inference or persistent serving reserves this computer; stop the deployment and confirm cleanup before training");
    const capability = await this.probe(target.id); target = this.target(target.id);
    if (snapshot && snapshot.target.workerId !== target.workerId) throw new MlError("Dataset belongs to a different worker", 409);
    const available = selected === LLM_RECIPE ? capability.recipes?.find(r => r.id === selected) : capability;
    if (!available) throw new MlError("Update this training worker to enable fine-tuning", 409);
    if (setup !== true && !available.ready) throw new MlError(available.issue ?? "Training environment is unavailable", 409);
    const spec = setup ? undefined : selected === LLM_RECIPE ? llmSpec(v.spec) : trainingSpec(v.spec);
    if (spec && spec.cpus > capability.cpus) throw new MlError("Requested CPU threads exceed this computer's capacity", 409);
    const preparedModel = !setup && selected === LLM_RECIPE ? this.store.read().experiments.find(e => e.id === v.model && e.project === project && e.repo === scope.repo && e.target.workerId === target.workerId && e.intent.kind === "model" && e.status.state === "succeeded") : undefined;
    if (!setup && selected === LLM_RECIPE && !preparedModel?.status.model) throw new MlError("Choose a prepared base model from this project and computer", 409);
    if (selected === RECIPE && v.model !== undefined) throw new MlError("Tabular training does not use a base model");
    if (isLlm(spec)) {
      if (!capability.recipes?.find(r => r.id === LLM_RECIPE)?.devices?.includes(spec.device)) throw new MlError("The selected training device is unavailable", 409);
      if (spec.device === "cuda" && !capability.gpus.some(g => g.uuid === spec.gpu)) throw new MlError("Choose an available NVIDIA GPU", 409);
      if (spec.device === "cpu" && preparedModel!.status.model!.parameters > 150000000) throw new MlError("CPU fine-tuning supports models up to 150 million parameters; choose an available GPU", 409);
      if (spec.maxLength > preparedModel!.status.model!.contextLength) throw new MlError("Sequence length exceeds the base model context", 409);
    }
    const modelPath = setup === "model" ? string(v.path, "model directory", 4096) : undefined;
    if (modelPath && !isAbsolute(modelPath)) throw new MlError("Choose an absolute model directory on the training computer");
    const now = Date.now(), jobId = randomUUID();
    const accepted: Intent = { version: 1, id: jobId, controllerId: this.store.read().controllerId, workerId: target.workerId!, bundle: target.bundle!, kind: setup === "model" ? "model" : setup ? "setup" : "training", ...(selected === LLM_RECIPE ? { recipe: selected } : {}), ...(modelPath ? { modelPath } : {}), ...(preparedModel ? { model: modelSnapshot(preparedModel.status.model) } : {}), createdAt: now, deadline: now + (setup ? 3600 : spec!.trainSeconds + (selected === LLM_RECIPE ? 1800 : 600)) * 1000, python: target.python, ...(snapshot && spec ? { dataset: snapshot.dataset, spec, source: { commit: scope.commit, project } } : {}) };
    const record: Experiment = { id: jobId, project, repo: scope.repo, name: setup === "model" ? `Prepare model on ${target.name}` : setup ? `Set up ${selected === LLM_RECIPE ? "fine-tuning" : "tabular training"} on ${target.name}` : string(v.name, "experiment name", 200), operationId, requestHash, target, intent: accepted, status: { id: jobId, state: "submitted", updatedAt: now } };
    if (prepareOnly) {
      if (capability.boundedSearch !== 1) throw new MlError("Update this training worker before starting automatic experiments", 409);
      return record;
    }
    return this.submitRecord(record);
  }
  /** Atomically admit the job and its search budget before the first RPC. */
  async submitRecord(record: Experiment, reserve?: (s: MlState) => void): Promise<Experiment> {
    this.creation();
    const { id: jobId, target, project, operationId, requestHash, intent: accepted } = record;
    this.submitting.add(jobId);
    let admitted: Experiment;
    try { admitted = await this.store.change(s => {
      const same = s.experiments.find(e => e.operationId === operationId);
      if (same) { if (same.requestHash !== requestHash) throw new MlError("Operation inputs changed", 409); return same; }
      if (this.upgrading.has(target.id) || s.targets.find(t => t.id === target.id)?.revision !== target.revision) throw new MlError("Computer settings changed; retry after the update", 409);
      const holdoutOwner = accepted.kind === "holdout" ? s.promotions.find(p => p.evaluations?.some(a => a.jobId === jobId && a.state === "pending")) : undefined;
      if (accepted.kind === "holdout" && !holdoutOwner) throw new MlError("Holdout admission requires its saved policy", 409);
      if (this.deployments.busy(target.workerId, holdoutOwner?.deploymentId, holdoutOwner ? jobId : undefined)) throw new MlError("Inference is using this computer; retry when it finishes", 409);
      if (s.experiments.length >= 200) throw new MlError("Experiment history is full; archive it before starting more work");
      if (s.experiments.some(e => !terminal(e.status.state) && (e.target.workerId === target.workerId || e.project === project))) throw new MlError("A job is active or unresolved for this computer or project", 409);
      if (s.cycles.some(c => !cycleTerminal(c) && c.id !== accepted.search?.cycleId && (c.template.project === project || c.template.target.workerId === target.workerId))) throw new MlError("An automatic search owns this computer or project", 409);
      if (accepted.kind === "training" && s.datasets.some(d => d.purpose === "holdout" && d.dataset.hash === accepted.dataset?.hash)) throw new MlError("Holdout data cannot be admitted for training", 409);
      reserve?.(s);
      s.experiments.push(record); return record;
    }); } catch (error) { this.submitting.delete(jobId); throw error; }
    if (admitted.id !== record.id) { this.submitting.delete(jobId); return this.inspect(admitted.id); }
    try {
      await this.options.authorize(project, record.repo);
      const status = await this.transport.call<JobStatus>(target, this.request(target, "submit", { intent: accepted }));
      return this.saveStatus(jobId, status);
    } catch (error) { return this.saveStatus(jobId, { ...record.status, state: "unknown", error: (error as Error).message }); }
    finally { this.submitting.delete(jobId); }
  }
  private async saveStatus(jobId: string, status: JobStatus) {
    jobStatus(status);
    if (status.id !== jobId) throw new MlError("Invalid worker status", 502);
    const current = this.experiment(jobId);
    if (status.holdout !== undefined) { if (current.intent.kind !== "holdout") throw new MlError("Unexpected common holdout receipt", 502); holdoutResult(status.holdout, current.intent.holdout, current.intent.dataset); }
    if (status.state === "succeeded" && current.intent.kind === "holdout" && (!status.holdout || status.evaluation || status.artifact)) throw new MlError("Holdout completed without its bound comparison evidence", 502);
    if (status.model && current.intent.kind !== "model" || status.state === "succeeded" && current.intent.kind === "model" && !status.model) throw new MlError("Invalid prepared model receipt", 502);
    if (status.state === "succeeded" && current.intent.kind === "training" && (!status.evaluation || current.intent.search?.partition !== "validation" && !status.artifact)) throw new MlError("Training completed without evaluation and export evidence", 502);
    if (status.evaluation && (current.intent.kind !== "training" || status.evaluation.recipe !== recipe(current.intent.recipe) || status.evaluation.datasetHash !== current.intent.dataset?.hash || current.intent.recipe === LLM_RECIPE && status.evaluation.baseModelHash !== current.intent.model?.hash)) throw new MlError("Evaluation inputs differ from the admitted job", 502);
    if (status.evaluation && ((status.evaluation.partition ?? "test") !== (current.intent.search?.partition ?? "test") || status.evaluation.seed !== current.intent.spec?.seed || current.intent.search?.fromJob && status.evaluation.modelHash !== current.intent.search.fromJob.modelHash)) throw new MlError("Evaluation partition or selected model changed", 502);
    if (status.progress && (!isLlm(current.intent.spec) || status.progress.totalSteps !== current.intent.spec.maxSteps)) throw new MlError("Progress does not match the admitted training limits", 502);
    if (terminal(current.status.state) || canonical(current.status) === canonical(status)) return current;
    return this.store.change(s => { const e = s.experiments.find(e => e.id === jobId)!; if (!terminal(e.status.state)) e.status = e.cancelRequestedAt && !terminal(status.state) ? { ...status, state: "cancel_requested" } : status; return e; });
  }
  async inspect(jobId: string): Promise<Experiment> {
    const record = this.experiment(jobId); if (terminal(record.status.state) || this.submitting.has(jobId)) return record;
    try {
      const status = await this.transport.call<JobStatus>(record.target, this.request(record.target, "reconcile", { intent: record.intent }));
      if (record.cancelRequestedAt && !terminal(status.state)) return this.saveStatus(jobId, await this.transport.call<JobStatus>(record.target, this.request(record.target, "cancel", { id: jobId })));
      return await this.saveStatus(jobId, status);
    }
    catch (error) { return this.saveStatus(jobId, { ...record.status, state: "unknown", error: (error as Error).message }); }
  }
  async cancel(jobId: string) {
    const record = this.experiment(jobId); if (terminal(record.status.state)) return record;
    // Persist the user's intent independently of transport status. Reconnects must
    // retry the cancellation, even if the SSH response was lost or the app restarted.
    await this.store.change(s => { const e = s.experiments.find(e => e.id === jobId)!; e.cancelRequestedAt ??= Date.now(); if (!terminal(e.status.state)) e.status = { ...e.status, state: "cancel_requested" }; });
    try {
      // Reconciliation fences a missing admission, including a submit still in flight.
      const reconciled = await this.transport.call<JobStatus>(record.target, this.request(record.target, "reconcile", { intent: record.intent }));
      return await this.saveStatus(jobId, terminal(reconciled.state) ? reconciled : await this.transport.call<JobStatus>(record.target, this.request(record.target, "cancel", { id: jobId })));
    }
    catch (error) { return this.saveStatus(jobId, { ...record.status, state: "cancel_requested", error: `Cancellation pending: ${(error as Error).message}` }); }
  }
  async logs(jobId: string, cursor: number) {
    const record = this.experiment(jobId); await this.options.authorize(record.project, record.repo);
    const result = await this.transport.call<{ data: string; cursor: number; bytes: number }>(record.target, this.request(record.target, "logs", { id: jobId, cursor }));
    return { text: Buffer.from(result.data, "base64").toString("utf8"), cursor: result.cursor, bytes: result.bytes };
  }
  async export(jobId: string) {
    const record = await this.inspect(jobId); await this.options.authorize(record.project, record.repo);
    if (record.intent.kind !== "training" || record.status.state !== "succeeded" || !record.status.artifact) throw new MlError("This experiment has no evaluated model export", 409);
    const prior = this.exports.get(jobId); if (prior) return prior;
    const flight = this.download(record); this.exports.set(jobId, flight);
    try { return await flight; } finally { this.exports.delete(jobId); }
  }
  private async download(record: Experiment) {
    const artifact = record.status.artifact!, destination = join(this.store.directory, "exports", `${record.id}.tar.gz`);
    await mkdir(join(this.store.directory, "exports"), { recursive: true, mode: 0o700 });
    const temp = destination + "." + randomUUID(), output = await open(temp, "wx", 0o600), hasher = createHash("sha256");
    try {
      integer(artifact.bytes, 1, 512 * 1024 * 1024, "Export size");
      for (let cursor = 0; cursor < artifact.bytes;) {
        const result = await this.transport.call<{ data: string; cursor: number; bytes: number }>(record.target, this.request(record.target, "artifact", { id: record.id, cursor }));
        const data = Buffer.from(result.data, "base64");
        if (!data.length || data.length > CHUNK_BYTES || result.bytes !== artifact.bytes || result.cursor !== cursor + data.length || result.cursor > artifact.bytes) throw new Error("Invalid artifact transfer response");
        hasher.update(data); await output.write(data); cursor = result.cursor;
      }
      if (hasher.digest("hex") !== artifact.hash) throw new Error("Model export checksum mismatch");
      await output.sync(); await output.close(); await rename(temp, destination); return destination;
    } catch (error) { await output.close().catch(() => {}); await rm(temp, { force: true }); throw error; }
  }
  async reconcile() {
    if (this.flight) return this.flight;
    this.flight = (async () => { for (const record of this.store.read().experiments) if (!terminal(record.status.state)) await this.inspect(record.id); await this.deployments.reconcile(); void this.cycles.tick().catch(() => {}); void this.schedules.tick().catch(() => {}); void this.monitors.tick().catch(() => {}); void this.promotions.tick().catch(() => {}); })();
    try { await this.flight; } finally { this.flight = undefined; }
  }
}
