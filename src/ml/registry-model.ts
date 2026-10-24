/** Browser-safe model registry contracts and comparison rules. */
import { isLlm, recipe, type Experiment } from "./model.js";
export interface ModelVersion {
  id: string; number: number; jobId: string; registeredAt: number;
  operationId: string; requestHash: string; receiptHash: string; notes: string;
}
export interface SelectionEvent {
  id: string; operationId: string; requestHash: string; revision: number;
  action: "promote" | "rollback"; from?: string; to: string; at: number; reason: string;
  reviewed: boolean; comparison: string[];
}
export interface RegisteredModel {
  id: string; project: string; repo: string; name: string; createdAt: number; revision: number;
  versions: ModelVersion[]; selectedVersionId?: string; history: SelectionEvent[];
}
export const evaluatedModel = (e: Experiment) => e.intent.kind === "training" && e.status.state === "succeeded" && !!e.status.artifact && !!e.status.evaluation && (e.status.evaluation.partition ?? "test") === "test" && (!e.intent.search || e.intent.search.partition === "test");
/** A named model keeps one input/output contract, even across computers and data versions. */
export function modelContract(e: Experiment): string {
  const spec = e.intent.spec!;
  return JSON.stringify(isLlm(spec) ? [recipe(e.intent.recipe), spec.task, e.intent.model?.hash] : [recipe(e.intent.recipe), spec.task, spec.label, e.intent.dataset!.columns.filter(c => c !== spec.label && c !== (spec.split.kind === "random" ? undefined : spec.split.column)).sort()]);
}
export function comparisonDifferences(a: Experiment, b: Experiment): string[] {
  const x = a.status.evaluation!, y = b.status.evaluation!;
  const differences: string[] = [];
  if (modelContract(a) !== modelContract(b)) differences.push("Model inputs or outputs differ");
  if (x.datasetHash !== y.datasetHash) differences.push("Dataset versions differ");
  if (x.splitHash !== y.splitHash || x.seed !== y.seed) differences.push("Evaluation splits differ");
  if (x.metric !== y.metric || x.direction !== y.direction) differences.push("Metrics differ");
  if (a.intent.bundle !== b.intent.bundle || x.recipe !== y.recipe) differences.push("Evaluator or recipe versions differ");
  if (x.baseModelHash !== y.baseModelHash) differences.push("Base models differ");
  if (x.evaluatedTokens !== y.evaluatedTokens || isLlm(a.intent.spec) && isLlm(b.intent.spec) && a.intent.spec.maxLength !== b.intent.spec.maxLength) differences.push("Evaluated tokens or sequence lengths differ");
  if (x.trainRows !== y.trainRows || x.tuningRows !== y.tuningRows || x.testRows !== y.testRows || x.droppedDuplicates !== y.droppedDuplicates) differences.push("Evaluation populations differ");
  if (Math.abs(x.baseline - y.baseline) > 0.000001) differences.push("Baseline scores differ");
  return differences;
}
export const improvement = (candidate: number, reference: number, direction: "higher" | "lower") => direction === "higher" ? candidate - reference : reference - candidate;
/** These are review requirements, not evidence that incomparable versions improved. */
export function promotionConcerns(candidate: Experiment, current: Experiment | undefined, margin = 0): string[] {
  const score = candidate.status.evaluation!, concerns: string[] = [];
  if (improvement(score.candidate, score.baseline, score.direction) <= margin) concerns.push("The candidate did not exceed its baseline by the required margin");
  if (current) {
    const differences = comparisonDifferences(candidate, current); concerns.push(...differences);
    if (!differences.length && improvement(score.candidate, current.status.evaluation!.candidate, score.direction) <= margin) concerns.push("The candidate did not improve the selected model by the required margin");
  }
  return concerns;
}
/** Rank only versions sharing the reference's evaluation; ties keep the earlier version. */
export function rankVersions(model: RegisteredModel, jobs: Experiment[], referenceId: string) {
  const reference = jobs.find(e => e.id === model.versions.find(v => v.id === referenceId)?.jobId);
  if (!reference) return [];
  return model.versions.map(v => ({ version: v, job: jobs.find(e => e.id === v.jobId)! })).filter(v => v.job && !comparisonDifferences(v.job, reference).length).sort((a, b) => {
    const x = a.job.status.evaluation!, y = b.job.status.evaluation!;
    return -improvement(x.candidate, y.candidate, x.direction) || a.version.number - b.version.number;
  });
}
