import type { RunSummary } from "./engine.js";
import { needsYou } from "./run-status.js";
import { prioritizedReviewRuns } from "./review-inbox.js";

/** Initial bounded feed: all running work plus distinct older attention, with review work first.
 * This is not a chronological page; history/attention pagination keeps its own stable cursor.
 */
export function attentionSnapshot(candidates: readonly RunSummary[], visible: ReadonlySet<string>, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Attention snapshot size must be between 1 and 100");
  const running = candidates.filter(run => run.status === "running");
  const attention = candidates.filter(run => run.status !== "running" && needsYou(run));
  const older = attention.filter(run => !visible.has(run.id));
  const review = prioritizedReviewRuns(older), reviewIds = new Set(review.map(run => run.id));
  const selected = [...review, ...older.filter(run => !reviewIds.has(run.id))].slice(0, limit);
  return { runs: structuredClone([...running, ...selected]), total: running.length + attention.length, running: running.length, truncated: older.length > selected.length };
}
