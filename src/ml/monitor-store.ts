import { canonical } from "../training-worker/files.js";
import { digest, id, integer, MlError, string } from "./model.js";
import { actionTerminal, HISTOGRAM_BINS, monitorLimits, type ModelMonitor, type MonitorWindow } from "./monitor-model.js";
import type { MlState } from "./store.js";
export function validateMonitors(s: MlState) {
  const fail = (): never => { throw new MlError("Invalid model monitoring authority or history", 503); };
  if (!Array.isArray(s.monitors) || s.monitors.length > 32 || new Set(s.monitors.map(m => m.id)).size !== s.monitors.length || new Set(s.monitors.map(m => m.operationId)).size !== s.monitors.length) fail();
  const window = (w: MonitorWindow, m: ModelMonitor) => {
    integer(w.start, 1, Number.MAX_SAFE_INTEGER, "Monitoring start");
    if (w.end !== w.start + m.limits.windowSeconds * 1000) fail();
    integer(w.requests, 0, 100000, "Monitoring request count"); integer(w.failures, 0, w.requests, "Monitoring failures"); integer(w.samples, 0, 1000000, "Monitoring samples"); integer(w.latencyMs, 0, w.requests * 300000, "Monitoring latency");
    if (!Array.isArray(w.histograms) || w.histograms.length !== m.features.length) fail();
    for (const h of w.histograms) { if (!Array.isArray(h) || h.length !== HISTOGRAM_BINS || h.some(n => !Number.isSafeInteger(n) || n < 0) || h.reduce((a, b) => a + b, 0) !== w.samples) fail(); }
  };
  for (const c of s.cycles) if (c.monitor && !s.monitors.some(m => m.id === c.monitor!.id && m.actions.some(a => a.id === c.monitor!.actionId && a.cycleId === c.id))) fail();
  const actionIds = new Set<string>();
  for (const m of s.monitors) {
    id(m.id); id(m.operationId); digest(m.requestHash); id(m.salt); string(m.name, "Monitor name", 100); monitorLimits(m.limits); integer(m.revision, 1, Number.MAX_SAFE_INTEGER, "Monitor revision"); integer(m.createdAt, 1, Number.MAX_SAFE_INTEGER, "Monitor creation");
    const d = s.deployments.find(d => d.id === m.deploymentId), r = d?.releases.find(r => r.id === m.releaseId);
    if (!d || !r || d.project !== m.project || d.repo !== m.repo || canonical(d.target) !== canonical(m.target) || !["enabled", "paused"].includes(m.state)) fail();
    integer(m.deploymentRevision, 1, d!.revision, "Monitored deployment revision");
    if (!Array.isArray(m.features) || !m.features.length || m.features.length > 16 || new Set(m.features).size !== m.features.length || m.features.some(f => !(r!.base ? ["promptCharacters", "inputTokens", "outputTokens", "emptyOutput"] : r!.features).includes(f))) fail();
    if (m.rollbackVersionId && (!d!.history.some(h => d!.releases.find(r => r.id === h.to)?.versionId === m.rollbackVersionId) || m.rollbackVersionId === r!.versionId)) fail();
    if (m.retrain) { const p = s.schedules.find(p => p.id === m.retrain!.scheduleId); if (!p || p.template.project !== m.project || p.template.repo !== m.repo || (p.template.intent.recipe ?? "tabular-autogluon-v1") !== r!.recipe || typeof m.retrain.allowServingPause !== "boolean") fail(); integer(m.retrain.scheduleRevision, 1, Number.MAX_SAFE_INTEGER, "Training policy revision"); }
    if (m.reason !== undefined) string(m.reason, "Monitor reason", 2000);
    integer(m.healthStreak, 0, 10, "Health streak"); integer(m.driftStreak, 0, 10, "Drift streak");
    window(m.window, m); if (m.reference) { window(m.reference, m); if (m.reference.samples < m.limits.minSamples || m.reference.requests < m.limits.minRequests) fail(); } if (m.candidate) window(m.candidate, m);
    if (!Array.isArray(m.reports) || m.reports.length > 20 || !Array.isArray(m.actions) || m.actions.length > m.limits.maxActions || m.actions.filter(a => !actionTerminal(a)).length > 1) fail();
    for (const v of m.reports) { integer(v.at, 1, Number.MAX_SAFE_INTEGER, "Report time"); integer(v.requests, 0, 100000, "Report requests"); integer(v.samples, 0, 1000000, "Report samples"); if (![v.errorRate, v.meanLatencyMs, v.drift ?? 0].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) || v.errorRate > 1 || (v.drift ?? 0) > 1 || !Array.isArray(v.shifted) || v.shifted.some(f => !m.features.includes(f)) || [v.health, v.dataDrift, v.sufficient].some(x => typeof x !== "boolean")) fail(); }
    for (const a of m.actions) {
      id(a.id); id(a.stopOperation); id(a.resumeOperation); if (actionIds.has(a.id)) fail(); actionIds.add(a.id);
      if (!["pending", "training", "restoring", "completed", "failed", "cancelled"].includes(a.state) || !["rollback", "retrain"].includes(a.kind) || a.kind === "rollback" && !m.rollbackVersionId || a.kind === "retrain" && !m.retrain) fail();
      integer(a.at, 1, Number.MAX_SAFE_INTEGER, "Action time"); integer(a.expiresAt, a.at + 1, Number.MAX_SAFE_INTEGER, "Action expiry"); integer(a.deploymentRevision, 1, d!.revision, "Action deployment revision");
      if (!a.evidence) fail();
      integer(a.evidence.requests, m.limits.minRequests, 100000, "Action evidence requests"); integer(a.evidence.samples, 0, 1000000, "Action evidence samples");
      if (a.state === "training" && !a.cycleId || a.kind === "rollback" && (a.cycleId || a.stoppedRevision)) fail();
      if (!a.evidence || a.evidence.requests < m.limits.minRequests || !Number.isFinite(a.evidence.errorRate) || a.evidence.errorRate < 0 || a.evidence.errorRate > 1 || !Number.isFinite(a.evidence.meanLatencyMs) || a.evidence.meanLatencyMs < 0 || a.kind === "retrain" && (!(a.evidence.drift! >= m.limits.driftThreshold) || a.evidence.drift! > 1 || a.evidence.samples < m.limits.minSamples) || a.kind === "rollback" && a.evidence.errorRate < m.limits.maxErrorRate && a.evidence.meanLatencyMs < m.limits.maxLatencyMs) fail();
      if (a.restoreAttempts !== undefined) integer(a.restoreAttempts, 0, 3, "Serving restore attempts");
      if (a.keepServingStopped !== undefined && a.keepServingStopped !== true) fail();
      if (a.nextCheckAt !== undefined) integer(a.nextCheckAt, 1, Number.MAX_SAFE_INTEGER, "Next source check");
      if (a.outcome !== undefined) string(a.outcome, "Action outcome", 2000);
      if (a.stoppedRevision !== undefined && (a.stoppedRevision !== a.deploymentRevision + 1 || !d!.history.some(h => h.operationId === a.stopOperation && h.action === "stop"))) fail();
      if (a.cycleId) { const c = s.cycles.find(c => c.id === a.cycleId); if (!c || c.operationId !== a.id || c.schedule?.id !== m.retrain?.scheduleId || canonical(c.monitor) !== canonical({ id: m.id, actionId: a.id, drift: a.evidence.drift, requests: a.evidence.requests, samples: a.evidence.samples })) fail(); }
      if (a.source) { digest(a.source.hash); integer(a.source.bytes, 1, 128 * 1024 ** 2, "Source bytes"); integer(a.source.firstSeenAt, 1, Number.MAX_SAFE_INTEGER, "Stable source time"); if (!["csv", "parquet", "jsonl"].includes(a.source.format)) fail(); }
    }
    if (m.lastActionAt !== undefined && m.lastActionAt !== m.actions.at(-1)?.at) fail();
    if (m.state === "enabled" && s.monitors.some(other => other.id !== m.id && other.state === "enabled" && (other.deploymentId === m.deploymentId || m.retrain && other.retrain?.scheduleId === m.retrain.scheduleId))) fail();
  }
}
