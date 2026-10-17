import type { TeamContext } from "../engine.js";
import { hasConflictMarkers, type Worktree } from "../git.js";
import type { CoordinatorCheckpoint, TeamPlan, TeamState, TeamSubplan, TeamTask } from "../teams.js";

/** Shared decomposition contract; no workflow-generated code or provider assumptions. */
export function decompositionInstructions(maxTasks: number, roster: string): string {
  return `Study the code and split the task into at most ${maxTasks} subtasks that can be built in parallel ` +
    "on separate branches with minimal file overlap (they will be merged afterwards). " +
    "Each subtask's instructions must be self-contained: the worker sees only them and the contracts, not the other subtasks. " +
    "In `contracts`, pin down everything the parts must agree on so they fit together: function signatures, " +
    "endpoints, data shapes, file and module names, who owns which shared file. " +
    `Assign each subtask to one of these workers: ${roster}.`;
}

/** Shared integration primitive retains caller-owned operation titles/identities for old runs. */
export async function integrateBranch(ctx: TeamContext, integration: Worktree, branch: string, resolve: (conflicts: string[]) => Promise<void>, commitMessage: string): Promise<boolean> {
  const merge = await ctx.merge(integration, branch);
  if (merge.ok) return false;
  await resolve(merge.conflicts);
  if (await hasConflictMarkers(integration)) throw new Error(`Conflict markers remain after merging ${branch}`);
  await ctx.commit(integration, commitMessage);
  return true;
}

export const TEAM_STRATEGIES = [
  { id: "investigate-implement", description: "Inspect interfaces and risks, then implement from the recorded investigation artifact." },
  { id: "implement-verify", description: "Implement a scoped change, then collect explicit acceptance evidence on its integrated commit." },
  { id: "bounded-repair", description: "Repair a specific evidence-backed defect within the existing requirements and global repair limit." },
] as const;

/** Expand declarative subplans into visible ordinary tasks; the normal plan validator is authoritative. */
export function expandSubplans(plan: TeamPlan): TeamTask[] {
  const tasks = [...plan.tasks];
  for (const sub of plan.subplans ?? []) {
    if (!/^[a-z][a-z0-9-]{0,27}$/.test(sub.id)) throw new Error("Subplan IDs must be lowercase and at most 28 characters");
    if (!TEAM_STRATEGIES.some((strategy) => strategy.id === sub.strategy)) throw new Error("Unknown reusable team strategy");
    const base = { owner: sub.owner, requirements: [...sub.requirements], paths: [...sub.paths], acceptance: [...sub.acceptance], dependsOn: [...sub.dependsOn], instructions: sub.instructions };
    const make = (suffix: string, kind: TeamTask["kind"], title: string, instructions: string): TeamTask => ({ ...base, id: `${sub.id}-${suffix}`, kind, title, instructions });
    if (sub.strategy === "investigate-implement") {
      const inspect = make("investigate", "investigation", `Investigate ${sub.id}`, `Inspect the relevant source, interfaces, tests and risks. Publish evidence and implementation recommendations.\n${sub.instructions}`);
      const implement = make("implement", "implementation", `Implement ${sub.id}`, sub.instructions);
      implement.dependsOn = [...sub.dependsOn, inspect.id]; implement.dependencyTypes = { [inspect.id]: "knowledge" };
      tasks.push(inspect, implement);
    } else if (sub.strategy === "implement-verify") {
      const implement = make("implement", "implementation", `Implement ${sub.id}`, sub.instructions);
      const verify = make("evidence", "investigation", `Collect acceptance evidence for ${sub.id}`, `Inspect the integrated artifact and publish evidence for every acceptance criterion. This does not replace independent final review.\n${sub.instructions}`);
      verify.dependsOn = [implement.id]; verify.dependencyTypes = { [implement.id]: "artifact" };
      tasks.push(implement, verify);
    } else tasks.push(make("repair", "implementation", `Repair ${sub.id}`, `Repair only the documented defect. Preserve requirements and test integrity.\n${sub.instructions}`));
  }
  return tasks;
}

export function strategyInstances(subplans: TeamSubplan[] | undefined, revision: number): NonNullable<TeamState["strategyInstances"]> {
  return (subplans ?? []).map((sub) => ({ id: sub.id, strategy: sub.strategy, taskIds: expandSubplans({ requirements: [], members: [], contracts: [], rationale: "", tasks: [], subplans: [sub] }).map((t) => t.id), revision }));
}

/** Portable coordinator state excludes private checkpoints, raw transcripts and session handles. */
export function coordinatorCheckpoint(state: TeamState, head: string, remainingInvocations: number, remainingCoordination: number): CoordinatorCheckpoint {
  return {
    revision: state.revision, head, requirements: state.requirements.map((r) => ({ ...r })), contracts: [...state.contracts],
    completed: state.tasks.filter((t) => ["submitted", "completed"].includes(t.status ?? "")).map((t) => ({ id: t.id, head: t.head, artifacts: (t.artifacts ?? []).slice(0, 8) })),
    unfinished: state.tasks.filter((t) => !["submitted", "completed"].includes(t.status ?? "")).map((t) => ({ id: t.id, owner: t.owner, status: t.status ?? "pending", dependencies: [...t.dependsOn], acceptance: [...t.acceptance], handover: t.handover?.slice(0, 2_000), error: t.error?.slice(0, 1_000) })),
    openDecisions: state.messages.filter((m) => m.kind === "question" && m.status === "open").slice(-32).map((m) => ({ id: m.id, from: m.sender, to: m.recipient, body: m.body.slice(0, 2_000) })),
    remainingInvocations, remainingCoordination,
  };
}
