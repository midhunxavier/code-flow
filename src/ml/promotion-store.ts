import { commonEvidence, validateHoldouts } from "./holdout-store.js";
import { canonical } from "../training-worker/files.js";
import { digest, id, integer, MlError, string } from "./model.js";
import { modelReceipt } from "./registry-store.js";
import { promotionEvidence, promotionHealth, promotionLimits, promotionPending } from "./promotion-model.js";
import type { MlState } from "./store.js";
export function validatePromotions(s: MlState) {
  const fail = (): never => { throw new MlError("Invalid promotion policy, evidence or deployment ledger", 503); };
  if (!Array.isArray(s.promotions) || s.promotions.length > 32 || new Set(s.promotions.map(p => p.id)).size !== s.promotions.length || new Set(s.promotions.map(p => p.operationId)).size !== s.promotions.length) fail();
  const decisions = new Set<string>();
  for (const p of s.promotions) {
    id(p.id); id(p.operationId); digest(p.requestHash); id(p.selectionId); string(p.name, "Promotion name", 100); integer(p.revision, 1, Number.MAX_SAFE_INTEGER, "Promotion revision"); integer(p.createdAt, 1, Number.MAX_SAFE_INTEGER, "Policy creation"); promotionLimits(p.limits, promotionHealth(p.health));
    const d = s.deployments.find(d => d.id === p.deploymentId), model = s.registry.find(m => m.id === p.modelId);
    if (!d || !model || d.modelId !== model.id || d.project !== p.project || d.repo !== p.repo || canonical(d.target) !== canonical(p.target) || !d.releases.some(r => r.id === p.releaseId) || !model.history.some(h => h.id === p.selectionId)) fail();
    integer(p.deploymentRevision, 1, d!.revision, "Policy deployment revision");
    if (!["enabled", "paused"].includes(p.state) || !["approval", "automatic"].includes(p.mode) || typeof p.includeExisting !== "boolean") fail();
    if (["registry", "searches"].includes(p.source.kind) ? Object.keys(p.source).length !== 1 : p.source.kind !== "schedule" || !s.schedules.some(x => x.id === (p.source as { id: string }).id && x.template.project === p.project && x.template.repo === p.repo)) fail();
    validateHoldouts(s, p);
    if (p.reason !== undefined) string(p.reason, "Policy reason", 2000);
    if (!Array.isArray(p.decisions) || p.decisions.length > 100 || new Set(p.decisions.map(a => a.jobId)).size !== p.decisions.length || p.decisions.filter(a => a.attemptedAt !== undefined).length > p.limits.maxAttempts || p.decisions.filter(promotionPending).length > 1) fail();
    for (const a of p.decisions) {
      for (const v of [a.id, a.jobId, a.incumbentJobId, a.incumbentVersionId, a.selectionId, a.registerOperation, a.selectOperation, a.rollbackOperation, a.rollbackSelection, a.monitorId]) id(v);
      digest(a.receiptHash); digest(a.incumbentReceipt); digest(a.releaseId);
      if (decisions.has(a.id)) fail(); decisions.add(a.id);
      integer(a.at, 1, Number.MAX_SAFE_INTEGER, "Decision time"); if (a.expiresAt !== a.at + p.limits.approvalSeconds * 1000) fail(); integer(a.deploymentRevision, 1, d!.revision, "Decision deployment revision");
      if (!["blocked", "awaiting_approval", "ready", "observing", "promoted", "rolled_back", "rejected", "cancelled", "failed"].includes(a.state)) fail();
      const candidate = s.experiments.find(e => e.id === a.jobId), incumbent = s.experiments.find(e => e.id === a.incumbentJobId), old = model!.versions.find(v => v.id === a.incumbentVersionId);
      if (!candidate || !incumbent || old?.jobId !== incumbent.id || candidate.project !== p.project || candidate.repo !== p.repo || modelReceipt(candidate) !== a.receiptHash || modelReceipt(incumbent) !== a.incumbentReceipt || !d!.releases.some(r => r.id === a.releaseId && r.versionId === a.incumbentVersionId) || !model!.history.some(h => h.id === a.selectionId && h.to === a.incumbentVersionId)) fail();
      if (p.source.kind === "registry" ? candidate!.registry?.modelId !== p.modelId : !s.cycles.some(c => (p.source.kind === "searches" || c.schedule?.id === (p.source as { id: string }).id) && c.finalJobId === candidate!.id && c.state === "completed")) fail();
      const margin = Math.max(p.limits.minImprovement, s.cycles.find(c => c.id === candidate!.intent.search?.cycleId)?.limits.minImprovement ?? 0), evidence = promotionEvidence(candidate!, incumbent!, margin, commonEvidence(s, p, a));
      if (canonical(evidence) !== canonical({ concerns: a.concerns, gain: a.gain, margin: a.margin, candidate: a.candidate, incumbent: a.incumbent, metric: a.metric, direction: a.direction }) || a.state === "blocked" && !a.concerns.length || a.concerns.length && a.state !== "blocked") fail();
      if (a.versionId && !model!.versions.some(v => v.id === a.versionId && v.jobId === candidate!.id)) fail();
      if (a.approval !== undefined) { if (!["owner", "policy"].includes(a.approval) || a.approval === "policy" && p.mode !== "automatic") fail(); integer(a.approvedAt, a.at, a.expiresAt - 1, "Approval time"); string(a.approvalReason, "Approval reason", 1000); }
      if (["ready", "observing", "promoted", "rolled_back"].includes(a.state) && !a.approval) fail();
      if (a.attemptedAt !== undefined) { integer(a.attemptedAt, a.at, a.expiresAt - 1, "Deployment attempt time"); if (!a.approval) fail(); }
      if (a.outcome !== undefined) string(a.outcome, "Promotion outcome", 2000);
      if (a.rollbackReason !== undefined) { string(a.rollbackReason, "Rollback reason", 1000); if (!a.rollbackRequested) fail(); }
      if (a.rollbackRequested !== undefined && a.rollbackRequested !== true) fail();
      if (a.rollbackAttempts !== undefined) integer(a.rollbackAttempts, 0, 3, "Rollback attempts");
      if (a.deployedRevision !== undefined) {
        if (!a.versionId || a.attemptedAt === undefined || a.deployedRevision !== a.deploymentRevision + 1 || a.observeUntil !== a.deployedAt! + p.limits.observationSeconds * 1000) fail();
        integer(a.deployedAt, a.attemptedAt!, Number.MAX_SAFE_INTEGER, "Deployment time");
        const event = d!.history[a.deployedRevision - 1], monitor = s.monitors.find(m => m.id === a.monitorId);
        if (event?.operationId !== a.id || event.action !== "switch" || !model!.history.some(h => h.operationId === a.selectOperation && h.to === a.versionId) || !monitor || monitor.deploymentId !== d!.id || monitor.deploymentRevision !== a.deployedRevision || monitor.rollbackVersionId !== a.incumbentVersionId || canonical(monitor.limits) !== canonical(p.health)) fail();
      } else if (["observing", "promoted", "rolled_back"].includes(a.state)) fail();
      if (a.state === "rolled_back" && !model!.history.some(h => h.operationId === a.rollbackSelection && h.to === a.incumbentVersionId && h.action === "rollback")) fail();
    }
    if (p.state === "enabled" && s.promotions.some(other => other.id !== p.id && other.modelId === p.modelId && other.state === "enabled")) fail();
  }
}
