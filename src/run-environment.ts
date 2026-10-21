import { isDeepStrictEqual } from "node:util";
import type { Run } from "./engine.js";

/** A child may add isolation, but cannot silently move execution out of its parent's boundary. */
export function inheritRunEnvironment<T extends Record<string, any>>(requested: T, parent?: Pick<Run, "permissions" | "loop">): T {
  const result = { ...requested };
  if (!parent?.permissions) return result;
  for (const key of ["agentContainer", "remoteWorker", "container"] as const) {
    const inherited = parent.loop[key];
    if (inherited === undefined) continue;
    if (requested[key] !== undefined && !isDeepStrictEqual(requested[key], inherited)) throw new Error(`Child runs must preserve the parent's ${key} execution boundary. Start an independent run to choose another environment.`);
    (result as Record<string, any>)[key] = structuredClone(inherited);
  }
  return result;
}
