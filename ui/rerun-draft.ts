import { signal } from "@preact/signals";
import type { RunSummary } from "./types.js";

/** Settings carried into an editable retry, scoped to this draft and repository. */
export const rerunDraft = signal<Pick<RunSummary, "id" | "repo" | "loop" | "approvals" | "source"> | null>(null);
