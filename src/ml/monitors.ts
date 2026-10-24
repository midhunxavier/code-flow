import { holdoutActive } from "./holdout-model.js";
import { randomUUID } from "node:crypto";
import { canonical, hash } from "../training-worker/files.js";
import { id, integer, MlBusyError, MlError, object, string } from "./model.js";
import { actionTerminal, emptyWindow, monitorLimits, report, type ModelMonitor, type MonitorAction, type MonitorLimits } from "./monitor-model.js";
import { observe } from "./monitor-metrics.js";
import { cycleTerminal } from "./cycle-model.js";
import type { Deployment, InferenceInput, ServingRelease } from "./deployment-model.js";
import type { MlService } from "./service.js";
import type { MlState } from "./store.js";
export class MlMonitors {
  private flight?: Promise<void>;
  private closing = false;
  private operations = new Set<Promise<unknown>>();
  private faults = new Map<string, string>();
  constructor(private service: MlService, private now: () => number = Date.now) {}
  private get(value: string, state = this.service.store.read()) { const m = state.monitors.find(m => m.id === id(value)); if (!m) throw new MlError("Model monitor not found", 404); return m; }
  private deployment(m: ModelMonitor, state = this.service.store.read()) { return state.deployments.find(d => d.id === m.deploymentId)!; }
  private current(m: ModelMonitor, state = this.service.store.read()) { const d = this.deployment(m, state); if (!d.enabled || d.current !== m.releaseId || d.revision !== m.deploymentRevision) throw new MlError("Deployment changed or stopped; create a monitor for the reviewed version", 409); return d; }
  private async track<T>(work: () => Promise<T>) { if (this.closing) throw new MlError("Monitoring is closing", 409); const p = work(); this.operations.add(p); try { return await p; } finally { this.operations.delete(p); } }
  active() { return !!this.flight || this.operations.size > 0 || this.service.store.read().monitors.some(m => m.state === "enabled" || m.actions.some(a => !actionTerminal(a))); }
  usesSchedule(value: string) { return this.service.store.read().monitors.some(m => m.retrain?.scheduleId === value && (m.state === "enabled" || m.actions.some(a => !actionTerminal(a)))); }
  usesTarget(value: string) { const s = this.service.store.read(); return s.monitors.some(m => (m.target.id === value || s.schedules.find(p => p.id === m.retrain?.scheduleId)?.template.target.id === value) && (m.state === "enabled" || m.actions.some(a => !actionTerminal(a)))); }
  async close() { this.closing = true; await Promise.allSettled([...this.operations, ...(this.flight ? [this.flight] : [])]); }
  /** Installed atomically with a promoted deployment, so no release can escape its health guard after restart. */
  installHealthGuard(s: MlState, d: Deployment, rollbackVersionId: string, monitorId: string, name: string, limits: MonitorLimits, now: number) {
    if (s.monitors.length >= 32) throw new MlError("Monitoring history is full; promotion requires a health guard", 409);
    for (const m of s.monitors.filter(m => m.deploymentId === d.id)) {
      if (m.actions.some(a => !actionTerminal(a))) throw new MlBusyError("Finish the current monitoring action before promotion");
      if (m.state === "enabled") { m.state = "paused"; m.revision++; m.reason = "Version promoted; a new health guard monitors the new release"; }
    }
    const r = d.releases.find(r => r.id === d.current)!, features = r.base ? ["promptCharacters", "inputTokens", "outputTokens", "emptyOutput"] : r.features.slice(0, 16);
    const m: ModelMonitor = { id: monitorId, operationId: monitorId, requestHash: hash(canonical({ deploymentId: d.id, revision: d.revision, rollbackVersionId, limits })), revision: 1, name: name.slice(0, 100), project: d.project, repo: d.repo, deploymentId: d.id, deploymentRevision: d.revision, releaseId: d.current, target: d.target, state: "enabled", createdAt: now, salt: randomUUID(), features, limits, rollbackVersionId, window: emptyWindow(now, limits.windowSeconds, features), reports: [], healthStreak: 0, driftStreak: 0, actions: [] };
    s.monitors.push(m); return m;
  }
  async recover() { if (this.service.store.read().monitors.length) await this.service.store.change(s => { for (const m of s.monitors) { m.window = emptyWindow(this.now(), m.limits.windowSeconds, m.features); m.healthStreak = m.driftStreak = 0; if (m.state === "enabled") m.reason = "Controller restarted; collecting a complete monitoring window"; } }); }
  create(raw: unknown) { return this.track(async () => {
    const v = object(raw, ["deploymentId", "revision", "operationId", "name", "features", "limits", "rollbackVersionId", "retrain"], "model monitor");
    const d = this.service.store.read().deployments.find(d => d.id === id(v.deploymentId)); if (!d) throw new MlError("Deployment not found", 404);
    await this.service.authorize(d.project, d.repo);
    const operationId = id(v.operationId), requestHash = hash(canonical(v)), previous = this.service.store.read().monitors.find(m => m.operationId === operationId);
    if (previous) { if (previous.requestHash !== requestHash) throw new MlError("Monitor operation inputs changed", 409); return previous; }
    if (!this.service.enabled() || !d.enabled || v.revision !== d.revision) throw new MlError("Enable and review the current deployment before monitoring", 409);
    const r = d.releases.find(r => r.id === d.current)!, limits = monitorLimits(v.limits);
    const allowed = r.base ? ["promptCharacters", "inputTokens", "outputTokens", "emptyOutput"] : r.features;
    const features = v.features ?? allowed.slice(0, 16);
    if (!Array.isArray(features) || !features.length || features.length > 16 || new Set(features).size !== features.length || features.some(f => !allowed.includes(f))) throw new MlError("Choose 1–16 model features to monitor");
    const rollbackVersionId = v.rollbackVersionId === undefined ? undefined : id(v.rollbackVersionId);
    if (rollbackVersionId && (rollbackVersionId === r.versionId || !d.history.some(h => d.releases.find(r => r.id === h.to)?.versionId === rollbackVersionId))) throw new MlError("Approve a different, previously deployed rollback version", 409);
    let retrain: ModelMonitor["retrain"];
    if (v.retrain !== undefined) {
      const p = object(v.retrain, ["scheduleId", "scheduleRevision", "allowServingPause"], "retraining policy");
      if (typeof p.allowServingPause !== "boolean") throw new MlError("Choose whether serving can pause for training");
      const schedule = this.service.store.read().schedules.find(s => s.id === id(p.scheduleId));
      if (!schedule || schedule.revision !== p.scheduleRevision || schedule.state !== "paused" || schedule.template.project !== d.project || schedule.template.repo !== d.repo || (schedule.template.intent.recipe ?? "tabular-autogluon-v1") !== r.recipe || schedule.runs.length >= schedule.maxCycles) throw new MlError("Choose a paused retraining schedule from this model's project, repository and recipe, with remaining budget", 409);
      this.service.assertTarget(schedule.template.target, this.service.store.read(), true);
      if (schedule.template.target.workerId === d.target.workerId && !p.allowServingPause) throw new MlError("Authorize a serving pause to retrain on the same computer", 409);
      retrain = { scheduleId: schedule.id, scheduleRevision: schedule.revision, allowServingPause: p.allowServingPause };
    }
    const now = this.now();
    const monitor: ModelMonitor = { id: randomUUID(), operationId, requestHash, revision: 1, name: string(v.name, "monitor name", 100), project: d.project, repo: d.repo, deploymentId: d.id, deploymentRevision: d.revision, releaseId: d.current, target: d.target, state: "enabled", createdAt: now, salt: randomUUID(), features, limits, ...(rollbackVersionId ? { rollbackVersionId } : {}), ...(retrain ? { retrain } : {}), window: emptyWindow(now, limits.windowSeconds, features), reports: [], healthStreak: 0, driftStreak: 0, actions: [] };
    return this.service.store.change(s => { const same = s.monitors.find(m => m.operationId === operationId); if (same) { if (same.requestHash !== requestHash) throw new MlError("Monitor operation inputs changed", 409); return same; } if (retrain) this.trainingPolicy(monitor, s); if (this.closing || !this.service.enabled()) throw new MlError("Monitoring is disabled", 409); this.current(monitor, s); if (s.monitors.length >= 32) throw new MlError("Monitoring history is full", 409); if (s.monitors.some(m => (m.state === "enabled" || m.actions.some(a => !actionTerminal(a))) && (m.deploymentId === d.id || retrain && m.retrain?.scheduleId === retrain.scheduleId))) throw new MlError("Pause the existing monitor and finish its action before reusing this deployment or training schedule", 409); s.monitors.push(monitor); return monitor; });
  }); }
  update(value: string, action: "pause" | "resume" | "check" | "reference", raw: unknown) { return this.track(async () => {
    const v = object(raw, action === "pause" ? ["revision", "stopActive", "keepServingStopped"] : ["revision"]), m = this.get(value);
    integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Monitor revision"); if (v.stopActive !== undefined && typeof v.stopActive !== "boolean" || v.keepServingStopped !== undefined && typeof v.keepServingStopped !== "boolean") throw new MlError("Invalid stop option");
    if (action !== "pause") { await this.service.authorize(m.project, m.repo); if (!this.service.enabled()) throw new MlError("Monitoring is disabled", 409); }
    await this.service.store.change(s => {
      const m = this.get(value, s); if (m.revision !== v.revision) throw new MlError("Monitor changed; refresh before updating", 409);
      if (action === "pause") { m.state = "paused"; m.reason = "Paused by user; admitted searches retain their original limits"; if (v.keepServingStopped) for (const a of m.actions) if (!actionTerminal(a)) a.keepServingStopped = true; }
      else {
        this.current(m, s);
        if (action === "resume") { if (s.monitors.some(other => other.id !== m.id && (other.state === "enabled" || other.actions.some(a => !actionTerminal(a))) && (other.deploymentId === m.deploymentId || m.retrain && other.retrain?.scheduleId === m.retrain.scheduleId))) throw new MlError("Another monitor owns this deployment or training schedule", 409); if (m.actions.some(a => !actionTerminal(a))) throw new MlError("Finish the active monitoring action first", 409); if (m.actions.length >= m.limits.maxActions) throw new MlError("Lifetime action limit reached; create a new reviewed monitor", 409); if (m.retrain) this.trainingPolicy(m, s); m.state = "enabled"; }
        else if (m.state !== "enabled") throw new MlError("Resume this monitor first", 409);
        if (action === "reference") {
          if (m.actions.some(a => !actionTerminal(a))) throw new MlError("Finish the current action before changing its reference", 409);
          const w = m.window.samples >= m.limits.minSamples && m.window.requests >= m.limits.minRequests ? m.window : m.candidate;
          if (!w || w.samples < m.limits.minSamples || w.requests < m.limits.minRequests || w.failures / w.requests >= m.limits.maxErrorRate) throw new MlError("Collect enough successful representative traffic before capturing a reference", 409);
          m.reference = structuredClone(w);
        }
        m.reason = undefined;
      }
      if (action !== "check") { m.revision++; m.healthStreak = m.driftStreak = 0; m.window = emptyWindow(this.now(), m.limits.windowSeconds, m.features); }
    });
    if (action === "pause" && v.stopActive) for (const a of this.get(value).actions) if (!actionTerminal(a) && a.cycleId) await this.service.cycles.stop(a.cycleId);
    if (action === "check") await this.tick();
    return this.get(value);
  }); }
  async record(d: Deployment, r: ServingRelease, input: InferenceInput, result: unknown, elapsedMs: number) {
    if (this.closing || !this.service.enabled()) return;
    const interested = this.service.store.read().monitors.filter(m => m.deploymentId === d.id && m.deploymentRevision === d.revision && m.state === "enabled" && !this.faults.has(m.id));
    if (!interested.length) return;
    try {
      await this.service.authorize(d.project, d.repo);
      await this.service.store.change(s => { for (const before of interested) { const m = this.get(before.id, s); if (m.state !== "enabled" || m.revision !== before.revision || this.deployment(m, s).revision !== d.revision || !this.deployment(m, s).enabled) continue; this.rollWindow(m); observe(m, r, input, result, elapsedMs); } });
    } catch { for (const m of interested) this.faults.set(m.id, "Monitoring samples could not be recorded; automation paused to avoid acting on incomplete evidence"); }
  }
  private rollWindow(m: ModelMonitor) {
    const now = this.now(); if (now < m.window.end) return;
    const r = report(m, now); m.reports.push(r); m.reports = m.reports.slice(-20);
    if (m.window.samples >= m.limits.minSamples && r.sufficient) m.candidate = structuredClone(m.window);
    const gap = now >= m.window.end + m.limits.windowSeconds * 1000;
    m.healthStreak = !gap && r.health ? Math.min(10, m.healthStreak + 1) : 0;
    m.driftStreak = !gap && r.dataDrift ? Math.min(10, m.driftStreak + 1) : 0;
    m.window = emptyWindow(gap ? now : r.end, m.limits.windowSeconds, m.features);
    m.reason = !r.sufficient ? "Insufficient traffic; no automated action" : !m.reference ? "Health checks active; capture a reference to enable drift checks" : undefined;
  }
  private trainingPolicy(m: ModelMonitor, state = this.service.store.read()) {
    const p = state.schedules.find(p => p.id === m.retrain?.scheduleId);
    if (!p || p.state !== "paused" || p.revision !== m.retrain!.scheduleRevision || p.runs.length >= p.maxCycles) throw new MlError("Retraining policy changed or exhausted; review a new monitor", 409);
    this.service.assertTarget(p.template.target, state, true); return p;
  }
  private claim(m: ModelMonitor) {
    if (m.actions.some(a => !actionTerminal(a)) || m.lastActionAt !== undefined && this.now() - m.lastActionAt < m.limits.cooldownSeconds * 1000) return;
    const kind = m.rollbackVersionId && m.healthStreak >= m.limits.consecutiveWindows ? "rollback" : m.retrain && m.driftStreak >= m.limits.consecutiveWindows ? "retrain" : undefined;
    if (!kind) return;
    if (m.actions.length >= m.limits.maxActions) { m.state = "paused"; m.reason = "Lifetime monitor action limit reached"; m.revision++; return; }
    const p = kind === "retrain" ? this.trainingPolicy(m) : undefined, now = this.now();
    const latest = m.reports.at(-1)!;
    m.actions.push({ evidence: { requests: latest.requests, samples: latest.samples, errorRate: latest.errorRate, meanLatencyMs: latest.meanLatencyMs, ...(latest.drift !== undefined ? { drift: latest.drift } : {}) }, id: randomUUID(), kind, at: now, expiresAt: now + (p ? p.stabilitySeconds + p.limits.elapsedSeconds + 300 : 300) * 1000, deploymentRevision: m.deploymentRevision, state: "pending", stopOperation: randomUUID(), resumeOperation: randomUUID() });
    m.lastActionAt = now; m.healthStreak = m.driftStreak = 0;
  }
  async tick() {
    if (this.flight || this.closing) return this.flight;
    this.flight = (async () => { for (const before of this.service.store.read().monitors) {
      if (this.closing) break;
      if (this.service.store.read().promotions.some(p => p.deploymentId === before.deploymentId && p.evaluations?.some(holdoutActive))) continue;
      try {
        if (this.faults.has(before.id)) { await this.pause(before.id, this.faults.get(before.id)!); this.faults.delete(before.id); }
        let m = this.get(before.id);
        if (m.state === "enabled" && !m.actions.some(a => !actionTerminal(a))) {
          if (!this.service.enabled()) throw new MlError("ML disabled; resume monitoring after enabling it", 409);
          await this.service.authorize(m.project, m.repo); this.current(m);
          await this.service.store.change(s => { const latest = this.get(m.id, s); if (latest.state !== "enabled") return; this.current(latest, s); this.rollWindow(latest); this.claim(latest); });
        }
        m = this.get(before.id); const a = m.actions.find(a => !actionTerminal(a)); if (a) await this.advance(m, a);
      } catch (error) { if (!(error instanceof MlBusyError)) {
        await this.pause(before.id, (error as Error).message);
        await this.service.store.change(s => { const m = this.get(before.id, s), a = m.actions.find(a => a.state === "pending"); if (a) { a.state = "restoring"; a.outcome = (error as Error).message.slice(0, 2000); } });
      } }
    } })();
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async pause(value: string, reason: string) { await this.service.store.change(s => { const m = this.get(value, s); if (m.state !== "paused" || m.reason !== reason) { m.state = "paused"; m.revision++; m.reason = reason.slice(0, 2000); m.healthStreak = m.driftStreak = 0; } }); }
  private guard(m: ModelMonitor, a: MonitorAction, state = this.service.store.read()) {
    const latest = this.get(m.id, state), action = latest.actions.find(v => v.id === a.id);
    if (this.closing || !this.service.enabled() || latest.state !== "enabled" || latest.revision !== m.revision || action?.state !== "pending" || this.now() >= a.expiresAt) throw new MlError("Monitoring action authorization changed", 409);
    return latest;
  }
  private async finish(m: ModelMonitor, a: MonitorAction, state: "completed" | "failed" | "cancelled", outcome: string) {
    await this.service.store.change(s => { const latest = this.get(m.id, s), action = latest.actions.find(v => v.id === a.id)!; action.state = state; action.outcome = outcome.slice(0, 2000); latest.window = emptyWindow(this.now(), latest.limits.windowSeconds, latest.features); latest.healthStreak = latest.driftStreak = 0; if (state !== "completed" || a.kind === "rollback" || latest.actions.length >= latest.limits.maxActions) { latest.state = "paused"; latest.revision++; latest.reason = outcome.slice(0, 2000); } });
  }
  private async advance(m: ModelMonitor, a: MonitorAction) {
    const d = this.deployment(m);
    // A committed external step is detected by its immutable operation ID after a restart.
    if (a.kind === "rollback" && d.history.some(h => h.operationId === a.id)) { await this.finish(m, a, "completed", "Approved version restored; review a new monitor for this deployment revision"); return; }
    if (d.history.some(h => h.operationId === a.stopOperation) && !a.stoppedRevision) {
      await this.service.store.change(s => { this.get(m.id, s).actions.find(v => v.id === a.id)!.stoppedRevision = a.deploymentRevision + 1; }); a = this.get(m.id).actions.find(v => v.id === a.id)!;
    }
    if (a.state === "training") {
      const c = this.service.store.read().cycles.find(c => c.id === a.cycleId)!;
      if (this.now() >= a.expiresAt && !cycleTerminal(c)) await this.service.cycles.stop(c.id);
      if (!cycleTerminal(c)) return;
      await this.service.store.change(s => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; action.state = "restoring"; action.outcome = "Bounded retraining finished; inspect its evaluation before registering or deploying a candidate"; });
      a = this.get(m.id).actions.find(v => v.id === a.id)!;
    }
    if (a.state === "restoring") { await this.restore(m, a); return; }
    if (m.state !== "enabled" || !this.service.enabled() || this.now() >= a.expiresAt) {
      await this.service.store.change(s => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; action.state = "restoring"; action.outcome = "Action cancelled or expired before training admission"; }); await this.restore(m, this.get(m.id).actions.find(v => v.id === a.id)!); return;
    }
    await this.service.authorize(m.project, m.repo);
    if (a.kind === "rollback") {
      this.current(m); await this.service.deployments.update(d.id, "rollback", { versionId: m.rollbackVersionId, revision: a.deploymentRevision, operationId: a.id, reason: "Monitoring: consecutive unhealthy request windows; restore the approved version" }, s => { this.guard(m, a, s); });
      await this.finish(m, a, "completed", "Approved version restored; review a new monitor for this deployment revision"); return;
    }
    const p = this.trainingPolicy(m);
    const expectedRevision = a.stoppedRevision ?? a.deploymentRevision;
    if (d.revision !== expectedRevision || d.current !== m.releaseId || a.stoppedRevision && d.enabled || !a.stoppedRevision && !d.enabled) throw new MlError("Deployment changed during the monitoring action; automation paused", 409);
    if (a.nextCheckAt && this.now() < a.nextCheckAt) return;
    await this.service.store.change(s => { this.get(m.id, s).actions.find(v => v.id === a.id)!.nextCheckAt = this.now() + 60000; });
    const source = { project: m.project, repo: m.repo, target: p.template.target.id, ...p.source };
    const observed = await this.service.fingerprint(source); this.guard(m, a);
    if (observed.hash === p.template.intent.dataset!.hash || p.runs.some(r => r.hash === observed.hash)) {
      await this.service.store.change(s => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; action.source = undefined; action.outcome = "Waiting for new training data; previously handled data is not retrained"; }); return;
    }
    if (a.source?.hash !== observed.hash) { await this.service.store.change(s => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; action.source = { ...observed, firstSeenAt: this.now() }; action.outcome = "Waiting for the new training file to remain stable"; }); return; }
    if (this.now() - a.source.firstSeenAt < p.stabilitySeconds * 1000) return;
    if (p.template.target.workerId === d.target.workerId && !a.stoppedRevision) {
      if (!m.retrain!.allowServingPause) throw new MlError("Serving downtime is not authorized", 409);
      const stopped = await this.service.deployments.update(d.id, "stop", { revision: a.deploymentRevision, operationId: a.stopOperation, reason: "Monitoring: pause serving for bounded retraining on this computer" }, s => { this.guard(m, a, s); });
      await this.service.store.change(s => { this.get(m.id, s).actions.find(v => v.id === a.id)!.stoppedRevision = stopped.revision; this.get(m.id, s).actions.find(v => v.id === a.id)!.nextCheckAt = this.now(); }); return;
    }
    if (d.cleanupPending) return;
    if (this.service.deployments.busy(p.template.target.workerId)) throw new MlBusyError("Waiting for serving cleanup or another request");
    const snapshot = await this.service.snapshot(source); this.guard(m, a);
    if (snapshot.dataset.hash !== observed.hash) { await this.service.store.change(s => { this.get(m.id, s).actions.find(v => v.id === a.id)!.source = undefined; }); return; }
    const original = p.template.intent.dataset!;
    if (snapshot.dataset.format !== original.format || snapshot.dataset.schema !== original.schema || canonical([...snapshot.dataset.columns].sort()) !== canonical([...original.columns].sort())) throw new MlError("Training data schema changed; review a new training policy", 409);
    await this.service.schedules.triggerFromMonitor(p.id, p.revision, snapshot.id, a.id, s => { this.guard(m, a, s); const latest = this.deployment(m, s); if (latest.revision !== expectedRevision || latest.current !== m.releaseId) throw new MlError("Deployment changed before retraining admission", 409); }, (s, cycle) => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; cycle.monitor = { id: m.id, actionId: a.id, drift: a.evidence.drift!, requests: a.evidence.requests, samples: a.evidence.samples }; action.cycleId = cycle.id; action.state = "training"; action.outcome = "Agent search admitted with the saved training, iteration and elapsed limits"; });
  }
  private async restore(m: ModelMonitor, a: MonitorAction) {
    const d = this.deployment(m);
    if (a.stoppedRevision && a.keepServingStopped) { await this.finish(m, a, "cancelled", "Serving kept stopped by user; resume the deployment manually when ready"); return; }
    if (a.stoppedRevision) {
      const resumed = d.history.some(h => h.operationId === a.resumeOperation);
      if (!resumed && (d.revision !== a.stoppedRevision || d.enabled || d.current !== m.releaseId)) { await this.finish(m, a, "cancelled", "Serving changed manually; the monitoring action did not override it"); return; }
      if (!resumed) {
        if (!this.service.enabled()) { await this.pause(m.id, "Retraining ended; serving remains stopped until ML is enabled for restoration"); return; }
        await this.service.authorize(m.project, m.repo);
        const c = a.cycleId ? this.service.store.read().cycles.find(c => c.id === a.cycleId) : undefined; if (c && !cycleTerminal(c)) return;
        if ((a.restoreAttempts ?? 0) >= 3) { await this.finish(m, a, "failed", "Original serving release could not be restored after three attempts; inspect the worker and resume the deployment manually"); return; }
        await this.service.store.change(s => { const action = this.get(m.id, s).actions.find(v => v.id === a.id)!; action.restoreAttempts = (action.restoreAttempts ?? 0) + 1; });
        await this.service.deployments.update(d.id, "resume", { revision: a.stoppedRevision, operationId: a.resumeOperation, reason: "Monitoring: restore the original serving release after bounded retraining" }, s => { const latest = this.deployment(m, s), action = this.get(m.id, s).actions.find(v => v.id === a.id)!; if (action.keepServingStopped || latest.revision !== a.stoppedRevision || latest.current !== m.releaseId) throw new MlError("Serving changed before restoration", 409); });
      }
      await this.service.store.change(s => { this.get(m.id, s).deploymentRevision = this.deployment(m, s).revision; });
    }
    await this.finish(m, a, a.cycleId ? "completed" : "cancelled", a.outcome ?? "Monitoring action completed");
  }
}
