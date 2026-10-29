import type { Run } from "./engine.js";

/** Public worker deliverables, kept separate from private checkpoints and host verification. */
export function taskResponseEvidence(run: Pick<Run, "team" | "steps">) {
  return (run.team?.tasks ?? []).map(task => {
    const saved = [...run.steps].reverse().flatMap(step => {
      if (step.status !== "done" || !step.finalText) return [];
      try {
        const result = JSON.parse(step.finalText);
        if (result?.taskId !== task.id || result.status !== "submitted") return [];
        return [{ stepId: step.id, findings: Array.isArray(result.findings) ? result.findings.filter((finding: any) => typeof finding?.title === "string" && typeof finding?.body === "string").map((finding: any) => ({ title: finding.title, body: finding.body })) : [] }];
      } catch { return []; }
    })[0];
    return { taskId: task.id, title: task.title, status: task.status, handover: task.handover, ...(saved ?? {}) };
  });
}
