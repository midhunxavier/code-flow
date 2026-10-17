import type { TeamMember, TeamState, TeamTask } from "./types.js";

export function defaultPlanApproval(patternId: string, preference: boolean | undefined): boolean {
  return preference ?? patternId === "auto-team";
}

/** A rebuilt Auto plan needs planning and review; direct replies can use one call. */
export function followupMinimumCalls(autoTeam: boolean, running: boolean, target: string): number {
  return autoTeam && (running || target === "team") ? 4 : 1;
}

export function teamNeedsResume(run: { status: string; team?: Pick<TeamState, "status">; patternDone?: boolean }): boolean {
  return run.status === "stopped" && run.team?.status === "blocked" && run.patternDone !== true;
}

export function automationNeedsAttention(run: { archived?: boolean; trigger?: unknown; triage?: { state: string }; team?: Pick<TeamState, "awaitingRequestId" | "status"> }): boolean {
  return !run.archived && (run.triage?.state === "pending" || !!run.trigger && (!!run.team?.awaitingRequestId || run.team?.status === "blocked"));
}

/** A task can wait on a specific answer, another task, or both. */
export function taskBlockers(team: TeamState, task: TeamTask): string[] {
  const blockers = task.dependsOn.flatMap((id) => {
    const dependency = team.tasks.find((item) => item.id === id);
    const finished = !!dependency && (dependency.status === "completed" || dependency.status === "submitted") && !dependency.evidenceStale;
    const kind = task.dependencyTypes?.[id] ?? "completion";
    const ready = kind === "artifact" ? finished && !!dependency?.head && !!dependency.artifacts?.length : kind === "knowledge" ? !dependency?.evidenceStale && (finished && !!dependency?.artifacts?.length || team.messages.some((message) => message.kind === "reply" && message.sender === dependency?.owner && message.recipient === task.owner && message.taskId === task.id && message.evidence.length > 0 && message.status !== "open")) : finished;
    return ready ? [] : [`Waiting for ${dependency?.title ?? id}${dependency?.evidenceStale ? " to be reverified" : kind === "artifact" ? " artifacts" : kind === "knowledge" ? " knowledge" : ""}`];
  });
  for (const message of team.messages) {
    if (message.kind !== "question" || message.taskId !== task.id || !message.blocking || message.status !== "open") continue;
    const recipient = team.members.find((member) => member.id === message.recipient);
    blockers.push(`Waiting for ${message.recipient === "user" ? "your answer" : recipient?.name ?? message.recipient}: ${message.body}`);
  }
  if (task.error) blockers.push(task.error);
  return blockers;
}

/** Never present assigned work or a submitted result as verified evidence. */
export function requirementProgress(team: TeamState, requirementId: string, runStatus = "done"): "unassigned" | "in_progress" | "awaiting_verification" | "verified" {
  const tasks = team.tasks.filter((task) => task.requirements.includes(requirementId));
  if (!tasks.length) return "unassigned";
  if (!tasks.every((task) => task.status === "completed" && !task.evidenceStale)) return "in_progress";
  const proof = team.verification;
  return runStatus === "done" && team.status === "completed" && proof?.approved && proof.reviewed && (proof.check === "passed" || proof.check === "not_required") && !team.gaps.length ? "verified" : "awaiting_verification";
}

export function memberProgress(team: TeamState, member: TeamMember): string {
  if (member.status === "retired") return "Retired";
  const tasks = team.tasks.filter((task) => task.owner === member.id);
  if (tasks.some((task) => task.status === "running")) return "Working";
  if (tasks.some((task) => task.status === "needs_info")) return "Waiting for information";
  if (tasks.some((task) => task.status === "failed")) return "Needs attention";
  if (tasks.length && tasks.every((task) => task.status === "completed")) return "Finished assignments";
  return member.status ? ({ idle: "Ready", working: "Working", waiting: "Waiting", done: "Done", failed: "Needs attention", retired: "Retired" }[member.status]) : "Ready";
}
