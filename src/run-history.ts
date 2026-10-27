export interface RunCursor { at: number; id: string }

export function encodeRunCursor(run: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify({ at: run.createdAt, id: run.id })).toString("base64url");
}

export function decodeRunCursor(value: string): RunCursor {
  if (!value || value.length > 1000 || !/^[\w-]+$/.test(value)) throw new Error("Invalid history cursor");
  let cursor: RunCursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid history cursor"); }
  if (!cursor || !Number.isSafeInteger(cursor.at) || cursor.at < 0 || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 256) throw new Error("Invalid history cursor");
  return cursor;
}

/** A total order avoids skipping runs created in the same millisecond. */
export function compareRuns(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

export function afterRunCursor(run: { createdAt: number; id: string }, cursor: RunCursor): boolean {
  return compareRuns(run, { createdAt: cursor.at, id: cursor.id }) > 0;
}

import type { RunSummary } from "./engine.js";

export function runSearchText(run: RunSummary): string {
  return [run.task, run.id, run.repo, run.pattern, run.branchPrefix, run.source ? `#${run.source.number} ${run.source.title}` : "", run.externalSource?.title ?? "", run.trigger?.name ?? "", run.group?.label ?? ""].join("\n").toLowerCase();
}

/** Read projection only. Execution and evidence still hydrate the authoritative run. */
export class RunIndex {
  private records = new Map<string, { summary: RunSummary; search: string }>();
  private ordered?: RunSummary[];
  private positions = new Map<string, number>();
  private repositories = new Map<string, Set<string>>();
  revision = 0;
  set(summary: RunSummary, search = runSearchText(summary)) {
    const previous = this.records.get(summary.id)?.summary;
    if (previous) this.removePaths(previous);
    this.records.set(summary.id, { summary, search });
    for (const path of new Set([summary.repo, ...summary.worktrees.map((tree) => tree.path)])) {
      let ids = this.repositories.get(path); if (!ids) this.repositories.set(path, ids = new Set()); ids.add(summary.id);
    }
    const position = this.positions.get(summary.id);
    if (this.ordered && previous?.createdAt === summary.createdAt && position !== undefined) this.ordered[position] = summary;
    else this.ordered = undefined;
    this.revision++;
  }
  delete(id: string) {
    const previous = this.records.get(id)?.summary; if (!previous) return;
    this.removePaths(previous); this.records.delete(id); this.ordered = undefined; this.revision++;
  }
  private removePaths(run: RunSummary) {
    for (const path of [run.repo, ...run.worktrees.map((tree) => tree.path)]) { const ids = this.repositories.get(path); ids?.delete(run.id); if (!ids?.size) this.repositories.delete(path); }
  }
  values(): readonly RunSummary[] {
    if (!this.ordered) {
      this.ordered = [...this.records.values()].map((entry) => entry.summary).sort(compareRuns);
      this.positions = new Map(this.ordered.map((run, index) => [run.id, index]));
    }
    return this.ordered;
  }
  get(id: string): RunSummary | undefined { return this.records.get(id)?.summary; }
  related(repo: string): RunSummary[] { return [...this.repositories.get(repo) ?? []].map((id) => this.records.get(id)!.summary); }
  matches(id: string, words: string[]): boolean { const text = this.records.get(id)?.search ?? ""; return words.every((word) => text.includes(word)); }
}

/** Find the page boundary in an already ordered projection without cloning or scanning it. */
export function historyOffset(runs: readonly { createdAt: number; id: string }[], cursor?: RunCursor, before?: number): number {
  let low = 0, high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), run = runs[middle]!;
    if ((!cursor || afterRunCursor(run, cursor)) && (before === undefined || run.createdAt < before)) high = middle;
    else low = middle + 1;
  }
  return low;
}
