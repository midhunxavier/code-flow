import { groupChatTasks } from "./chat-family.js";
import { needsYou } from "./run-status.js";
import { reviewReason } from "./review-inbox.js";
import type { RunSummary } from "./engine.js";
import { encodeRunCursor } from "./run-history.js";
import { matchesHistoryFilter, runPassed, type ProjectSection } from "./run-status.js";

export interface HistoryPage { runs: RunSummary[]; total: number; nextCursor?: string; archivedMatches?: number }
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

export interface ProjectHistoryCounts {
  live: number; archived: number; waiting: number; archivedTasks: number; attentionTasks: number; inboxRuns: number;
  repositories: Record<string, number>;
}
/** Counts use the authorized complete index, never the client's loaded history pages. */
export function projectHistoryCounts(runs: readonly RunSummary[], scope: (run: RunSummary) => string | undefined, projects: readonly string[] = []): Record<string, ProjectHistoryCounts> {
  const empty = (): ProjectHistoryCounts => ({ live: 0, archived: 0, waiting: 0, archivedTasks: 0, attentionTasks: 0, inboxRuns: 0, repositories: Object.create(null) });
  const counts = new Map<string, ProjectHistoryCounts>(["", "none", ...projects].map(id => [id, empty()]));
  const get = (id: string) => { if (!counts.has(id)) counts.set(id, empty()); return counts.get(id)!; };
  for (const run of runs) {
    if (run.deleted) continue;
    for (const id of ["", scope(run) ?? "none"]) {
      const item = get(id);
      if (run.archived) item.archived++; else item.live++;
      if (needsYou(run)) item.waiting++;
      if (reviewReason(run)) item.inboxRuns++;
      item.repositories[run.repo] = (item.repositories[run.repo] ?? 0) + 1;
    }
  }
  for (const task of groupChatTasks(runs.filter(run => !run.deleted))) {
    for (const id of ["", scope(task.root) ?? "none"]) {
      const item = get(id);
      if (task.chats.length && task.chats.every(run => run.archived)) item.archivedTasks++;
      if (task.chats.some(needsYou)) item.attentionTasks++;
    }
  }
  return Object.fromEntries(counts);
}
