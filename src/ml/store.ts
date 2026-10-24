import { validatePromotions } from "./promotion-store.js";
import type { PromotionPolicy } from "./promotion-model.js";
import { validateMonitors } from "./monitor-store.js";
import type { ModelMonitor } from "./monitor-model.js";
import { validateDeployments } from "./deployment-store.js";
import type { Deployment } from "./deployment-model.js";
import { validateRegistry } from "./registry-store.js";
import type { RegisteredModel } from "./registry-model.js";
import { cadence, fingerprint, type TrainingSchedule } from "./schedule-model.js";
import { cycleTerminal, plannerConfig, searchLimits, type Cycle } from "./cycle-model.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomic, canonical, json } from "../training-worker/files.js";
import { dataset, digest, id, intent, jobStatus, integer, string, MlError, type Dataset, type Experiment, type Target } from "./model.js";
export interface SnapshotRecord { id: string; project: string; repo: string; target: Target; dataset: Dataset; purpose?: "holdout" }
export interface MlState {
  version: 1; revision: number; controllerId: string; targets: Target[]; datasets: SnapshotRecord[];
  experiments: Experiment[]; cycles: Cycle[]; schedules: TrainingSchedule[]; registry: RegisteredModel[]; deployments: Deployment[]; monitors: ModelMonitor[]; promotions: PromotionPolicy[]; defaults: Record<string, string>;
}
export class MlStore {
  private tail: Promise<unknown> = Promise.resolve();
  private current?: MlState;
  constructor(readonly directory: string) {}
  async load() {
    const stored = await json<MlState>(join(this.directory, "state.json"), true);
    this.current = stored ?? { version: 1, revision: 0, controllerId: randomUUID(), targets: [{ id: "local", revision: 1, name: "This computer", kind: "local", directory: join(this.directory, "worker"), python: process.env.CODEFLOW_ML_PYTHON ?? "python3" }], datasets: [], experiments: [], cycles: [], schedules: [], registry: [], deployments: [], monitors: [], promotions: [], defaults: {} };
    if (this.current.cycles === undefined) this.current.cycles = [];
    if (this.current.schedules === undefined) this.current.schedules = [];
    if (this.current.registry === undefined) this.current.registry = [];
    if (this.current.deployments === undefined) this.current.deployments = [];
    if (this.current.monitors === undefined) this.current.monitors = [];
    if (this.current.promotions === undefined) this.current.promotions = [];
    this.validate(this.current);
    if (!stored) await atomic(join(this.directory, "state.json"), this.current);
  }
  private validate(s: MlState) {
    if (Buffer.byteLength(JSON.stringify(s)) > 8 * 1024 * 1024) throw new MlError("ML history reached its 8 MiB storage limit; no additional records were saved", 409);
    if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.targets) || s.targets.length > 32 || !Array.isArray(s.experiments) || s.experiments.length > 200 || !Array.isArray(s.datasets) || s.datasets.length > 200 || !s.defaults || typeof s.defaults !== "object") throw new MlError("Invalid ML storage; repair it before starting work", 503);
    id(s.controllerId);
    if (!Array.isArray(s.cycles) || s.cycles.length > 100 || new Set(s.cycles.map(c => c.id)).size !== s.cycles.length) throw new MlError("Invalid search history", 503);
    const immutableSpec = (spec: any) => { const { forest, learningRate, rank, maxSteps, accumulation, ...fixed } = spec; return canonical(fixed); };
    for (const c of s.cycles) {
      id(c.id); id(c.operationId); digest(c.requestHash); searchLimits(c.limits); plannerConfig(c.planner); intent(c.template.intent);
      integer(c.createdAt, 1, Number.MAX_SAFE_INTEGER, "Search creation time");
      string(c.name, "search name", 200); string(c.objective, "search objective", 2000);
      if (c.template.intent.kind !== "training" || c.template.intent.search || c.template.intent.controllerId !== s.controllerId || c.template.target.workerId !== c.template.intent.workerId || c.template.target.bundle !== c.template.intent.bundle || c.template.id !== c.template.intent.id) throw new MlError("Search authority changed", 503);
      if (!["running", "paused", "stopping", "completed", "stopped"].includes(c.state) || c.expiresAt !== c.createdAt + c.limits.elapsedSeconds * 1000 || c.trials.length > c.limits.iterations) throw new MlError("Invalid search ledger", 503);
      let reserved = 0;
      for (const [index, t] of c.trials.entries()) {
        if (t.number !== index + 1 || !["planning", "running", "done", "rejected"].includes(t.state)) throw new MlError("Invalid trial ledger", 503);
        if (t.jobId) { const e = s.experiments.find(e => e.id === t.jobId); if (!e || e.intent.search?.cycleId !== c.id || e.intent.search.partition !== "validation") throw new MlError("Missing trial receipt", 503); if (!t.spec || canonical(t.spec) !== canonical(e.intent.spec) || immutableSpec(t.spec) !== immutableSpec(c.template.intent.spec) || e.target.workerId !== c.template.target.workerId || e.intent.bundle !== c.template.intent.bundle || e.project !== c.template.project || e.repo !== c.template.repo || canonical(e.intent.source) !== canonical(c.template.intent.source) || canonical(e.intent.dataset) !== canonical(c.template.intent.dataset) || canonical(e.intent.model ?? null) !== canonical(c.template.intent.model ?? null) || e.intent.deadline > c.expiresAt) throw new MlError("Trial inputs or limits changed", 503); reserved += e.intent.spec!.trainSeconds; }
      }
      if (c.reservedTrainSeconds !== reserved || reserved > c.limits.trainSeconds) throw new MlError("Search training reservation changed", 503);
      if (c.bestJobId && !c.trials.some(t => t.jobId === c.bestJobId)) throw new MlError("Invalid selected trial", 503);
      if (c.finalJobId && !s.experiments.some(e => e.id === c.finalJobId && e.intent.search?.cycleId === c.id && e.intent.search.partition === "test" && e.intent.search.fromJob?.id === c.bestJobId)) throw new MlError("Invalid final test receipt", 503);
      if (!cycleTerminal(c) && s.cycles.some(other => other.id !== c.id && !cycleTerminal(other) && (other.template.project === c.template.project || other.template.target.workerId === c.template.target.workerId))) throw new MlError("Conflicting search reservations", 503);
    }
    if (!Array.isArray(s.schedules) || s.schedules.length > 32 || new Set(s.schedules.map(v => v.id)).size !== s.schedules.length || new Set(s.schedules.map(v => v.operationId)).size !== s.schedules.length) throw new MlError("Invalid training schedules", 503);
    for (const p of s.schedules) {
      id(p.id); id(p.operationId); digest(p.requestHash); integer(p.revision, 1, Number.MAX_SAFE_INTEGER, "Schedule revision");
      integer(p.createdAt, 1, Number.MAX_SAFE_INTEGER, "Schedule creation time"); integer(p.nextAt, 1, Number.MAX_SAFE_INTEGER, "Next check time");
      cadence(p.cadence); searchLimits(p.limits); plannerConfig(p.planner); intent(p.template.intent);
      string(p.name, "schedule name", 200); string(p.objective, "schedule objective", 2000); string(p.source.path, "dataset path", 4096);
      integer(p.stabilitySeconds, 60, 3600, "Stable data seconds"); integer(p.maxCycles, 1, 100, "Maximum scheduled runs");
      const base = s.datasets.find(d => d.id === p.datasetId);
      if (!base || base.project !== p.template.project || base.repo !== p.template.repo || canonical(base.dataset) !== canonical(p.template.intent.dataset) || p.template.intent.kind !== "training" || p.template.intent.search || p.template.intent.controllerId !== s.controllerId || p.template.target.workerId !== p.template.intent.workerId || p.template.target.bundle !== p.template.intent.bundle || p.template.id !== p.template.intent.id || !p.source.path.startsWith("/") || !["target", "controller"].includes(p.source.location)) throw new MlError("Schedule authority or source changed", 503);
      if (p.template.intent.model && !s.experiments.some(e => e.id === p.modelId && e.intent.kind === "model" && e.status.state === "succeeded" && canonical(e.status.model) === canonical(p.template.intent.model) && e.project === p.template.project && e.repo === p.template.repo && e.target.workerId === p.template.target.workerId)) throw new MlError("Missing scheduled base model", 503);
      if (!["enabled", "paused", "exhausted"].includes(p.state) || !Array.isArray(p.runs) || p.runs.length > p.maxCycles || (p.state === "exhausted") !== (p.runs.length === p.maxCycles) || new Set(p.runs.map(r => r.hash)).size !== p.runs.length || new Set(p.runs.map(r => r.occurrence)).size !== p.runs.length) throw new MlError("Invalid schedule run ledger", 503);
      if (p.pending) { id(p.pending.id); integer(p.pending.startedAt, 1, Number.MAX_SAFE_INTEGER, "Check start time"); if (p.state !== "enabled") throw new MlError("Inactive schedule has a pending check", 503); }
      if (p.candidate) { fingerprint({ hash: p.candidate.hash, bytes: p.candidate.bytes, format: p.candidate.format }); integer(p.candidate.firstSeenAt, 1, Number.MAX_SAFE_INTEGER, "Data observation time"); }
      for (const run of p.runs) {
        id(run.occurrence); digest(run.hash); integer(run.at, 1, Number.MAX_SAFE_INTEGER, "Scheduled run time");
        const c = s.cycles.find(c => c.id === run.cycleId);
        if (!c || c.schedule?.id !== p.id || c.schedule.occurrence !== run.occurrence || c.operationId !== run.occurrence || c.template.intent.dataset?.hash !== run.hash || run.hash === p.template.intent.dataset?.hash || canonical(c.template.target) !== canonical(p.template.target) || c.template.project !== p.template.project || c.template.repo !== p.template.repo || canonical(c.template.intent.spec) !== canonical(p.template.intent.spec) || canonical(c.template.intent.model ?? null) !== canonical(p.template.intent.model ?? null) || c.template.intent.recipe !== p.template.intent.recipe || canonical(c.limits) !== canonical(p.limits) || canonical(c.planner) !== canonical(p.planner) || c.objective !== p.objective) throw new MlError("Scheduled search inputs or budget changed", 503);
      }
    }
    for (const c of s.cycles) if (c.schedule && !s.schedules.some(p => p.id === c.schedule!.id && p.runs.some(r => r.cycleId === c.id && r.occurrence === c.schedule!.occurrence))) throw new MlError("Missing schedule ledger", 503);
    for (const e of s.experiments) if (e.intent.kind === "holdout" && !s.promotions.some(p => p.evaluations?.some(a => a.jobId === e.id))) throw new MlError("Missing common holdout admission ledger", 503);
    validateRegistry(s.registry, s.experiments);
    validateDeployments(s); validateMonitors(s); validatePromotions(s);
    for (const t of s.targets) {
      id(t.id); string(t.name, "computer name", 100); string(t.directory, "worker directory", 4096); string(t.python, "Python executable", 4096);
      if (!Number.isSafeInteger(t.revision) || t.revision < 1 || !["local", "ssh"].includes(t.kind) || !(t.directory.startsWith("/") || t.kind === "ssh" && t.directory.startsWith("~/")) || t.python !== "python3" && !t.python.startsWith("/") || !!t.workerId !== !!t.bundle || t.kind === "ssh" && (typeof t.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(t.host))) throw new MlError("Invalid saved training target", 503);
      if (t.workerId) id(t.workerId); if (t.bundle) digest(t.bundle);
    }
    if (new Set(s.targets.map(t => t.id)).size !== s.targets.length || new Set(s.experiments.map(e => e.id)).size !== s.experiments.length) throw new MlError("Duplicate ML identities", 503);
    for (const d of s.datasets) { id(d.id); dataset(d.dataset); if (d.purpose !== undefined && d.purpose !== "holdout") throw new MlError("Invalid dataset purpose", 503); }
    for (const e of s.experiments) { intent(e.intent); jobStatus(e.status); if (e.intent.search && !s.cycles.some(c => c.id === e.intent.search!.cycleId && (c.trials.some(t => t.jobId === e.id) || c.finalJobId === e.id))) throw new MlError("Missing search ledger", 503); if (e.id !== e.intent.id || e.target.workerId !== e.intent.workerId || e.intent.controllerId !== s.controllerId || e.status.id !== e.id) throw new MlError("ML job authority changed", 503); digest(e.requestHash); if (e.cancelRequestedAt !== undefined) integer(e.cancelRequestedAt, 1, Number.MAX_SAFE_INTEGER, "Cancellation time"); }
  }
  read(): MlState { if (!this.current) throw new MlError("ML storage is unavailable", 503); return structuredClone(this.current); }
  change<T>(mutate: (state: MlState) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      const previous = this.read(), next = structuredClone(previous), result = mutate(next); next.revision++;
      // Leave room for outstanding worker receipts and cancellation errors even
      // when large column manifests bring history close to its read-size limit.
      // Stop and rollback receipts use that reserve; recovery must remain possible at admission capacity.
      const registrySize = (s: MlState) => s.promotions.reduce((n, p) => n + 1 + p.decisions.length + (p.evaluations?.length ?? 0), 0) + s.monitors.reduce((n, m) => n + 1 + m.actions.filter(a => a.kind !== "rollback").length, 0) + s.deployments.reduce((n, d) => n + 1 + d.releases.length + d.history.filter(h => h.action !== "stop" && h.action !== "rollback").length, 0) + s.registry.reduce((n, m) => n + 1 + m.versions.length + m.history.filter(h => h.action !== "rollback").length, 0);
      if (registrySize(next) + next.targets.length + next.datasets.length + next.experiments.length + next.cycles.length + next.schedules.length > registrySize(previous) + previous.targets.length + previous.datasets.length + previous.experiments.length + previous.cycles.length + previous.schedules.length && Buffer.byteLength(JSON.stringify(next)) > 6 * 1024 * 1024) throw new MlError("ML history is full; no additional work was admitted", 409);
      this.validate(next); await atomic(join(this.directory, "state.json"), next); this.current = next;
      return structuredClone(result);
    });
    this.tail = operation.catch(() => {}); return operation;
  }
}
