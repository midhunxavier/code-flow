import { join } from "node:path";
import { worktreeRoot } from "./git.js";
import type { LoopSettings, Run, RunEvent, RunSummary, Step } from "./engine.js";

export const DEFAULT_LOOP: LoopSettings = { maxMinutes: 60, maxSteps: 40, checkTimeoutMin: 10 };

/** Incremental recovery retains only the latest run and each step, never provider transcripts. */
export class RunProjection {
  private snapshot?: RunSummary;
  private steps = new Map<string, Step>();
  seq = 0;
  records = 0;
  apply(event: RunEvent) {
    this.records++;
    if (Number.isSafeInteger(event.seq) && event.seq > this.seq) this.seq = event.seq;
    if (event.type === "run" && event.run) this.snapshot = event.run;
    else if (event.type === "step" && event.step) this.steps.set(event.step.id, { ...event.step, kind: event.step.kind ?? "agent" });
  }
  finish(): Run | undefined { return rebuildSnapshot(this.snapshot, this.steps); }
}

export function rebuildRun(events: Iterable<RunEvent>): Run | undefined {
  const projection = new RunProjection(); for (const event of events) projection.apply(event); return projection.finish();
}
function rebuildSnapshot(snapshot: RunSummary | undefined, steps: Map<string, Step>): Run | undefined {
  if (!snapshot) return undefined;
  // Logs written before newer fields existed get sensible defaults.
  const legacy = snapshot as Partial<Run> & RunSummary;
  return {
    ...legacy,
    context: legacy.context ?? { paths: [], attachments: [] },
    agentSettings: legacy.agentSettings ?? {},
    loop: { ...DEFAULT_LOOP, ...(legacy.loop ?? {}) },
    usage: legacy.usage ?? { agentSteps: 0, checks: 0 },
    // Runs saved before patternDone existed: a finished run's pattern finished.
    patternDone: legacy.patternDone ?? (legacy.status === "done" ? true : undefined),
    patternSummary: legacy.patternSummary ?? (legacy.status === "done" && legacy.summary ? withoutFollowUps(legacy.summary) : undefined),
    worktrees: legacy.worktrees ?? [],
    baseLabel: legacy.baseLabel ?? "HEAD",
    branchPrefix: legacy.branchPrefix ?? `codeflow/${legacy.id}`,
    worktreeDir: legacy.worktreeDir ?? join(worktreeRoot(legacy.repo), legacy.id),
    followUps: legacy.followUps ?? [],
    notes: legacy.notes ?? [],
    roleSettings: legacy.roleSettings ?? {},
    trust: legacy.trust ?? "standard",
    approvals: legacy.approvals ?? {},
    merges: legacy.merges ?? [],
    prs: legacy.prs ?? {},
    watches: legacy.watches ?? {},
    seen: legacy.seen ?? true,
    archived: legacy.archived ?? false,
    artifacts: legacy.artifacts ?? [],
    steps: [...steps.values()],
  };
}

/** A copy prevents a persisted snapshot from changing with the live object. */
export function strip(run: Run): RunSummary { const { steps: _steps, ...rest } = run; return structuredClone(rest); }
export function withoutFollowUps(summary: string): string { return summary.split("\n\n## Follow-ups\n")[0]!; }
