import type { DeferredRunJob } from "../src/deferred-runs.js";
import { ApiError, api } from "./lib.js";

/**
 * A 503 means the server could not read deferred-runs.json at startup, which lasts until the file is
 * repaired and code-flow restarts. Background polls then stop asking instead of repeating the same
 * failure every few seconds; an explicit read (opening the panel, Refresh queue) still asks, and a
 * successful one lets the polls resume.
 */
let unavailable: ApiError | undefined;

export async function readDeferredRuns({ signal, background = false }: { signal?: AbortSignal; background?: boolean } = {}): Promise<DeferredRunJob[]> {
  if (background && unavailable) throw unavailable;
  try {
    const jobs = await api<DeferredRunJob[]>("/api/deferred-runs", signal ? { signal } : undefined);
    unavailable = undefined;
    return jobs;
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) unavailable = error;
    throw error;
  }
}
