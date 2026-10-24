import { MlHoldouts } from "./holdouts.js";
import { holdoutActive } from "./holdout-model.js";
import { randomUUID } from "node:crypto";
import { canonical, hash } from "../training-worker/files.js";
import { id, integer, MlBusyError, MlError, object, string, type Experiment } from "./model.js";
import { evaluatedModel, modelContract } from "./registry-model.js";
import { modelReceipt } from "./registry-store.js";
import { actionTerminal } from "./monitor-model.js";
import { promotionEvidence, promotionHealth, promotionLimits, promotionPending, type PromotionDecision, type PromotionPolicy } from "./promotion-model.js";
import type { MlService } from "./service.js";
import type { MlState } from "./store.js";

export class MlPromotions {
  private flight?: Promise<void>;
  private closing = false;
  private operations = new Set<Promise<unknown>>();
  private holdouts: MlHoldouts;
  constructor(private service: MlService, private now: () => number = Date.now) { this.holdouts = new MlHoldouts(service, now); }
  private get(value: string, s = this.service.store.read()) { const p = s.promotions.find(p => p.id === id(value)); if (!p) throw new MlError("Promotion policy not found", 404); return p; }
  private deployment(p: PromotionPolicy, s = this.service.store.read()) { return s.deployments.find(d => d.id === p.deploymentId)!; }
  private model(p: PromotionPolicy, s = this.service.store.read()) { return s.registry.find(m => m.id === p.modelId)!; }
  private async track<T>(work: () => Promise<T>) { if (this.closing) throw new MlError("Promotions are closing", 409); const f = work(); this.operations.add(f); try { return await f; } finally { this.operations.delete(f); } }
  active() { return !!this.flight || !!this.operations.size || this.service.store.read().promotions.some(p => p.state === "enabled" || p.evaluations?.some(holdoutActive) || p.decisions.some(a => a.state === "observing" || a.state === "ready")); }
  usesTarget(value: string) { return this.service.store.read().promotions.some(p => p.target.id === value && (p.state === "enabled" || p.evaluations?.some(holdoutActive) || p.decisions.some(a => a.state === "observing" || a.state === "ready"))); }
  async close() { this.closing = true; await Promise.allSettled([...this.operations, ...(this.flight ? [this.flight] : [])]); }
  private current(p: PromotionPolicy, s = this.service.store.read()) {
    const d = this.deployment(p, s), m = this.model(p, s);
    if (!d.enabled || d.revision !== p.deploymentRevision || d.current !== p.releaseId || m.selectedVersionId !== d.releases.find(r => r.id === d.current)!.versionId || m.history.at(-1)?.id !== p.selectionId) throw new MlError("Deployment or registry selection changed; review a new promotion policy", 409);
    this.service.assertTarget(p.target, s, true); return d;
  }
  create(raw: unknown) { return this.track(async () => {
    const v = object(raw, ["deploymentId", "revision", "operationId", "name", "source", "includeExisting", "mode", "limits", "health", "authorized", "holdout"], "promotion policy");
    const d = this.service.store.read().deployments.find(d => d.id === id(v.deploymentId)); if (!d) throw new MlError("Deployment not found", 404);
    await this.service.authorize(d.project, d.repo);
    const operationId = id(v.operationId), requestHash = hash(canonical(v)), prior = this.service.store.read().promotions.find(p => p.operationId === operationId);
    if (prior) { if (prior.requestHash !== requestHash) throw new MlError("Promotion operation inputs changed", 409); return prior; }
    if (!this.service.enabled() || v.authorized !== true || v.revision !== d.revision || !d.enabled) throw new MlError("Review and authorize this deployment's promotion and rollback policy", 409);
    if (!["approval", "automatic"].includes(v.mode) || typeof v.includeExisting !== "boolean") throw new MlError("Choose approval mode and whether to include existing results");
    const model = this.service.store.read().registry.find(m => m.id === d.modelId)!;
    if (model.selectedVersionId !== d.releases.find(r => r.id === d.current)!.versionId) throw new MlError("Select the deployed version in the model registry before creating a promotion policy", 409);
    const source = object(v.source, ["kind", "id"], "candidate source");
    if (["registry", "searches"].includes(source.kind) ? source.id !== undefined : source.kind !== "schedule" || !this.service.store.read().schedules.some(s => s.id === id(source.id) && s.template.project === d.project && s.template.repo === d.repo && modelContract(s.template) === modelContract(this.service.store.read().experiments.find(e => e.id === model.versions[0]!.jobId)!))) throw new MlError("Choose this model's registry or a compatible training schedule", 409);
    const health = promotionHealth(v.health), limits = promotionLimits(v.limits, health), holdout = v.holdout === undefined ? undefined : this.holdouts.config(v.holdout, d.id);
    const p: PromotionPolicy = { id: randomUUID(), operationId, requestHash, revision: 1, name: string(v.name, "policy name", 100), project: d.project, repo: d.repo, createdAt: this.now(), deploymentId: d.id, modelId: d.modelId, target: d.target, deploymentRevision: d.revision, releaseId: d.current, selectionId: model.history.at(-1)!.id, source: source as PromotionPolicy["source"], includeExisting: v.includeExisting, mode: v.mode, state: "enabled", limits, health, decisions: [], ...(holdout ? { holdout, evaluations: [] } : {}) };
    return this.service.store.change(s => { const same = s.promotions.find(x => x.operationId === operationId); if (same) { if (same.requestHash !== requestHash) throw new MlError("Promotion operation inputs changed", 409); return same; } this.current(p, s); if (this.closing || !this.service.enabled()) throw new MlError("Promotion disabled", 409); if (s.promotions.length >= 32 || s.promotions.some(x => x.modelId === p.modelId && (x.state === "enabled" || x.evaluations?.some(holdoutActive) || x.decisions.some(a => a.state === "observing" || a.state === "ready")))) throw new MlError("Pause the existing policy and finish its rollout before reusing this model, or review policy capacity", 409); s.promotions.push(p); return p; });
  }); }
  update(value: string, action: "pause" | "resume" | "check" | "approve" | "reject" | "rollback", raw: unknown) { return this.track(async () => {
    const v = object(raw, ["revision", "decisionId", "reason"]), p = this.get(value);
    integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Promotion policy revision");
    if (action !== "pause" && action !== "reject") { await this.service.authorize(p.project, p.repo); if (!this.service.enabled()) throw new MlError("Enable ML before promotion or rollback", 409); }
    await this.service.store.change(s => {
      const p = this.get(value, s); if (p.revision !== v.revision) throw new MlError("Promotion policy changed; refresh before acting", 409);
      if (["approve", "reject", "rollback"].includes(action)) {
        const a = p.decisions.find(a => a.id === id(v.decisionId)); if (!a) throw new MlError("Promotion decision not found", 404);
        const reason = string(v.reason, "decision reason", 1000);
        if (action === "rollback") {
          if (!["observing", "promoted"].includes(a.state) || !a.deployedRevision) throw new MlError("Choose the current promoted release to roll back", 409);
          this.rolloutCurrent(p, a, s); a.rollbackRequested = true; a.rollbackReason = reason; a.rollbackAttempts = 0; a.outcome = reason;
        } else {
          if (a.state !== "awaiting_approval") throw new MlError("This candidate is not awaiting approval", 409);
          if (action === "approve") { this.guard(p, a, s, "awaiting_approval"); a.approval = "owner"; a.approvedAt = this.now(); a.approvalReason = reason; a.state = "ready"; }
          else { a.state = "rejected"; a.outcome = reason; }
        }
      } else if (action === "pause") { p.state = "paused"; p.reason = "Paused by user; an already deployed release keeps its rollback protection"; this.cancelPending(p, "Policy paused before deployment"); for (const a of p.evaluations ?? []) if (holdoutActive(a)) a.cancelled = true; }
      else { this.current(p, s); if (action === "resume") { if (s.promotions.some(x => x.id !== p.id && x.modelId === p.modelId && (x.state === "enabled" || x.evaluations?.some(holdoutActive) || x.decisions.some(a => a.state === "observing" || a.state === "ready")))) throw new MlError("Another policy owns this model", 409); if (this.attempts(p) >= p.limits.maxAttempts) throw new MlError("Lifetime deployment attempt limit reached", 409); p.state = "enabled"; p.reason = undefined; } }
      if (action !== "check") p.revision++;
    });
    if (["check", "approve", "rollback"].includes(action)) await this.tick();
    return this.get(value);
  }); }
  private attempts(p: PromotionPolicy) { return p.decisions.filter(a => a.attemptedAt !== undefined).length; }
  private cancelPending(p: PromotionPolicy, reason: string) { for (const a of p.decisions) if (["awaiting_approval", "ready"].includes(a.state)) { a.state = "cancelled"; a.outcome = reason; } }
  private pause(p: PromotionPolicy, reason: string) { p.state = "paused"; p.reason = reason.slice(0, 2000); p.revision++; this.cancelPending(p, reason); }
  private job(value: string, s = this.service.store.read()) { const e = s.experiments.find(e => e.id === value); if (!e) throw new MlError("Promotion evidence is unavailable", 409); return e; }
  private guard(p: PromotionPolicy, a: PromotionDecision, s = this.service.store.read(), expected = "ready") {
    const latest = this.get(p.id, s), decision = latest.decisions.find(x => x.id === a.id)!;
    if (this.closing || !this.service.enabled() || latest.state !== "enabled" || latest.revision !== p.revision || decision.state !== expected || this.now() >= a.expiresAt) throw new MlError("Promotion approval changed or expired", 409);
    const d = this.current(latest, s);
    if (d.revision !== a.deploymentRevision || d.current !== a.releaseId || latest.selectionId !== a.selectionId || modelReceipt(this.job(a.jobId, s)) !== a.receiptHash || modelReceipt(this.job(a.incumbentJobId, s)) !== a.incumbentReceipt) throw new MlError("Promotion evidence changed; fresh review is required", 409);
    if (promotionEvidence(this.job(a.jobId, s), this.job(a.incumbentJobId, s), a.margin, this.holdouts.result(latest, a, s)).concerns.length) throw new MlError("Candidate no longer passes the quality gates", 409);
    if (s.monitors.some(m => m.deploymentId === d.id && m.actions.some(a => !actionTerminal(a)))) throw new MlBusyError("Waiting for the deployment's monitoring action to finish");
    if (s.monitors.length >= 32) throw new MlError("Monitoring history is full; promotion requires a health guard", 409);
    if (d.history.length >= 198 || this.model(latest, s).history.length >= 199) throw new MlError("Selection history is full; promotion must reserve rollback and stop events", 409);
    return latest;
  }
  private discover(p: PromotionPolicy, s: MlState) {
    const model = this.model(p, s), d = this.current(p, s), incumbentVersion = model.versions.find(v => v.id === model.selectedVersionId)!, incumbent = this.job(incumbentVersion.jobId, s);
    const jobs = p.source.kind === "registry" ? model.versions.filter(v => p.includeExisting || v.registeredAt >= p.createdAt).map(v => this.job(v.jobId, s)) : s.cycles.filter(c => c.state === "completed" && (p.source.kind === "searches" || c.schedule?.id === (p.source as { id: string }).id) && c.template.project === p.project && c.template.repo === p.repo && modelContract(c.template) === modelContract(incumbent) && c.finalJobId && (p.includeExisting || c.createdAt >= p.createdAt)).map(c => this.job(c.finalJobId!, s));
    if (!p.holdout) jobs.sort((a, b) => { const x = promotionEvidence(a, incumbent, p.limits.minImprovement), y = promotionEvidence(b, incumbent, p.limits.minImprovement); return Number(!!x.concerns.length) - Number(!!y.concerns.length) || y.gain - x.gain; });
    for (const job of jobs) {
      if (job.registry && job.registry.modelId !== p.modelId || job.id === incumbent.id || p.decisions.some(a => a.jobId === job.id) || !evaluatedModel(job)) continue;
      if (p.decisions.length >= 100) { this.pause(p, "Promotion decision history is full"); return; }
      const evaluated = p.evaluations?.find(e => e.candidateJobId === job.id && e.incumbentJobId === incumbent.id);
      if (p.holdout && !evaluated) { this.holdouts.begin(p, job, incumbent, s); return; }
      if (p.holdout && evaluated?.state !== "completed") continue;
      const commonJob = evaluated ? s.experiments.find(e => e.id === evaluated.jobId) : undefined;
      const margin = Math.max(p.limits.minImprovement, s.cycles.find(c => c.id === job.intent.search?.cycleId)?.limits.minImprovement ?? 0), evidence = promotionEvidence(job, incumbent, margin, commonJob?.status.holdout);
      const ready = !evidence.concerns.length;
      const a: PromotionDecision = { ...(commonJob ? { holdoutJobId: commonJob.id } : {}), id: randomUUID(), jobId: job.id, receiptHash: modelReceipt(job), incumbentJobId: incumbent.id, incumbentReceipt: modelReceipt(incumbent), incumbentVersionId: incumbentVersion.id, ...(job.registry?.modelId === model.id ? { versionId: job.registry.versionId } : {}), at: this.now(), expiresAt: this.now() + p.limits.approvalSeconds * 1000, deploymentRevision: d.revision, releaseId: d.current, selectionId: p.selectionId, state: ready ? p.mode === "automatic" ? "ready" : "awaiting_approval" : "blocked", ...evidence, registerOperation: randomUUID(), selectOperation: randomUUID(), rollbackOperation: randomUUID(), rollbackSelection: randomUUID(), monitorId: randomUUID(), ...(ready && p.mode === "automatic" ? { approvedAt: this.now(), approval: "policy" as const, approvalReason: "Pre-authorized automatic promotion policy" } : {}) };
      p.decisions.push(a); p.revision++;
      if (ready) return;
    }
  }
  /** A monitor-owned training pause may advance the deployment revision, never its version or approval. */
  private followTraining(p: PromotionPolicy, s: MlState) {
    const d = this.deployment(p, s); if (d.revision === p.deploymentRevision) return false;
    const actions = s.monitors.filter(m => m.deploymentId === d.id).flatMap(m => m.actions).filter(a => a.kind === "retrain");
    const changes = d.history.slice(p.deploymentRevision);
    if (d.current !== p.releaseId || !changes.length || !changes.every(h => actions.some(a => h.operationId === a.stopOperation || h.operationId === a.resumeOperation))) return false;
    this.cancelPending(p, "Serving paused for retraining; prior candidate approval was cancelled");
    if (!d.enabled || actions.some(a => !actionTerminal(a))) { p.reason = "Waiting for monitored retraining and serving restoration"; return true; }
    p.deploymentRevision = d.revision; p.revision++; p.reason = undefined; return false;
  }
  async tick() {
    if (this.flight || this.closing) return this.flight;
    this.flight = (async () => { for (const before of this.service.store.read().promotions) {
      if (this.closing) break;
      try {
        let p = this.get(before.id);
        if (await this.holdouts.advance(p)) continue;
        const rollout = [...p.decisions].reverse().find(a => a.deployedRevision !== undefined);
        if (rollout && ["observing", "promoted"].includes(rollout.state) && await this.rollout(p, rollout)) continue;
        p = this.get(before.id); if (p.state !== "enabled") continue;
        if (!this.service.enabled()) throw new MlError("ML disabled; promotion is paused", 409);
        await this.service.authorize(p.project, p.repo);
        const waiting = await this.service.store.change(s => { const p = this.get(before.id, s); if (p.state !== "enabled") return true; if (this.followTraining(p, s)) return true; this.current(p, s);
          const pending = p.decisions.find(promotionPending); if (pending) { if (this.now() >= pending.expiresAt && pending.state !== "observing") { pending.state = "cancelled"; pending.outcome = "Approval expired; this candidate was not deployed"; p.revision++; } return false; }
          if (this.attempts(p) >= p.limits.maxAttempts) { this.pause(p, "Lifetime deployment attempt limit reached"); return true; }
          const last = [...p.decisions].reverse().find(a => a.attemptedAt !== undefined);
          if (last && this.now() - last.attemptedAt! < p.limits.cooldownSeconds * 1000) return true;
          this.discover(p, s); return false;
        });
        if (waiting) continue;
        p = this.get(before.id); const a = p.decisions.find(a => a.state === "ready"); if (a) await this.deploy(p, a);
      } catch (error) {
        if (!(error instanceof MlBusyError)) await this.service.store.change(s => { const p = this.get(before.id, s); const a = p.decisions.find(a => a.state === "ready"); if (a) { a.state = "failed"; a.outcome = (error as Error).message.slice(0, 2000); } const observing = [...p.decisions].reverse().find(a => a.deployedRevision !== undefined && ["observing", "promoted"].includes(a.state)); if (observing) { try { this.rolloutCurrent(p, observing, s); } catch { observing.state = "cancelled"; observing.outcome = "Manual changes ended this rollout; review the current deployment and registry"; } } this.pause(p, (error as Error).message); });
      }
    } })();
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async deploy(p: PromotionPolicy, a: PromotionDecision) {
    this.guard(p, a);
    if (a.attemptedAt === undefined) await this.service.store.change(s => { const latest = this.guard(p, a, s); if (this.attempts(latest) >= p.limits.maxAttempts) throw new MlError("Deployment attempt limit reached", 409); latest.decisions.find(x => x.id === a.id)!.attemptedAt = this.now(); });
    await this.service.registry.withArchive(a.incumbentVersionId, async () => { this.guard(p, a); });
    let job = this.job(a.jobId);
    if (!job.registry) {
      await this.service.registry.register({ project: p.project, repo: p.repo, jobId: job.id, modelId: p.modelId, revision: this.model(p).revision, operationId: a.registerOperation, notes: "Registered by the bounded promotion policy after evaluation" }, s => { this.guard(p, a, s); }); job = this.job(a.jobId);
    }
    if (job.registry!.modelId !== p.modelId) throw new MlError("Candidate registered in another model", 409);
    const versionId = job.registry!.versionId;
    await this.service.store.change(s => { this.guard(p, a, s); this.get(p.id, s).decisions.find(x => x.id === a.id)!.versionId = versionId; });
    await this.service.deployments.update(p.deploymentId, "switch", { revision: a.deploymentRevision, versionId, operationId: a.id, reason: "Promotion policy: candidate passed comparable held-out evaluation and its approval gates" }, s => { this.guard(p, a, s); }, (s, d) => {
      const latest = this.get(p.id, s), decision = latest.decisions.find(x => x.id === a.id)!;
      this.service.registry.commitSelection(s, p.modelId, versionId, "promote", a.selectOperation, "Promotion policy: verified candidate deployed after evaluation and approval");
      this.service.monitors.installHealthGuard(s, d, a.incumbentVersionId, a.monitorId, `${p.name} release health`, p.health, this.now());
      decision.state = "observing"; decision.deployedRevision = d.revision; decision.deployedAt = this.now(); decision.observeUntil = this.now() + p.limits.observationSeconds * 1000; decision.outcome = "Deployed; collecting operational health evidence before accepting this rollout";
      latest.releaseId = d.current; latest.deploymentRevision = d.revision; latest.selectionId = this.model(p, s).history.at(-1)!.id; latest.revision++;
    }, p.holdout ? s => { this.guard(p, a, s); return []; } : undefined);
  }
  private rolloutCurrent(p: PromotionPolicy, a: PromotionDecision, s = this.service.store.read()) {
    const d = this.deployment(p, s), m = this.model(p, s);
    if (!d.enabled || d.revision !== a.deployedRevision || d.releases.find(r => r.id === d.current)!.versionId !== a.versionId || m.selectedVersionId !== a.versionId || m.history.at(-1)?.operationId !== a.selectOperation) throw new MlError("Promoted deployment or registry selection changed; automatic rollback will not override it", 409);
    return d;
  }
  private async rollout(p: PromotionPolicy, a: PromotionDecision) {
    const s = this.service.store.read(), d = this.deployment(p, s), m = s.monitors.find(m => m.id === a.monitorId)!;
    const healthRollback = m.actions.find(x => x.kind === "rollback" && d.history.some(h => h.operationId === x.id));
    if (healthRollback) {
      await this.service.authorize(p.project, p.repo);
      await this.service.store.change(s => { const latest = this.get(p.id, s), model = this.model(p, s), current = this.deployment(p, s);
        if (current.current !== a.releaseId || current.revision !== a.deployedRevision! + 1 || model.selectedVersionId !== a.versionId || model.history.at(-1)?.operationId !== a.selectOperation) throw new MlError("Health rollback completed, but later manual changes require registry review", 409);
        this.service.registry.commitSelection(s, p.modelId, a.incumbentVersionId, "rollback", a.rollbackSelection, "Promotion policy: unhealthy release rolled back by its health guard");
        const decision = latest.decisions.find(x => x.id === a.id)!; decision.state = "rolled_back"; decision.outcome = "Health guard restored the previous deployed and selected model";
        latest.releaseId = current.current; latest.deploymentRevision = current.revision; latest.selectionId = model.history.at(-1)!.id; this.pause(latest, decision.outcome);
      }); return true;
    }
    if (a.state === "promoted" && !a.rollbackRequested) return false;
    this.rolloutCurrent(p, a, s);
    if (!this.service.enabled()) return true;
    await this.service.authorize(p.project, p.repo);
    if (m.actions.some(x => !actionTerminal(x))) return true;
    const failedGuard = m.state !== "enabled" || m.actions.some(x => x.state === "failed" || x.state === "cancelled");
    if (!a.rollbackRequested && !failedGuard && this.now() < a.observeUntil!) return true;
    const recent = m.reports.slice(-p.health.consecutiveWindows);
    const healthy = recent.length === p.health.consecutiveWindows && recent.every(r => r.sufficient && !r.health && r.start >= a.deployedAt!) && this.now() - recent.at(-1)!.end < p.health.windowSeconds * 2000;
    if (!a.rollbackRequested && !failedGuard && healthy) {
      await this.service.store.change(s => { this.rolloutCurrent(p, a, s); const latest = this.get(p.id, s), decision = latest.decisions.find(x => x.id === a.id)!; decision.state = "promoted"; decision.outcome = "Comparable evaluation and operational health gates passed; rollback monitoring remains active"; latest.revision++; }); return false;
    }
    if ((a.rollbackAttempts ?? 0) >= 3) { await this.service.store.change(s => { const latest = this.get(p.id, s), decision = latest.decisions.find(x => x.id === a.id)!; decision.state = "failed"; decision.outcome = "Rollback could not load the prior release after three attempts; inspect the worker and roll back manually"; this.pause(latest, decision.outcome); }); return true; }
    await this.service.store.change(s => { this.rolloutCurrent(p, a, s); const decision = this.get(p.id, s).decisions.find(x => x.id === a.id)!; decision.rollbackRequested = true; decision.rollbackAttempts = (decision.rollbackAttempts ?? 0) + 1; });
    await this.service.deployments.update(d.id, "rollback", { revision: a.deployedRevision, versionId: a.incumbentVersionId, operationId: a.rollbackOperation, reason: a.rollbackReason ?? "Promotion policy: restore the previous release after insufficient healthy observation" }, s => { this.rolloutCurrent(p, a, s); }, (s, current) => {
      const latest = this.get(p.id, s), decision = latest.decisions.find(x => x.id === a.id)!;
      this.service.registry.commitSelection(s, p.modelId, a.incumbentVersionId, "rollback", a.rollbackSelection, a.rollbackReason ?? "Promotion policy: restore the prior selection with its deployment");
      const guard = s.monitors.find(m => m.id === a.monitorId)!; guard.state = "paused"; guard.revision++; guard.reason = "Promotion rolled back";
      decision.state = "rolled_back"; decision.outcome = "Previous deployed and selected model restored";
      latest.releaseId = current.current; latest.deploymentRevision = current.revision; latest.selectionId = this.model(p, s).history.at(-1)!.id; this.pause(latest, decision.outcome);
    }); return true;
  }
}
