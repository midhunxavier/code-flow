import { reviewReason } from "./review-inbox.js";
import type { RunSummary } from "./engine.js";
import { encodeRunCursor } from "./run-history.js";
import { matchesHistoryFilter, runPassed, type ProjectSection } from "./run-status.js";

export interface HistoryPage { runs: RunSummary[]; total: number; nextCursor?: string }
export interface ProjectReport {
  live: number;
  archived: number;
  pending: number;
  week: { runs: number; passed: number; costUsd: number };
  sections: Record<ProjectSection, HistoryPage>;
}

/** Input is the authorized, ordered index; only the displayed pages are cloned. */
export function projectReport(runs: readonly RunSummary[], now = Date.now()): ProjectReport {
  const week = runs.filter(run => run.createdAt > now - 7 * 86_400_000);
  const archived = runs.filter(run => run.archived).length;
  const section = (name: ProjectSection, limit: number): HistoryPage => {
    const matches = runs.filter(run => matchesHistoryFilter(run, { section: name }));
    const selected = matches.slice(0, limit);
    return { runs: structuredClone(selected), total: matches.length, nextCursor: matches.length > limit ? encodeRunCursor(selected.at(-1)!) : undefined };
  };
  return {
    live: runs.length - archived, archived,
    pending: runs.filter(run => reviewReason(run) !== undefined).length,
    week: { runs: week.length, passed: week.filter(runPassed).length, costUsd: week.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0) },
    sections: { waiting: section("waiting", 100), running: section("running", 100), results: section("results", 8) },
  };
}
