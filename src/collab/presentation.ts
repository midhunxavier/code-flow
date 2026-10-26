import type { Task, Review } from "./model.js";

/** Every bound the board enforces, in one place so the store, the API and the UI agree. Sizes written in KiB count bytes; everything else counts characters or items. */
export const MAX = {
  tasks: 500, attempts: 50, checkpoints: 50, decisions: 100, discussion: 500, instructions: 50, reviews: 100, handoffs: 50, audit: 200, collaborators: 20, dependsOn: 20, labels: 10, repositories: 50,
  title: 200, goal: 16 * 1024, acceptance: 8 * 1024, text: 4000, note: 4000, decision: 2000, blocker: 1000, reason: 1000, summary: 4 * 1024, requirements: 16 * 1024, remaining: 8 * 1024,
  changedFiles: 100, path: 300, blockers: 10, blockerItem: 500, stage: 200, command: 200, runStatus: 40, steps: 100_000, label: 40, repoLabel: 80, repoRemote: 300, branch: 100, baseRef: 100, runnerName: 80, displayName: 120, inboxText: 500, auditAction: 60, auditDetail: 500,
  bundle: 64 * 1024 * 1024, runners: 64, runnersPerUser: 8, inboxPerUser: 500, inboxTotal: 5000, bundlesOnDisk: 200, heartbeatLiveMs: 90_000,
} as const;

/** Legacy self-reviews remain visible but do not establish independent approval. */
export function selfReview(task: Pick<Task, "checkpoints"> & Partial<Pick<Task, "owner">>, review: Pick<Review, "by" | "checkpointId">): boolean {
  return review.by.userId === task.owner?.userId || review.by.userId === task.checkpoints.find(checkpoint => checkpoint.id === review.checkpointId)?.createdBy?.userId;
}

export const historyLimitMessage = (max: number, label: string) => label === "tasks"
  ? `At most ${max} tasks can be kept here; delete finished tasks before adding more`
  : `At most ${max} ${label} can be kept on this task. These records are permanent; start a follow-up task to continue.`;
