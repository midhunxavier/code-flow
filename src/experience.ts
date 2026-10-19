import type { RunSummary, Step } from "./engine.js";
import { confidenceInterval } from "./stats.js";

export type TaskIntent = "bug" | "feature" | "review" | "explore";
export function taskIntent(value: unknown): TaskIntent | undefined {
  return typeof value === "string" && ["bug", "feature", "review", "explore"].includes(value) ? value as TaskIntent : undefined;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : undefined;
};
export function outcomeMetrics(runs: RunSummary[]) {
  const ended = runs.filter(run => run.status !== "running");
  const verified = ended.filter(run => run.status === "done" && run.verdict === "passed" && (!run.verification || run.verification.state === "verified"));
  const rated = ended.filter(run => run.outcome);
  const reworked = ended.filter(run => run.humanRework?.length);
  return {
    completed: ended.length, verified: verified.length,
    rated: rated.length, accepted: rated.filter(run => run.outcome?.decision === "accepted").length,
    shipped: ended.filter(run => run.merges.length).length,
    medianVerifiedMs: median(verified.flatMap(run => run.endedAt ? [Math.max(0, run.endedAt - run.createdAt)] : [])),
    reworkSamples: reworked.length,
    medianReworkMinutes: median(reworked.map(run => run.humanRework!.reduce((sum, item) => sum + item.minutes, 0))),
  };
}
/** Explicit intent only: legacy tasks aren't guessed from their prose. Failures stay in the denominator. */
export function workflowRecommendations(runs: RunSummary[], repo: string, intent?: TaskIntent) {
  const comparable = runs.filter(run => run.repo === repo && run.status !== "running" && (!intent || run.intent === intent));
  const groups = new Map<string, RunSummary[]>();
  for (const run of comparable) groups.set(run.pattern, [...(groups.get(run.pattern) ?? []), run]);
  return [...groups].map(([pattern, samples]) => {
    const metrics = outcomeMetrics(samples);
    return { pattern, ...metrics, confidence: confidenceInterval(metrics.verified, samples.length), runIds: samples.slice(-10).map(run => run.id) };
  }).sort((a, b) => b.confidence.low - a.confidence.low || b.completed - a.completed || a.pattern.localeCompare(b.pattern));
}
export function progressSummary(run: RunSummary, steps: Step[]) {
  const questions = run.team?.messages.filter(message => message.kind === "question" && message.recipient === "user" && message.status === "open") ?? [];
  if (run.awaiting) return { title: "Your plan decision is needed", detail: run.awaiting.title };
  if (questions.length) return { title: `${questions.length} question${questions.length === 1 ? "" : "s"} need your answer`, detail: questions[0]!.body };
  if (run.pauseRequested) return { title: "Pausing at a safe checkpoint", detail: "Current work is retained. Resume dispatch when you're ready." };
  const active = steps.filter(step => step.status === "running" && !step.sideOf);
  if (active.length) return { title: active.every(step => step.kind === "check") ? "Checking the result" : "Work in progress", detail: active.map(step => step.title).join(" · ") };
  if (run.status === "running") return { title: "Preparing the next step", detail: "Waiting for a provider slot, a dependency, or the next workflow action." };
  return { title: run.verdict === "passed" ? "Checks passed" : "Work has stopped", detail: run.error ?? run.stopReason ?? "Review the result and its recorded evidence." };
}
