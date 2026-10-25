import type { HoldoutAttempt, HoldoutConfig, HoldoutResult } from "./holdout-model.js";
/** Browser-safe policy and audit contracts. Agents cannot relax these quality or approval gates. */
import { integer, MlError, object, type Experiment, type Target } from "./model.js";
import { evaluatedModel, improvement, modelContract, promotionConcerns } from "./registry-model.js";
import { monitorLimits, type MonitorLimits } from "./monitor-model.js";
export interface PromotionLimits {
  minImprovement: number; maxAttempts: number; cooldownSeconds: number; approvalSeconds: number; observationSeconds: number;
}
export interface PromotionDecision {
  id: string; jobId: string; receiptHash: string; incumbentJobId: string; incumbentReceipt: string; incumbentVersionId: string;
  holdoutJobId?: string; versionId?: string; at: number; expiresAt: number; deploymentRevision: number; releaseId: string; selectionId: string;
  state: "blocked" | "awaiting_approval" | "ready" | "observing" | "promoted" | "rolled_back" | "rejected" | "cancelled" | "failed";
  concerns: string[]; gain: number; margin: number; candidate: number; incumbent: number; metric: string; direction: "higher" | "lower";
  registerOperation: string; selectOperation: string; rollbackOperation: string; rollbackSelection: string; monitorId: string;
  approvedAt?: number; approval?: "owner" | "policy"; approvalReason?: string; attemptedAt?: number;
  deployedRevision?: number; deployedAt?: number; observeUntil?: number; rollbackRequested?: boolean; rollbackReason?: string; rollbackAttempts?: number; outcome?: string;
}
export interface PromotionPolicy {
  id: string; operationId: string; requestHash: string; revision: number; name: string; project: string; repo: string; createdAt: number;
  deploymentId: string; modelId: string; target: Target; deploymentRevision: number; releaseId: string; selectionId: string;
  source: { kind: "registry" | "searches" } | { kind: "schedule"; id: string }; includeExisting: boolean;
  mode: "approval" | "automatic"; state: "enabled" | "paused"; reason?: string;
  holdout?: HoldoutConfig; evaluations?: HoldoutAttempt[]; limits: PromotionLimits; health: MonitorLimits; decisions: PromotionDecision[];
}
export const promotionPending = (a: PromotionDecision) => ["awaiting_approval", "ready", "observing"].includes(a.state);
export function promotionLimits(raw: unknown, health: MonitorLimits): PromotionLimits {
  const v = object(raw, ["minImprovement", "maxAttempts", "cooldownSeconds", "approvalSeconds", "observationSeconds"], "promotion limits");
  if (typeof v.minImprovement !== "number" || !Number.isFinite(v.minImprovement) || v.minImprovement < 0 || v.minImprovement > 1000000) throw new MlError("Enter a finite nonnegative improvement margin");
  return { minImprovement: v.minImprovement, maxAttempts: integer(v.maxAttempts, 1, 20, "Lifetime deployment attempts"), cooldownSeconds: integer(v.cooldownSeconds, 60, 604800, "Promotion cooldown seconds"), approvalSeconds: integer(v.approvalSeconds, 60, 604800, "Approval expiry seconds"), observationSeconds: integer(v.observationSeconds, health.windowSeconds * health.consecutiveWindows, 86400, "Health observation seconds") };
}
export function promotionHealth(raw: unknown) {
  const h = monitorLimits(raw);
  if (h.maxActions !== 1) throw new MlError("A promotion health guard permits exactly one automatic rollback");
  return h;
}
export function promotionEvidence(candidate: Experiment, incumbent: Experiment, margin: number, common?: HoldoutResult) {
  if (!evaluatedModel(candidate) || !evaluatedModel(incumbent)) throw new MlError("Promotion requires successful final held-out evaluations and exports", 409);
  if (common) {
    const concerns = modelContract(candidate) === modelContract(incumbent) ? [] : ["Model inputs or outputs differ"];
    if (improvement(common.candidate, common.baseline, common.direction) <= margin) concerns.push("The candidate did not exceed the common holdout baseline by the required margin");
    if (improvement(common.candidate, common.incumbent, common.direction) <= margin) concerns.push("The candidate did not improve the incumbent on the common holdout by the required margin");
    return { concerns, gain: improvement(common.candidate, common.incumbent, common.direction), margin, candidate: common.candidate, incumbent: common.incumbent, metric: common.metric, direction: common.direction };
  }
  const a = candidate.status.evaluation!, b = incumbent.status.evaluation!;
  return { concerns: promotionConcerns(candidate, incumbent, margin), gain: improvement(a.candidate, b.candidate, a.direction), margin, candidate: a.candidate, incumbent: b.candidate, metric: a.metric, direction: a.direction };
}
