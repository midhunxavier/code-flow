import { commonEvidence } from "./holdout-store.js";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { canonical, hash } from "../training-worker/files.js";
import { CHUNK_BYTES, intent, MlBusyError, MlError, terminal, type Experiment } from "./model.js";
import { holdoutActive, holdoutConfig, type HoldoutAttempt, type HoldoutConfig } from "./holdout-model.js";
import { releaseInputs, type ServingRelease } from "./deployment-model.js";
import { actionTerminal, emptyWindow } from "./monitor-model.js";
import { modelContract } from "./registry-model.js";
import { modelReceipt } from "./registry-store.js";
import type { PromotionDecision, PromotionPolicy } from "./promotion-model.js";
import type { MlService } from "./service.js";
import type { MlState } from "./store.js";

/** Evaluation has a durable admission, one worker job and no retry of an unknown outcome. */
export class MlHoldouts {
  constructor(private service: MlService, private now: () => number) {}
  private get(id: string, s = this.service.store.read()) { return s.promotions.find(p => p.id === id)!; }
  config(raw: unknown, deploymentId: string): HoldoutConfig {
    const cfg = holdoutConfig(raw), s = this.service.store.read(), d = s.deployments.find(d => d.id === deploymentId)!, snapshot = s.datasets.find(x => x.id === cfg.datasetId);
    if (!snapshot || snapshot.purpose !== "holdout" || snapshot.project !== d.project || snapshot.repo !== d.repo || snapshot.target.workerId !== d.target.workerId || snapshot.target.bundle !== d.target.bundle || snapshot.dataset.rows > 10000 || snapshot.dataset.duplicateRows) throw new MlError("Prepare an independent common holdout on this deployment's current worker first", 409);
    if ((snapshot.dataset.format === "jsonl") !== !!d.releases.find(r => r.id === d.current)!.base) throw new MlError("Holdout format differs from the deployed model", 409);
    if (d.config.memoryMiB && cfg.memoryMiB > d.config.memoryMiB) throw new MlError("Holdout memory must fit within this deployment's memory limit", 409);
    return cfg;
  }
  result(p: PromotionPolicy, a: PromotionDecision, s = this.service.store.read()) { return commonEvidence(s, p, a); }
  private current(p: PromotionPolicy, a: HoldoutAttempt, s = this.service.store.read()) {
    const d = s.deployments.find(d => d.id === p.deploymentId)!, m = s.registry.find(m => m.id === p.modelId)!;
    if (!d.enabled || d.revision !== a.deploymentRevision || d.current !== a.releaseId || m.history.at(-1)?.id !== a.selectionId || modelReceipt(s.experiments.find(e => e.id === a.candidateJobId)!) !== a.candidateReceipt || modelReceipt(s.experiments.find(e => e.id === a.incumbentJobId)!) !== a.incumbentReceipt) throw new MlError("Serving, selection or evaluation inputs changed during common holdout evaluation", 409);
    this.service.assertTarget(p.target, s, true); return d;
  }
  private admission(p: PromotionPolicy, a: HoldoutAttempt, s = this.service.store.read()) {
    const latest = this.get(p.id, s), attempt = latest.evaluations!.find(x => x.id === a.id)!;
    if (!this.service.enabled() || latest.state !== "enabled" || attempt.cancelled || attempt.state !== "pending" || this.now() >= a.expiresAt) throw new MlError("Common holdout authorization expired or was cancelled", 409);
    return this.current(latest, attempt, s);
  }
  begin(p: PromotionPolicy, candidate: Experiment, incumbent: Experiment, s: MlState) {
    const d = s.deployments.find(d => d.id === p.deploymentId)!;
    if (modelContract(candidate) !== modelContract(incumbent)) return;
    if ((p.evaluations?.length ?? 0) >= p.holdout!.maxEvaluations) { p.state = "paused"; p.reason = "Lifetime common holdout evaluation limit reached"; p.revision++; return; }
    if (this.service.deployments.busy(p.target.workerId, d.id) || s.experiments.some(e => e.target.workerId === p.target.workerId && !terminal(e.status.state)) || s.cycles.some(c => c.template.target.workerId === p.target.workerId && !["completed", "stopped"].includes(c.state)) || s.monitors.some(m => m.deploymentId === d.id && m.actions.some(a => !actionTerminal(a)))) throw new MlBusyError("Waiting for training, inference or monitoring before evaluating the common holdout");
    const now = this.now();
    (p.evaluations ??= []).push({ id: randomUUID(), jobId: randomUUID(), candidateJobId: candidate.id, incumbentJobId: incumbent.id, candidateReceipt: modelReceipt(candidate), incumbentReceipt: modelReceipt(incumbent), at: now, expiresAt: now + p.holdout!.seconds * 1000, deploymentRevision: d.revision, releaseId: d.current, selectionId: p.selectionId, state: "pending" }); p.revision++;
    // Exclude intentional evaluation downtime from monitoring streaks.
    for (const m of s.monitors.filter(m => m.deploymentId === d.id)) { m.window = emptyWindow(now, m.limits.windowSeconds, m.features); m.healthStreak = m.driftStreak = 0; }
  }
  private async upload(p: PromotionPolicy, a: HoldoutAttempt, job: Experiment) {
    const consume = async (file: import("node:fs/promises").FileHandle) => {
      const artifact = job.status.artifact!;
      const status = await this.service.callWorker<{ present: boolean }>(p.target, "serve-upload-status", { hash: artifact.hash, bytes: artifact.bytes });
      if (!status.present) for (let offset = 0; offset < artifact.bytes;) {
        this.admission(p, a);
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, artifact.bytes - offset)), { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new MlError("Holdout export ended unexpectedly", 409);
        await this.service.callWorker(p.target, "serve-upload", { hash: artifact.hash, bytes: artifact.bytes, offset, data: buffer.subarray(0, bytesRead).toString("base64") }); offset += bytesRead;
      }
    };
    if (job.registry) await this.service.registry.withArchive(job.registry.versionId, consume);
    else { const file = await open(await this.service.export(job.id), "r"); try { await consume(file); } finally { await file.close(); } }
  }
  private async finish(p: PromotionPolicy, a: HoldoutAttempt, state: HoldoutAttempt["state"], reason: string) {
    await this.service.store.change(s => {
      const latest = this.get(p.id, s), attempt = latest.evaluations!.find(x => x.id === a.id)!; attempt.state = state; attempt.outcome = reason.slice(0, 2000); latest.revision++;
      if (state !== "completed") { latest.state = "paused"; latest.reason = attempt.outcome; }
      for (const m of s.monitors.filter(m => m.deploymentId === p.deploymentId)) { m.window = emptyWindow(this.now(), m.limits.windowSeconds, m.features); m.healthStreak = m.driftStreak = 0; }
    });
  }
  async advance(p: PromotionPolicy): Promise<boolean> {
    let a = p.evaluations?.find(holdoutActive); if (!a) return false;
    try {
      let job = this.service.store.read().experiments.find(e => e.id === a!.jobId);
      let invalid = p.state !== "enabled" || !this.service.enabled() || a.cancelled || this.now() >= a.expiresAt;
      try { this.current(p, a); await this.service.authorize(p.project, p.repo); } catch { invalid = true; }
      if (job && !terminal(job.status.state)) {
        job = invalid ? await this.service.cancel(job.id) : await this.service.inspect(job.id);
        if (!terminal(job.status.state)) return true;
      }
      if (job || invalid || a.state === "restoring") {
        if (a.state !== "restoring") { await this.service.store.change(s => { const x = this.get(p.id, s).evaluations!.find(x => x.id === a!.id)!; x.state = "restoring"; if (invalid) x.cancelled = true; }); a = this.get(p.id).evaluations!.find(x => x.id === a!.id)!; }
        try { this.current(p, a); } catch { await this.finish(p, a, "cancelled", "Serving changed manually; evaluation did not replace or restart it"); return true; }
        if (!this.service.enabled()) return true;
        await this.service.authorize(p.project, p.repo);
        const d = this.current(p, a);
        if (d.config.mode === "persistent") {
          if ((a.restoreAttempts ?? 0) >= 3) { await this.finish(p, a, "failed", "Serving could not reload after three attempts; inspect the worker and warm the current version manually"); return true; }
          await this.service.store.change(s => { const x = this.get(p.id, s).evaluations!.find(x => x.id === a!.id)!; x.restoreAttempts = (x.restoreAttempts ?? 0) + 1; });
          await this.service.deployments.warm(d.id, a.jobId);
        }
        await this.finish(p, a, a.cancelled ? "cancelled" : job?.status.state === "succeeded" ? "completed" : "failed", a.cancelled ? a.outcome ?? "Common holdout cancelled; original serving version retained" : job?.status.state === "succeeded" ? "Both models evaluated on the frozen common holdout; original serving restored" : job?.status.error ?? "Common holdout could not complete"); return true;
      }
      this.admission(p, a);
      const d = this.current(p, a);
      if (this.service.deployments.busy(p.target.workerId, d.id, a.jobId)) throw new MlBusyError("Waiting for the current inference request");
      if (d.config.mode === "persistent") {
        const status = await this.service.callWorker<import("./deployment-model.js").ResidentStatus>(p.target, "resident-status");
        this.admission(p, a);
        if (status.state === "busy") throw new MlBusyError("Waiting for in-flight inference before holdout evaluation");
        if (status.sessionId && status.deploymentId === d.id && status.revision === d.revision) {
          await this.service.store.change(s => { this.admission(p, a!, s); this.get(p.id, s).evaluations!.find(x => x.id === a!.id)!.sessionId = status.sessionId; });
          await this.service.callWorker(p.target, "resident-discard", { deploymentId: d.id, revision: d.revision, expectedSession: status.sessionId });
        }
      }
      const s = this.service.store.read(), candidate = s.experiments.find(e => e.id === a!.candidateJobId)!, incumbent = s.experiments.find(e => e.id === a!.incumbentJobId)!;
      await this.upload(p, a, incumbent); await this.upload(p, a, candidate); this.admission(p, a);
      const config = { ...d.config, mode: "persistent" as const, memoryMiB: p.holdout!.memoryMiB, idleSeconds: 60, lifetimeSeconds: 1800 };
      const make = (e: Experiment): ServingRelease => { const fields = { controllerId: s.controllerId, workerId: p.target.workerId!, bundle: p.target.bundle!, versionId: e.registry?.versionId ?? e.id, ...releaseInputs(e), config }; return { id: hash(canonical(fields)), ...fields }; };
      const accepted = intent({ version: 1, id: a.jobId, controllerId: s.controllerId, workerId: p.target.workerId!, bundle: p.target.bundle!, recipe: candidate.intent.recipe ?? "tabular-autogluon-v1", kind: "holdout", createdAt: a.at, deadline: a.expiresAt, python: p.target.python, dataset: s.datasets.find(d => d.id === p.holdout!.datasetId)!.dataset, holdout: { candidate: make(candidate), incumbent: make(incumbent), memoryMiB: p.holdout!.memoryMiB, maxLength: p.holdout!.maxLength } });
      await this.service.submitRecord({ id: a.jobId, project: p.project, repo: p.repo, name: `${p.name} common holdout`, operationId: a.id, requestHash: hash(canonical(accepted)), target: p.target, intent: accepted, status: { id: a.jobId, state: "submitted", updatedAt: this.now() } }, s => { this.admission(p, a!, s); this.get(p.id, s).evaluations!.find(x => x.id === a!.id)!.state = "running"; });
    } catch (error) {
      if (error instanceof MlBusyError) return true;
      await this.service.store.change(s => { const latest = this.get(p.id, s), x = latest.evaluations!.find(x => x.id === a!.id)!; latest.state = "paused"; latest.reason = (error as Error).message.slice(0, 2000); latest.revision++; x.outcome = latest.reason; if (x.state === "pending") { x.cancelled = true; x.state = "restoring"; } });
    }
    return true;
  }
}
