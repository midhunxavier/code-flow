import { canonical, hash } from "../training-worker/files.js";
import { digest, id, integer, MlError, string } from "./model.js";
import { holdoutActive, holdoutConfig, holdoutResult } from "./holdout-model.js";
import { releaseInputs } from "./deployment-model.js";
import { evaluatedModel, modelContract } from "./registry-model.js";
import { modelReceipt } from "./registry-store.js";
import type { PromotionDecision, PromotionPolicy } from "./promotion-model.js";
import type { MlState } from "./store.js";
export function commonEvidence(s: MlState, p: PromotionPolicy, a: PromotionDecision) {
  if (!p.holdout) { if (a.holdoutJobId) throw new MlError("Unexpected common holdout evidence", 503); return undefined; }
  const attempt = p.evaluations?.find(e => e.jobId === a.holdoutJobId && e.candidateJobId === a.jobId && e.incumbentJobId === a.incumbentJobId && e.state === "completed"), job = s.experiments.find(e => e.id === attempt?.jobId);
  if (!attempt || !job || job.status.state !== "succeeded" || a.deploymentRevision !== attempt.deploymentRevision || a.selectionId !== attempt.selectionId || a.receiptHash !== attempt.candidateReceipt || a.incumbentReceipt !== attempt.incumbentReceipt) throw new MlError("Common holdout approval binding changed", 503);
  return holdoutResult(job.status.holdout, job.intent.holdout, job.intent.dataset);
}
export function validateHoldouts(s: MlState, p: PromotionPolicy) {
  const fail = (): never => { throw new MlError("Invalid common holdout policy or evaluation ledger", 503); };
  if (!p.holdout) { if (p.evaluations !== undefined) fail(); return; }
  holdoutConfig(p.holdout);
  const snapshot = s.datasets.find(d => d.id === p.holdout!.datasetId), d = s.deployments.find(d => d.id === p.deploymentId)!, model = s.registry.find(m => m.id === p.modelId)!;
  if (!snapshot || snapshot.purpose !== "holdout" || snapshot.project !== p.project || snapshot.repo !== p.repo || snapshot.target.workerId !== p.target.workerId || snapshot.target.bundle !== p.target.bundle || snapshot.dataset.rows > 10000 || snapshot.dataset.duplicateRows) fail();
  if (d.config.memoryMiB && p.holdout.memoryMiB > d.config.memoryMiB || (snapshot!.dataset.format === "jsonl") !== !!d.releases[0]!.base) fail();
  if (!Array.isArray(p.evaluations) || p.evaluations.length > p.holdout.maxEvaluations || p.evaluations.filter(holdoutActive).length > 1 || new Set(p.evaluations.map(e => e.id)).size !== p.evaluations.length || new Set(p.evaluations.map(e => e.candidateJobId)).size !== p.evaluations.length) fail();
  for (const a of p.evaluations!) {
    for (const v of [a.id, a.jobId, a.candidateJobId, a.incumbentJobId, a.selectionId]) id(v);
    digest(a.candidateReceipt); digest(a.incumbentReceipt); digest(a.releaseId);
    integer(a.at, p.createdAt, Number.MAX_SAFE_INTEGER, "Holdout admission time"); integer(a.deploymentRevision, 1, d.revision, "Holdout deployment revision");
    if (a.expiresAt !== a.at + p.holdout.seconds * 1000 || !["pending", "running", "restoring", "completed", "failed", "cancelled"].includes(a.state)) fail();
    if (a.sessionId) id(a.sessionId); if (a.restoreAttempts !== undefined) integer(a.restoreAttempts, 0, 3, "Holdout serving restore attempts"); if (a.outcome !== undefined) string(a.outcome, "Holdout outcome", 2000); if (a.cancelled !== undefined && a.cancelled !== true) fail();
    const candidate = s.experiments.find(e => e.id === a.candidateJobId), incumbent = s.experiments.find(e => e.id === a.incumbentJobId), job = s.experiments.find(e => e.id === a.jobId);
    if (!candidate || !incumbent || !evaluatedModel(candidate) || !evaluatedModel(incumbent) || modelContract(candidate) !== modelContract(incumbent) || candidate.project !== p.project || candidate.repo !== p.repo || modelReceipt(candidate) !== a.candidateReceipt || modelReceipt(incumbent) !== a.incumbentReceipt || !model.history.some(h => h.id === a.selectionId && model.versions.some(v => v.id === h.to && v.jobId === incumbent.id)) || !d.releases.some(r => r.id === a.releaseId && r.artifact.hash === incumbent.status.artifact!.hash)) fail();
    if (candidate!.id === incumbent!.id || (p.source.kind === "registry" ? candidate!.registry?.modelId !== p.modelId : !s.cycles.some(c => (p.source.kind === "searches" || c.schedule?.id === (p.source as { id: string }).id) && c.finalJobId === candidate!.id && c.state === "completed"))) fail();
    if (["running", "completed"].includes(a.state) && !job || a.state === "completed" && (job!.status.state !== "succeeded" || a.cancelled)) fail();
    if (job) {
      const expectedConfig = { ...d.config, mode: "persistent", memoryMiB: p.holdout.memoryMiB, idleSeconds: 60, lifetimeSeconds: 1800 }, input = job.intent.holdout;
      if (job.intent.kind !== "holdout" || !input || job.operationId !== a.id || job.project !== p.project || job.repo !== p.repo || canonical(job.target) !== canonical(p.target) || job.intent.createdAt !== a.at || job.intent.deadline !== a.expiresAt || job.requestHash !== hash(canonical(job.intent)) || canonical(job.intent.dataset) !== canonical(snapshot!.dataset) || input.memoryMiB !== p.holdout.memoryMiB || input.maxLength !== p.holdout.maxLength) fail();
      for (const [r, original] of [[input!.candidate, candidate!], [input!.incumbent, incumbent!]] as const) {
        const { id: releaseId, controllerId, workerId, bundle, versionId, config, ...inputs } = r;
        if (canonical(inputs) !== canonical(releaseInputs(original)) || controllerId !== s.controllerId || workerId !== p.target.workerId || bundle !== p.target.bundle || canonical(config) !== canonical(expectedConfig) || ![original.id, original.registry?.versionId].includes(versionId) || releaseId !== hash(canonical({ controllerId, workerId, bundle, versionId, ...inputs, config }))) fail();
      }
      if (job.status.holdout) { const result = holdoutResult(job.status.holdout, input, snapshot!.dataset); if (job.status.state !== "succeeded" || result.metric !== candidate!.status.evaluation!.metric || result.metric !== incumbent!.status.evaluation!.metric) fail(); }
      if (job.status.state === "succeeded" && !job.status.holdout) fail();
    }
  }
}
