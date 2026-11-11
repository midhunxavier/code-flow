import { isDeepStrictEqual } from "node:util";
import type { Run } from "./engine.js";

/**
 * Earlier versions could send agent turns to an SSH worker and recorded that choice as `loop.remoteWorker`.
 * Such a run, automation or queued start never moves onto this computer instead: it is refused.
 */
export function assertNoRemoteWorker(loop: unknown): void {
  if (loop && typeof loop === "object" && (loop as { remoteWorker?: unknown }).remoteWorker != null) throw new Error("This run was set up for an SSH worker, which is no longer supported. Start a new run on this computer or in an SSH project.");
}

/** A child may add isolation, but cannot silently move execution out of its parent's boundary. */
export function inheritRunEnvironment<T extends Record<string, any>>(requested: T, parent?: Pick<Run, "permissions" | "loop">): T {
  assertNoRemoteWorker(requested); assertNoRemoteWorker(parent?.loop);
  const result = { ...requested };
  if (!parent?.permissions) return result;
  for (const key of ["agentContainer", "container"] as const) {
    const inherited = parent.loop[key];
    if (inherited === undefined) continue;
    if (requested[key] !== undefined && !isDeepStrictEqual(requested[key], inherited)) throw new Error(`Child runs must preserve the parent's ${key} execution boundary. Start an independent run to choose another environment.`);
    (result as Record<string, any>)[key] = structuredClone(inherited);
  }
  return result;
}
