/** Presentation is derived from recorded execution, never from an agent's prose. */
export interface TaskViewInput {
  task: { error?: string; preparation: { active?: string } };
  proposal?: { runId?: string; definition: { scope: string; participants: { id: string; provider: string; model?: string; effort?: string }[] } };
  preparing?: { status: string };
  execution?: {
    id: string; status: string; outcome?: string; paused: boolean; pausePending: boolean;
    waitingForSlot: boolean; recoveryRequired: boolean; error?: string; detail?: string;
    failureKind?: string; questions: unknown[];
    participation: { id: string; provider: string; model?: string; effort?: string; assignments: { id: string; status: string; sessionId?: string; invocations: number; model?: string; effort?: string }[] }[];
  };
}
export function taskView(value: TaskViewInput) {
  const { proposal, execution: run } = value;
  const ready = !!proposal && !proposal.runId;
  const startLabel = proposal?.definition.scope === "write" ? "Start implementation" : proposal?.definition.scope === "review" ? "Start review" : "Start planning";
  const running = run?.status === "running";
  const current = run?.participation.flatMap(p => p.assignments.filter(a => a.status === "running").map(a => `${p.id} is working on ${a.id.replaceAll("-", " ")}`)) ?? [];
  const status = ready ? "approach_ready" : value.task.preparation.active ? "preparing" : run?.recoveryRequired ? "needs_inspection" : run?.questions.length ? "needs_decision" : running ? run.paused ? "paused" : "working" : run?.outcome ?? (run ? "needs_attention" : "preparing");
  const labels: Record<string, string> = { approach_ready: "Approach ready", preparing: "Preparing the approach", needs_inspection: "Inspect preserved work", needs_decision: "Waiting for your decision", paused: run?.pausePending ? "Pausing" : "Paused", working: "Working", plan_ready: "Plan ready", agreed_plan: "Plan agreed", verified_changes: "Changes verified", review_complete: "Review completed", stopped_limit: "Allowance reached", blocked: "Needs attention", needs_attention: "Needs attention" };
  const recovery = run?.recoveryRequired || run?.status === "interrupted" ? "inspect" : run?.failureKind === "auth" || run?.failureKind === "cli_incompatible" ? "reconnect" : run?.outcome === "stopped_limit" ? "allowance" : !running && run && !["agreed_plan", "plan_ready", "verified_changes", "review_complete"].includes(run.outcome ?? "") ? "revise" : undefined;
  return {
    status, label: labels[status] ?? "Work preserved", startLabel,
    stage: ready ? "Review the team, source and allowance before starting." : run?.questions.length ? "Your answer is needed before work can continue." : run?.paused ? "Completed work is preserved." : run?.waitingForSlot ? "Waiting for an execution slot" : current.join(" · ") || labels[status] || "Work preserved",
    canStart: ready, canPause: !!running && !run?.paused, canResume: !!running && !!run?.paused && !run.pausePending,
    recovery, resultLabel: proposal?.definition.scope === "write" ? "View changes" : proposal?.definition.scope === "review" ? "View review" : "View plan",
    participants: (ready ? proposal!.definition.participants : run?.participation ?? []).map(p => {
      const assignments = (p as NonNullable<TaskViewInput["execution"]>["participation"][number]).assignments ?? [];
      return { id: p.id, provider: p.provider, model: p.model, effort: p.effort, assignments,
        participation: assignments.some(a => !!a.sessionId) ? "Native session recorded" : assignments.some(a => a.invocations > 0) ? "Invoked · no native session receipt" : "Not invoked yet" };
    }),
    notice: run?.outcome === "review_complete" ? "Review completed. Reported findings may still need fixes." : run?.outcome === "verified_changes" ? "Checks and required reviews passed for the recorded code snapshot." : run?.outcome === "agreed_plan" ? "Required reviewers approved this version of the plan." : undefined,
  };
}
