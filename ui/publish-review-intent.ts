import { signal } from "@preact/signals";

/** One visit only; never persisted or sufficient authority to push a branch. */
export const publishReviewIntent = signal<{ runId: string; branch: string } | null>(null);
