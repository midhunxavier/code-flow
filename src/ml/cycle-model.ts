/** Browser-safe contracts for bounded, validation-driven experiment searches. */
import { integer, isLlm, llmSpec, MlError, object, string, trainingSpec, type Experiment, type JobSpec } from "./model.js";
export interface SearchLimits { iterations: number; trainSeconds: number; elapsedSeconds: number; patience: number; minImprovement: number }
export interface Planner { kind: "builtin" | "claude"; model?: string }
export interface Trial { number: number; state: "planning" | "running" | "done" | "rejected"; reason?: string; jobId?: string; spec?: JobSpec }
export interface Cycle {
  id: string; operationId: string; requestHash: string; name: string; objective: string;
  template: Experiment; planner: Planner; limits: SearchLimits; createdAt: number; expiresAt: number;
  state: "running" | "paused" | "stopping" | "completed" | "stopped"; reason?: string;
  schedule?: { id: string; occurrence: string };
  monitor?: { id: string; actionId: string; drift: number; requests: number; samples: number };
  trials: Trial[]; reservedTrainSeconds: number; bestJobId?: string; finalJobId?: string;
}
export const cycleTerminal = (c: Cycle) => c.state === "completed" || c.state === "stopped";
export function searchLimits(raw: unknown): SearchLimits {
  const v = object(raw, ["iterations", "trainSeconds", "elapsedSeconds", "patience", "minImprovement"], "search limits");
  if (typeof v.minImprovement !== "number" || !Number.isFinite(v.minImprovement) || v.minImprovement < 0 || v.minImprovement > 1000000) throw new MlError("Enter a finite, nonnegative minimum improvement");
  return { iterations: integer(v.iterations, 1, 8, "Iterations"), trainSeconds: integer(v.trainSeconds, 10, 28800, "Total training seconds"), elapsedSeconds: integer(v.elapsedSeconds, 60, 86400, "Total elapsed seconds"), patience: integer(v.patience, 1, 8, "Early-stop patience"), minImprovement: v.minImprovement };
}
export function plannerConfig(raw: unknown): Planner {
  const v = object(raw, ["kind", "model"], "planner");
  if (v.kind === "builtin" && v.model === undefined) return { kind: "builtin" };
  if (v.kind !== "claude") throw new MlError("Choose built-in search or Claude CLI");
  const model = string(v.model, "Claude model", 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) throw new MlError("Invalid Claude model");
  return { kind: "claude", model };
}
/** Agents can change only these hyperparameters. Compute, data and split never come from agent output. */
export function proposal(raw: unknown, base: JobSpec): { spec?: JobSpec; reason: string; stop: boolean } {
  const v = object(raw, ["stop", "reason", "parameters"], "planner proposal");
  if (typeof v.stop !== "boolean") throw new MlError("Planner must specify whether to stop");
  const reason = string(v.reason, "proposal rationale", 1000);
  if (v.stop) { if (v.parameters !== undefined) throw new MlError("Stop proposals cannot change parameters"); return { stop: true, reason }; }
  const p = object(v.parameters, isLlm(base) ? ["learningRate", "rank", "maxSteps", "accumulation"] : ["trees", "depth"], "proposal parameters");
  const spec = isLlm(base) ? llmSpec({ ...base, ...p }) : trainingSpec({ ...base, forest: p });
  if (isLlm(spec) && isLlm(base) && spec.maxSteps > base.maxSteps) throw new MlError("Planner exceeded the user's step limit");
  return { stop: false, reason, spec };
}
export function gain(candidate: number, reference: number, direction: "higher" | "lower") { return direction === "higher" ? candidate - reference : reference - candidate; }

/** Same stopping decision for dispatch and paused-search controls. */
export function cycleLimitReason(c: Cycle, now = Date.now()): string | undefined {
  const bestIndex = c.bestJobId ? c.trials.findIndex(t => t.jobId === c.bestJobId) : -1;
  const finalSeconds = Math.min(c.template.intent.recipe ? 1800 : 600, Math.ceil(c.limits.elapsedSeconds / 3));
  return c.trials.length >= c.limits.iterations ? "Iteration limit reached"
    : c.reservedTrainSeconds + c.template.intent.spec!.trainSeconds > c.limits.trainSeconds ? "Training budget exhausted"
    : c.trials.length - (bestIndex + 1) >= c.limits.patience ? "Early stopping: no sufficient validation improvement"
    : c.expiresAt - finalSeconds * 1000 < now + (c.template.intent.spec!.trainSeconds + 1) * 1000 ? "Time reserved for final evaluation" : undefined;
}
