/** Browser-safe monitoring policy. Thresholds authorize bounded actions, not arbitrary agent commands. */
import { integer, MlError, object, type Target } from "./model.js";
import type { Fingerprint } from "./schedule-model.js";
export interface MonitorLimits {
  windowSeconds: number; minRequests: number; minSamples: number; consecutiveWindows: number;
  maxErrorRate: number; maxLatencyMs: number; driftThreshold: number; cooldownSeconds: number; maxActions: number;
}
export interface MonitorWindow { start: number; end: number; requests: number; failures: number; latencyMs: number; samples: number; histograms: number[][] }
export interface MonitorReport { at: number; start: number; end: number; requests: number; samples: number; errorRate: number; meanLatencyMs: number; drift?: number; shifted: string[]; health: boolean; dataDrift: boolean; sufficient: boolean }
export interface MonitorAction {
  id: string; kind: "retrain" | "rollback"; at: number; expiresAt: number; deploymentRevision: number;
  state: "pending" | "training" | "restoring" | "completed" | "failed" | "cancelled";
  stopOperation: string; resumeOperation: string; outcome?: string; nextCheckAt?: number; restoreAttempts?: number; keepServingStopped?: boolean;
  evidence: { requests: number; samples: number; errorRate: number; meanLatencyMs: number; drift?: number };
  source?: Fingerprint & { firstSeenAt: number }; stoppedRevision?: number; cycleId?: string;
}
export interface ModelMonitor {
  id: string; operationId: string; requestHash: string; revision: number; name: string;
  project: string; repo: string; deploymentId: string; deploymentRevision: number; releaseId: string; target: Target;
  state: "enabled" | "paused"; reason?: string; createdAt: number; salt: string; features: string[];
  limits: MonitorLimits; rollbackVersionId?: string;
  retrain?: { scheduleId: string; scheduleRevision: number; allowServingPause: boolean };
  window: MonitorWindow; reference?: MonitorWindow; candidate?: MonitorWindow;
  reports: MonitorReport[]; healthStreak: number; driftStreak: number; lastActionAt?: number; actions: MonitorAction[];
}
export const actionTerminal = (a: MonitorAction) => ["completed", "failed", "cancelled"].includes(a.state);
export const HISTOGRAM_BINS = 66;
export function monitorLimits(raw: unknown): MonitorLimits {
  const v = object(raw, ["windowSeconds", "minRequests", "minSamples", "consecutiveWindows", "maxErrorRate", "maxLatencyMs", "driftThreshold", "cooldownSeconds", "maxActions"], "monitor limits");
  for (const key of ["maxErrorRate", "driftThreshold"]) if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] <= 0 || v[key] > 1) throw new MlError(`${key} must be greater than zero and at most one`);
  return { windowSeconds: integer(v.windowSeconds, 60, 86400, "Monitoring window seconds"), minRequests: integer(v.minRequests, 10, 100000, "Minimum requests"), minSamples: integer(v.minSamples, 20, 100000, "Minimum drift samples"), consecutiveWindows: integer(v.consecutiveWindows, 2, 10, "Consecutive failing windows"), maxErrorRate: v.maxErrorRate, maxLatencyMs: integer(v.maxLatencyMs, 10, 180000, "Maximum mean latency ms"), driftThreshold: v.driftThreshold, cooldownSeconds: integer(v.cooldownSeconds, 60, 604800, "Action cooldown seconds"), maxActions: integer(v.maxActions, 1, 20, "Lifetime monitor actions") };
}
export function emptyWindow(start: number, seconds: number, features: string[]): MonitorWindow { return { start, end: start + seconds * 1000, requests: 0, failures: 0, latencyMs: 0, samples: 0, histograms: features.map(() => Array(HISTOGRAM_BINS).fill(0)) }; }
/** Jensen–Shannon distance, base 2, on normalized histogram counts (0 identical, 1 disjoint). */
export function histogramDistance(a: number[], b: number[]) {
  const an = a.reduce((s, n) => s + n, 0), bn = b.reduce((s, n) => s + n, 0);
  if (!an || !bn || a.length !== b.length) throw new MlError("Insufficient comparable histogram counts");
  let divergence = 0;
  for (let i = 0; i < a.length; i++) { const p = a[i]! / an, q = b[i]! / bn, m = (p + q) / 2; if (p) divergence += p * Math.log2(p / m) / 2; if (q) divergence += q * Math.log2(q / m) / 2; }
  return Math.sqrt(Math.max(0, Math.min(1, divergence)));
}
export function report(m: ModelMonitor, at: number): MonitorReport {
  const w = m.window, sufficient = w.requests >= m.limits.minRequests;
  const errorRate = w.requests ? w.failures / w.requests : 0, meanLatencyMs = w.requests ? w.latencyMs / w.requests : 0;
  const comparable = sufficient && w.samples >= m.limits.minSamples && !!m.reference;
  const distances = comparable ? w.histograms.map((h, i) => histogramDistance(h, m.reference!.histograms[i]!)) : [];
  return { at, start: w.start, end: w.end, requests: w.requests, samples: w.samples, errorRate, meanLatencyMs, ...(comparable ? { drift: Math.max(0, ...distances) } : {}), shifted: m.features.filter((_f, i) => (distances[i] ?? 0) >= m.limits.driftThreshold), health: sufficient && (errorRate >= m.limits.maxErrorRate || meanLatencyMs >= m.limits.maxLatencyMs), dataDrift: comparable && distances.some(d => d >= m.limits.driftThreshold), sufficient };
}
