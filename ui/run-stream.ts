import type { RunSummary, Step } from "./types.js";

export interface StreamSnapshot { run: RunSummary; steps: Step[]; seq: number }

/** A reconnect snapshot is authoritative even if its sequence appeared before a crash. */
export function reconcileStreamSnapshot<T extends { steps: Map<string, Step>; seen: Set<number>; runSeq: number; stepSeq: Map<string, number> }>(data: T, snapshot: StreamSnapshot): T {
  return {
    ...data,
    steps: new Map(snapshot.steps.map((step) => [step.id, step])),
    stepSeq: new Map(snapshot.steps.map((step) => [step.id, snapshot.seq])),
    runSeq: snapshot.seq,
    // Events the browser saw but the server couldn't persist can be numbered again.
    seen: new Set([...data.seen].filter((seq) => seq <= snapshot.seq)),
  };
}
