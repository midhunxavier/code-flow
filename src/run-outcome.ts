import type { RunSummary, Step } from "./engine.js";

/** Old run logs predate the structured rejection marker. */
export const planRejected = (run: Pick<RunSummary, "rejected" | "status" | "error">) => !!run.rejected || run.status === "cancelled" && /^You rejected (?:the|this) /i.test(run.error ?? "");
export function dispatchLabel(run: Pick<RunSummary, "status" | "pauseRequested" | "dispatchPending">, steps?: Step[]): string | undefined {
  if (run.status !== "running" || !run.pauseRequested) return;
  const pending = steps ? steps.some(step => step.status === "running" && !step.sideOf) : run.dispatchPending !== false;
  return pending ? "Pausing after active work" : "Dispatch paused";
}
export const PRIORITY_OPTIONS = [{ value: 10, label: "High" }, { value: 0, label: "Normal" }, { value: -10, label: "Low" }];
export const DISPATCH_LABELS = { pause: "Pause dispatch", resume: "Resume dispatch" };
export const failedWork = (steps: Step[]) => steps.filter(step => step.status === "failed" && !step.outcome);
