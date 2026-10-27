import { signal } from "@preact/signals";
import type { ContextItem, RunSummary } from "./types.js";
import type { SourcePick } from "./state.js";
import type { SourceInput } from "../src/github.js";

/**
 * Settings carried into an editable retry, scoped to this draft and repository. `baseRef` is the
 * commit the retry is pinned to and `task` the original task: both belong to the retry alone.
 */
export const rerunDraft = signal<(Pick<RunSummary, "id" | "repo" | "loop" | "approvals" | "source" | "checkpointOnFinish"> & Partial<Pick<RunSummary, "baseRef" | "task">> & { contextPaths?: ContextItem[] }) | null>(null);

/** Inherit unchanged source context; send explicitly edited options for a fresh source read. */
export function sourceForRerun(pick: SourcePick | null, original?: RunSummary["source"]): SourceInput | undefined {
  if (!pick) return undefined;
  const sameAlerts = pick.kind !== "alert" || (
    (pick.tool ?? "code-scanning") === (original?.alert?.tool ?? "code-scanning") &&
    JSON.stringify(pick.numbers?.length ? pick.numbers : [pick.number]) === JSON.stringify(original?.alert?.numbers?.length ? original.alert.numbers : [original?.number])
  );
  if (original?.kind === pick.kind && original.number === pick.number && !!original.ci === !!pick.ciLogs && sameAlerts) return undefined;
  return { kind: pick.kind, number: pick.number, ciLogs: !!pick.ciLogs, tool: pick.tool, numbers: pick.numbers };
}
