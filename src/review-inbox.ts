import type { RunSummary } from "./engine.js";

export type ReviewReason = "answer" | "blocked" | "failed" | "review";
export function reviewReason(run: RunSummary): ReviewReason | undefined {
  if (run.archived || run.projectTeam && !run.awaiting && !run.team?.awaitingRequestId) return;
  if (run.awaiting || run.team?.awaitingRequestId) return "answer";
  if (run.team?.status === "blocked") return "blocked";
  if (!run.seen && (run.status === "failed" || run.status === "interrupted")) return "failed";
  if (run.triage?.state === "pending") return "review";
}
export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = { answer: "Waiting for your answer", blocked: "Blocked work", failed: "Failed or interrupted", review: "Results to review" };
const reasonOrder: Record<ReviewReason, number> = { answer: 0, blocked: 1, failed: 2, review: 3 };
export function prioritizedReviewRuns(runs: RunSummary[], input: { query?: string; reason?: ReviewReason } = {}): RunSummary[] {
  const words = (input.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter((run) => {
    const reason = reviewReason(run);
    return reason && (!input.reason || reason === input.reason) && words.every((word) => [run.task, run.repo, run.id, run.trigger?.name ?? "", run.source?.title ?? ""].join("\n").toLowerCase().includes(word));
  }).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || reasonOrder[reviewReason(a)!] - reasonOrder[reviewReason(b)!] || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function groupReviewRuns(runs: RunSummary[], key: (run: RunSummary) => { id: string; label: string }) {
  const groups = new Map<string, { id: string; label: string; runs: RunSummary[] }>();
  for (const run of runs) {
    const group = key(run);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, runs: [] });
    groups.get(group.id)!.runs.push(run);
  }
  return [...groups.values()];
}
