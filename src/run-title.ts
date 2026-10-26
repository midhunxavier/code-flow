import type { RunSummary } from "./engine.js";

/** Human-facing labels only: external source titles never become agent task instructions. */
export function runTitle(run: Pick<RunSummary, "id" | "task" | "source">): string {
  const source = run.source;
  if (source?.title?.trim()) {
    if (source.kind === "issue") return `Fix #${source.number}: ${source.title.trim()}`;
    if (source.kind === "alert") return source.title.trim();
    return `${run.task.startsWith("Make CI pass") ? "Fix CI" : "PR"} #${source.number}: ${source.title.trim()}`;
  }
  return run.task.split("\n").find(line => line.trim())?.trim() || `code-flow run ${run.id}`;
}

export function pullRequestTitle(run: Pick<RunSummary, "id" | "task" | "source">): string {
  const title = runTitle(run).replace(/\s+/g, " ").trim();
  if (title.length <= 100) return title;
  const cut = title.slice(0, 99), space = cut.lastIndexOf(" ");
  return `${space > 50 ? cut.slice(0, space) : cut}…`;
}
