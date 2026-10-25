/** Shared immutable common-holdout contracts. No training feedback is carried here. */
import { dataset, digest, id, integer, LLM_RECIPE, MlError, object, type Dataset } from "./model.js";
import { release, type ServingRelease } from "./deployment-model.js";
export interface HoldoutConfig { datasetId: string; maxEvaluations: number; seconds: number; memoryMiB: number; maxLength: number; allowServingPause: true }
export interface HoldoutInput { candidate: ServingRelease; incumbent: ServingRelease; memoryMiB: number; maxLength: number }
export interface HoldoutResult { version: 1; datasetHash: string; candidateHash: string; incumbentHash: string; evaluator: string; populationHash: string; rows: number; tokens?: number; metric: "accuracy" | "rmse" | "completion_nll"; direction: "higher" | "lower"; baseline: number; incumbent: number; candidate: number }
export interface HoldoutAttempt {
  id: string; jobId: string; candidateJobId: string; incumbentJobId: string; candidateReceipt: string; incumbentReceipt: string;
  at: number; expiresAt: number; deploymentRevision: number; releaseId: string; selectionId: string;
  state: "pending" | "running" | "restoring" | "completed" | "failed" | "cancelled";
  sessionId?: string; restoreAttempts?: number; outcome?: string; cancelled?: true;
}
export const holdoutActive = (a: HoldoutAttempt) => ["pending", "running", "restoring"].includes(a.state);
export function holdoutConfig(raw: unknown): HoldoutConfig {
  const v = object(raw, ["datasetId", "maxEvaluations", "seconds", "memoryMiB", "maxLength", "allowServingPause"], "common holdout policy");
  if (v.allowServingPause !== true) throw new MlError("Authorize a temporary serving pause for common holdout evaluation");
  return { datasetId: id(v.datasetId), maxEvaluations: integer(v.maxEvaluations, 1, 20, "Lifetime holdout evaluations"), seconds: integer(v.seconds, 60, 1800, "Holdout elapsed seconds"), memoryMiB: integer(v.memoryMiB, 256, 262144, "Holdout memory MiB"), maxLength: integer(v.maxLength, 32, 2048, "Holdout sequence length"), allowServingPause: true };
}
export function holdoutInput(raw: unknown): HoldoutInput {
  const v = object(raw, ["candidate", "incumbent", "memoryMiB", "maxLength"], "common holdout inputs");
  const a = release(v.candidate), b = release(v.incumbent);
  if (a.controllerId !== b.controllerId || a.workerId !== b.workerId || a.bundle !== b.bundle || a.recipe !== b.recipe || a.base?.hash !== b.base?.hash || JSON.stringify(a.features) !== JSON.stringify(b.features) || JSON.stringify(a.config) !== JSON.stringify(b.config)) throw new MlError("Common holdout models must share evaluation compute and input/output contracts");
  const maxLength = integer(v.maxLength, 32, 2048, "Holdout sequence length");
  if (a.config.mode !== "persistent" || a.config.memoryMiB !== v.memoryMiB) throw new MlError("Holdout loading and process memory limits must match");
  if (a.base && maxLength > a.base.contextLength) throw new MlError("Holdout sequence length exceeds model context");
  return { candidate: a, incumbent: b, memoryMiB: integer(v.memoryMiB, 256, 262144, "Holdout memory MiB"), maxLength };
}
export function holdoutResult(raw: unknown, input?: HoldoutInput, snapshot?: Dataset): HoldoutResult {
  const v = object(raw, ["version", "datasetHash", "candidateHash", "incumbentHash", "evaluator", "populationHash", "rows", "tokens", "metric", "direction", "baseline", "incumbent", "candidate"], "common holdout result");
  if (v.version !== 1 || !["accuracy", "rmse", "completion_nll"].includes(v.metric) || v.direction !== (v.metric === "accuracy" ? "higher" : "lower")) throw new MlError("Invalid holdout metric", 502);
  for (const key of ["datasetHash", "candidateHash", "incumbentHash", "evaluator", "populationHash"]) digest(v[key]);
  integer(v.rows, 30, 10000, "Holdout rows");
  if (v.metric === "completion_nll") integer(v.tokens, 1, 20480000, "Holdout tokens"); else if (v.tokens !== undefined) throw new MlError("Unexpected holdout tokens", 502);
  for (const key of ["baseline", "incumbent", "candidate"]) if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] < 0 || v.metric === "accuracy" && v[key] > 1) throw new MlError("Nonfinite or invalid holdout scores", 502);
  if (input && (v.candidateHash !== input.candidate.artifact.hash || v.incumbentHash !== input.incumbent.artifact.hash || v.evaluator !== input.candidate.bundle || (v.metric === "completion_nll") !== (input.candidate.recipe === LLM_RECIPE))) throw new MlError("Holdout model/evaluator identity changed", 502);
  if (snapshot && (v.datasetHash !== dataset(snapshot).hash || v.rows !== snapshot.rows)) throw new MlError("Holdout population changed", 502);
  return v as HoldoutResult;
}
